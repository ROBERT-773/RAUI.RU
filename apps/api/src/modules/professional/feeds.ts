import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
  seller,
  hash,
} from '../../common/security';
import { Audit } from '../audit/audit';
import { Database, Sql } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

import { feedInput, feedLinkInput, cadence, nextDue } from './contracts';
import { validateFeedUrl } from './feed-fetch';
import { ProfessionalImports, ProfessionalImportsModule } from './imports';
import {
  PersonalFeedController,
  personalFeedService,
} from './personal-feed-controller';
@Injectable()
export class ProfessionalFeeds {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
    private readonly imports: ProfessionalImports,
  ) {}

  async create(
    actor: Actor,
    organizationId: string,
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(feedInput, body);
    if (input.scheduleCron) {
      try {
        cadence(input.scheduleCron);
      } catch {
        throw new BadRequestException('Unsupported schedule cadence');
      }
    }
    if (input.transport.url)
      validateFeedUrl(
        input.transport.url,
        (process.env.FEED_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim()),
      );
    if (
      input.transport.kind === 'https' &&
      (!input.transport.url ||
        new URL(input.transport.url).protocol !== 'https:')
    )
      throw new BadRequestException('HTTPS transport requires an https URL');

    return this.idem.run(
      actor,
      `professional.feed.create:${organization}`,
      key,
      input,
      async (sql) => {
        const [feed] = await this.db.rows<{
          id: string;
          organization_id: string;
          name: string;
          format: string;
          schedule_cron: string | null;
          mapping: unknown;
          transport: unknown;
          active: boolean;
          created_at: string;
        }>(
          `INSERT INTO professional_feed_definitions(
             organization_id,name,format,schedule_cron,mapping,transport,created_by,next_run_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,organization_id,name,format,schedule_cron,mapping,transport,active,created_at`,
          [
            organization,
            input.name,
            input.format,
            input.scheduleCron ?? null,
            JSON.stringify(input.mapping),
            JSON.stringify(input.transport),
            actor.id,
            input.scheduleCron ? nextDue(input.scheduleCron) : new Date(),
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'professional.feed.created',
          'professional_feed',
          feed!.id,
          {
            organizationId: organization,
            name: input.name,
            format: input.format,
          },
        );
        return feed!;
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
  }

  async list(actor: Actor, organizationId: string) {
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization);
    return this.db.rows(
      `SELECT id,organization_id,name,format,schedule_cron,mapping,
              CASE WHEN transport ? 'provider' THEN transport - 'url' ELSE transport END AS transport,
              active,created_at,updated_at
       FROM professional_feed_definitions
       WHERE organization_id=$1
       ORDER BY created_at DESC,id DESC
       LIMIT 200`,
      [organization],
    );
  }

  async dryRun(
    actor: Actor,
    organizationId: string,
    feedId: string,
    body: unknown,
    key: unknown,
  ) {
    return this.imports.apply(
      actor,
      organizationId,
      feedId,
      body,
      key,
      'dry_run',
    );
  }
  async createFromLink(
    actor: Actor,
    organizationId: string | null,
    body: unknown,
    key: unknown,
  ) {
    const input = parse(feedLinkInput, body);
    const scope = organizationId ?? actor.id;
    const { provider } = input;
    return this.idem.run(
      actor,
      `professional.link:${organizationId ? 'org' : 'agent'}:${scope}:${provider}`,
      key,
      input,
      async (sql) => {
        await sql.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [
            `professional.link:${organizationId ?? 'personal:' + actor.id}:${provider}`,
          ],
        );
        const [existing] = await this.db.rows<{
          id: string;
          url: string;
          active: boolean;
        }>(
          `SELECT id,transport->>'url' AS url,active FROM professional_feed_definitions
           WHERE organization_id IS NOT DISTINCT FROM $1::uuid AND ($1::uuid IS NOT NULL OR created_by=$2)
             AND transport->>'linkSlot'='true' AND transport->>'provider'=$3 FOR UPDATE`,
          [organizationId, actor.id, provider],
          sql,
        );
        if (existing && !existing.active)
          throw new ConflictException('Источник отключён.');
        const value = input.url ?? existing?.url;
        if (!value)
          throw new BadRequestException('Вставьте ссылку на XML-выгрузку.');
        const url = validateFeedUrl(
          value,
          (process.env.FEED_ALLOWED_HOSTS ?? '')
            .split(',')
            .map((s) => s.trim()),
        );
        const transport = JSON.stringify({
          kind: 'https',
          url: url.href,
          provider,
          linkSlot: true,
        });
        let id = existing?.id;
        if (!id) {
          const [feed] = await this.db.rows<{ id: string }>(
            `INSERT INTO professional_feed_definitions(organization_id,name,format,transport,created_by)
             VALUES($1,$2,'xml',$3,$4) RETURNING id`,
            [
              organizationId,
              `${input.name ?? 'XML ' + provider} · ${randomUUID()}`,
              transport,
              actor.id,
            ],
            sql,
          );
          id = feed!.id;
        } else if (existing?.url !== url.href) {
          await sql.query(
            'UPDATE professional_feed_definitions SET transport=$2,version=version+1,updated_at=now() WHERE id=$1',
            [id, transport],
          );
        }
        if (!existing || existing.url !== url.href)
          await this.audit.record(
            sql,
            actor.id,
            existing
              ? 'professional.feed.link_changed'
              : 'professional.feed.created',
            'professional_feed',
            id,
            { provider, organizationId },
          );
        const preview = await this.imports.enqueueLinkPreview(
          sql,
          actor,
          organizationId,
          id,
          hash(url.href),
        );
        return {
          feed: { id, provider, host: url.hostname, active: true },
          preview,
        };
      },
      (sql) => this.linkAccess(actor, organizationId, sql),
    );
  }

  private async linkAccess(
    actor: Actor,
    organizationId: string | null,
    sql: Sql,
  ) {
    seller(actor);
    if (organizationId !== null)
      return this.organizations.permission(
        actor,
        parse(uuid, organizationId),
        true,
        sql,
      );
    if (actor.role !== 'agent') throw new ForbiddenException();
  }

  async links(actor: Actor, organizationId: string | null) {
    return this.db.transaction(async (sql) => {
      await this.linkAccess(actor, organizationId, sql);
      const rows = await this.db.rows<{
        id: string;
        provider: string;
        url: string;
        active: boolean;
        lastRunId: string | null;
      }>(
        `SELECT f.id,f.transport->>'provider' AS provider,f.transport->>'url' AS url,f.active,
                (SELECT r.id FROM professional_import_runs r WHERE r.feed_id=f.id AND mode='dry_run'
                 ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS "lastRunId"
         FROM professional_feed_definitions f
         WHERE f.organization_id IS NOT DISTINCT FROM $1::uuid AND ($1::uuid IS NOT NULL OR f.created_by=$2)
           AND f.transport->>'linkSlot'='true' ORDER BY provider`,
        [organizationId, actor.id],
        sql,
      );
      return rows.map(({ url, ...feed }) => ({
        ...feed,
        host: new URL(url).hostname,
      }));
    });
  }
}

@Controller('v1/organizations/:organizationId/feeds')
export class ProfessionalFeedsController {
  constructor(private readonly feeds: ProfessionalFeeds) {}

  @Post()
  create(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.feeds.create(actor, organizationId, body, key);
  }

  @Post('link')
  createFromLink(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.feeds.createFromLink(actor, organizationId, body, key);
  }

  @Get('links')
  links(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
  ) {
    return this.feeds.links(actor, organizationId);
  }

  @Get()
  list(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
  ) {
    return this.feeds.list(actor, organizationId);
  }

  @Post(':feedId/dry-run')
  dryRun(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('feedId') feedId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.feeds.dryRun(actor, organizationId, feedId, body, key);
  }
}

@Module({
  imports: [OrganizationsModule, ProfessionalImportsModule],
  controllers: [ProfessionalFeedsController, PersonalFeedController],
  providers: [
    ProfessionalFeeds,
    Idempotency,
    { provide: personalFeedService, useExisting: ProfessionalFeeds },
  ],
  exports: [ProfessionalFeeds],
})
export class ProfessionalFeedsModule {}
