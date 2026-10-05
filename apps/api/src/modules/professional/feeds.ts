import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
} from '../../common/security';
import { Audit } from '../audit/audit';
import { Database } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

const feedInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    format: z.enum(['json', 'csv', 'xml']),
    scheduleCron: z.string().trim().min(5).max(120).optional(),
    mapping: z.record(z.string().max(80), z.string().max(200)).default({}),
    transport: z
      .object({
        kind: z.enum(['manual', 'https']),
        url: z.string().url().optional(),
      })
      .strict(),
  })
  .strict();

const feedItem = z
  .object({
    externalReference: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    price: z.number().positive().max(99_999_999_999_999),
    dealType: z.enum(['sale', 'long_rent', 'short_rent']),
    categoryCode: z.string().trim().min(1).max(80),
    address: z.string().trim().min(3).max(500),
  })
  .strict();

@Injectable()
export class ProfessionalFeeds {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}

  async create(
    actor: Actor,
    organizationId: string,
    body: unknown,
    key: unknown,
  ) {
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(feedInput, body);
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
             organization_id,name,format,schedule_cron,mapping,transport,created_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           RETURNING id,organization_id,name,format,schedule_cron,mapping,transport,active,created_at`,
          [
            organization,
            input.name,
            input.format,
            input.scheduleCron ?? null,
            JSON.stringify(input.mapping),
            JSON.stringify(input.transport),
            actor.id,
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
      `SELECT id,organization_id,name,format,schedule_cron,mapping,transport,active,created_at,updated_at
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
    const organization = parse(uuid, organizationId);
    const feed = parse(uuid, feedId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ items: z.array(z.unknown()).min(1).max(1000) }).strict(),
      body,
    );

    return this.idem.run(
      actor,
      `professional.feed.dry-run:${feed}`,
      key,
      input,
      async (sql) => {
        const [definition] = await this.db.rows<{ id: string }>(
          `SELECT id FROM professional_feed_definitions
           WHERE id=$1 AND organization_id=$2 AND active
           FOR SHARE`,
          [feed, organization],
          sql,
        );
        if (!definition) throw new BadRequestException('Active feed not found');

        const [run] = await this.db.rows<{ id: string }>(
          `INSERT INTO professional_import_runs(
             feed_id,organization_id,requested_by,mode,status
           ) VALUES($1,$2,$3,'dry_run','running')
           RETURNING id`,
          [feed, organization, actor.id],
          sql,
        );

        let valid = 0;
        let invalid = 0;
        const seen = new Set<string>();

        for (const [index, raw] of input.items.entries()) {
          const result = feedItem.safeParse(raw);
          let externalReference =
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as { externalReference?: unknown }).externalReference ===
              'string'
              ? (raw as { externalReference: string }).externalReference.trim()
              : `invalid:${index + 1}`;
          if (!externalReference) externalReference = `invalid:${index + 1}`;

          const errors = result.success
            ? []
            : result.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              }));

          if (seen.has(externalReference))
            errors.push({
              path: 'externalReference',
              message: 'Duplicate external reference in import',
            });
          seen.add(externalReference);

          const status = errors.length ? 'invalid' : 'valid';
          if (status === 'valid') valid++;
          else invalid++;

          await sql.query(
            `INSERT INTO professional_import_items(
               run_id,external_reference,status,payload,errors
             ) VALUES($1,$2,$3,$4,$5)`,
            [
              run!.id,
              externalReference.slice(0, 200),
              status,
              JSON.stringify(raw),
              JSON.stringify(errors),
            ],
          );
        }

        const stats = { total: input.items.length, valid, invalid };
        await sql.query(
          `UPDATE professional_import_runs
           SET status='succeeded',stats=$2,finished_at=now()
           WHERE id=$1`,
          [run!.id, JSON.stringify(stats)],
        );
        await this.audit.record(
          sql,
          actor.id,
          'professional.feed.dry_run',
          'professional_import_run',
          run!.id,
          { organizationId: organization, feedId: feed, ...stats },
        );
        return { runId: run!.id, ...stats };
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
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
  imports: [OrganizationsModule],
  controllers: [ProfessionalFeedsController],
  providers: [ProfessionalFeeds, Idempotency],
  exports: [ProfessionalFeeds],
})
export class ProfessionalFeedsModule {}
