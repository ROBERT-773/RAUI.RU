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
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
  seller,
} from '../../common/security';
import { Audit } from '../audit/audit';
import { Database } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

import { feedInput, cadence, nextDue } from './contracts';
import { validateFeedUrl } from './feed-fetch';
import { ProfessionalImports, ProfessionalImportsModule } from './imports';
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
    return this.imports.apply(
      actor,
      organizationId,
      feedId,
      body,
      key,
      'dry_run',
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
  imports: [OrganizationsModule, ProfessionalImportsModule],
  controllers: [ProfessionalFeedsController],
  providers: [ProfessionalFeeds, Idempotency],
  exports: [ProfessionalFeeds],
})
export class ProfessionalFeedsModule {}
