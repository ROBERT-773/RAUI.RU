import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Public,
  TooManyRequestsException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  hash,
  parse,
  token,
  uuid,
} from '../../common/security';
import { Audit } from '../audit/audit';
import { Database } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

const scope = z.enum(['listings:read', 'listings:write', 'feeds:write']);

@Injectable()
export class ProfessionalPlatform {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
  ) {}

  async createPortfolio(actor: Actor, organizationId: string, body: unknown) {
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ name: z.string().trim().min(2).max(120) }).strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      await this.organizations.permission(actor, organization, true, sql);
      const [row] = await this.db.rows<{ id: string; name: string }>(
        `INSERT INTO professional_portfolios(organization_id,name,created_by)
         VALUES($1,$2,$3) RETURNING id,name`,
        [organization, input.name, actor.id],
        sql,
      );
      await this.audit.record(
        sql,
        actor.id,
        'professional.portfolio.created',
        'professional_portfolio',
        row!.id,
        { organizationId: organization, name: input.name },
      );
      return row!;
    });
  }

  async addPortfolioListings(
    actor: Actor,
    organizationId: string,
    portfolioId: string,
    body: unknown,
  ) {
    const organization = parse(uuid, organizationId);
    const portfolio = parse(uuid, portfolioId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ listingIds: z.array(uuid).min(1).max(200) }).strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      await this.organizations.permission(actor, organization, true, sql);
      const [owned] = await this.db.rows<{ id: string }>(
        'SELECT id FROM professional_portfolios WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [portfolio, organization],
        sql,
      );
      if (!owned) throw new BadRequestException('Portfolio not found');

      const rows = await this.db.rows<{ id: string }>(
        'SELECT id FROM listings WHERE id=ANY($1::uuid[]) AND organization_id=$2',
        [input.listingIds, organization],
        sql,
      );
      if (rows.length !== new Set(input.listingIds).size)
        throw new ForbiddenException('All listings must belong to the organization');

      for (const id of new Set(input.listingIds))
        await sql.query(
          `INSERT INTO professional_portfolio_listings(portfolio_id,listing_id,added_by)
           VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [portfolio, id, actor.id],
        );

      await this.audit.record(
        sql,
        actor.id,
        'professional.portfolio.listings_added',
        'professional_portfolio',
        portfolio,
        { listingIds: [...new Set(input.listingIds)] },
      );
      return { portfolioId: portfolio, added: new Set(input.listingIds).size };
    });
  }

  async bulkPause(actor: Actor, organizationId: string, body: unknown) {
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ listingIds: z.array(uuid).min(1).max(200) }).strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      await this.organizations.permission(actor, organization, true, sql);
      const rows = await this.db.rows<{ id: string; status: string }>(
        `SELECT id,status FROM listings
         WHERE id=ANY($1::uuid[]) AND organization_id=$2
         ORDER BY id FOR UPDATE`,
        [input.listingIds, organization],
        sql,
      );
      if (rows.length !== new Set(input.listingIds).size)
        throw new ForbiddenException('All listings must belong to the organization');
      if (rows.some((row) => row.status !== 'published'))
        throw new BadRequestException('Bulk pause requires published listings');
      await sql.query(
        `UPDATE listings
         SET status='paused',version=version+1,updated_at=now()
         WHERE id=ANY($1::uuid[])`,
        [[...new Set(input.listingIds)]],
      );
      for (const row of rows)
        await this.audit.record(
          sql,
          actor.id,
          'professional.listing.bulk_paused',
          'listing',
          row.id,
          { organizationId: organization },
        );
      return { paused: rows.length };
    });
  }

  async createPartnerClient(
    actor: Actor,
    organizationId: string,
    body: unknown,
  ) {
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z
        .object({
          name: z.string().trim().min(2).max(120),
          scopes: z.array(scope).min(1).max(10),
          requestsPerMinute: z.number().int().min(1).max(1000).default(60),
        })
        .strict(),
      body,
    );
    const secret = token();
    return this.db.transaction(async (sql) => {
      await this.organizations.permission(actor, organization, true, sql);
      const [client] = await this.db.rows<{ id: string }>(
        `INSERT INTO partner_clients(
           organization_id,name,token_digest,scopes,requests_per_minute,created_by
         ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          organization,
          input.name,
          hash(secret),
          input.scopes,
          input.requestsPerMinute,
          actor.id,
        ],
        sql,
      );
      await this.audit.record(
        sql,
        actor.id,
        'partner.client.created',
        'partner_client',
        client!.id,
        {
          organizationId: organization,
          name: input.name,
          scopes: input.scopes,
          requestsPerMinute: input.requestsPerMinute,
        },
      );
      return { id: client!.id, token: secret };
    });
  }

  async partner(raw: unknown, requiredScope: z.infer<typeof scope>) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw new ForbiddenException('Partner token required');
    return this.db.transaction(async (sql) => {
      const [client] = await this.db.rows<{
        id: string;
        organization_id: string;
        scopes: string[];
        requests_per_minute: number;
      }>(
        `SELECT id,organization_id,scopes,requests_per_minute
         FROM partner_clients
         WHERE token_digest=$1 AND active
         FOR UPDATE`,
        [hash(raw)],
        sql,
      );
      if (!client || !client.scopes.includes(requiredScope))
        throw new ForbiddenException('Partner scope required');
      const [usage] = await this.db.rows<{ count: number }>(
        `INSERT INTO partner_client_usage(client_id,count,reset_at)
         VALUES($1,1,now()+interval '1 minute')
         ON CONFLICT(client_id) DO UPDATE SET
           count=CASE WHEN partner_client_usage.reset_at<now() THEN 1 ELSE partner_client_usage.count+1 END,
           reset_at=CASE WHEN partner_client_usage.reset_at<now() THEN now()+interval '1 minute' ELSE partner_client_usage.reset_at END
         RETURNING count`,
        [client.id],
        sql,
      );
      if (usage!.count > client.requests_per_minute)
        throw new TooManyRequestsException('Partner rate limit exceeded');
      await sql.query('UPDATE partner_clients SET last_used_at=now() WHERE id=$1', [
        client.id,
      ]);
      return client;
    });
  }

  async partnerListings(raw: unknown) {
    const client = await this.partner(raw, 'listings:read');
    return this.db.rows(
      `SELECT id,property_id,deal_type,title,price,status,updated_at
       FROM listings
       WHERE organization_id=$1
       ORDER BY updated_at DESC,id DESC
       LIMIT 200`,
      [client.organization_id],
    );
  }

  async preferences(actor: Actor) {
    const [row] = await this.db.rows(
      `INSERT INTO notification_preferences(user_id) VALUES($1)
       ON CONFLICT(user_id) DO UPDATE SET user_id=EXCLUDED.user_id
       RETURNING user_id,email,push,transactional,updated_at`,
      [actor.id],
    );
    return row;
  }

  async setPreferences(actor: Actor, body: unknown) {
    const input = parse(
      z
        .object({
          email: z.boolean(),
          push: z.boolean(),
          transactional: z.boolean(),
        })
        .strict(),
      body,
    );
    const [row] = await this.db.rows(
      `INSERT INTO notification_preferences(user_id,email,push,transactional,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(user_id) DO UPDATE SET
         email=$2,push=$3,transactional=$4,updated_at=now()
       RETURNING user_id,email,push,transactional,updated_at`,
      [actor.id, input.email, input.push, input.transactional],
    );
    return row;
  }
}

@Controller('v1/organizations/:organizationId/professional')
export class ProfessionalController {
  constructor(private readonly platform: ProfessionalPlatform) {}

  @Post('portfolios')
  portfolio(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ) {
    return this.platform.createPortfolio(actor, organizationId, body);
  }

  @Post('portfolios/:portfolioId/listings')
  portfolioListings(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('portfolioId') portfolioId: string,
    @Body() body: unknown,
  ) {
    return this.platform.addPortfolioListings(
      actor,
      organizationId,
      portfolioId,
      body,
    );
  }

  @Post('listings/bulk-pause')
  bulkPause(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ) {
    return this.platform.bulkPause(actor, organizationId, body);
  }

  @Post('partner-clients')
  partnerClient(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ) {
    return this.platform.createPartnerClient(actor, organizationId, body);
  }
}

@Controller('v1/partner')
export class PartnerController {
  constructor(private readonly platform: ProfessionalPlatform) {}

  @Public()
  @Get('listings')
  listings(@Headers('x-partner-token') partnerToken: unknown) {
    return this.platform.partnerListings(partnerToken);
  }
}

@Controller('v1/notifications')
export class NotificationPreferencesController {
  constructor(private readonly platform: ProfessionalPlatform) {}

  @Get('preferences')
  get(@CurrentActor() actor: Actor) {
    return this.platform.preferences(actor);
  }

  @Patch('preferences')
  set(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.platform.setPreferences(actor, body);
  }
}

@Module({
  imports: [OrganizationsModule],
  controllers: [
    ProfessionalController,
    PartnerController,
    NotificationPreferencesController,
  ],
  providers: [ProfessionalPlatform],
  exports: [ProfessionalPlatform],
})
export class ProfessionalPlatformModule {}
