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
  HttpException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  Idempotency,
  AdminOnly,
  seller,
  verified,
  CurrentActor,
  hash,
  parse,
  Public,
  token,
  uuid,
} from '../../common/security';
import { Audit, AuditModule } from '../audit/audit';
import { ProfessionalImports, ProfessionalImportsModule } from './imports';
import { Structures, StructuresModule } from '../properties/structures';
import { Database } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

export const scope = z.enum(['listings:read', 'listings:write', 'feeds:write']);

@Injectable()
export class ProfessionalPlatform {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}

  async createPortfolio(
    actor: Actor,
    organizationId: string,
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ name: z.string().trim().min(2).max(120) }).strict(),
      body,
    );
    return this.idem.run(
      actor,
      `professional.portfolio.create:${organization}`,
      key,
      input,
      async (sql) => {
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
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
  }

  async addPortfolioListings(
    actor: Actor,
    organizationId: string,
    portfolioId: string,
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const organization = parse(uuid, organizationId);
    const portfolio = parse(uuid, portfolioId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ listingIds: z.array(uuid).min(1).max(200) }).strict(),
      body,
    );
    return this.idem.run(
      actor,
      `professional.portfolio.add:${organization}`,
      key,
      input,
      async (sql) => {
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
          throw new ForbiddenException(
            'All listings must belong to the organization',
          );

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
        return {
          portfolioId: portfolio,
          added: new Set(input.listingIds).size,
        };
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
  }

  async bulkPause(
    actor: Actor,
    organizationId: string,
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ listingIds: z.array(uuid).min(1).max(200) }).strict(),
      body,
    );
    return this.idem.run(
      actor,
      `professional.bulk.pause:${organization}`,
      key,
      input,
      async (sql) => {
        await this.organizations.permission(actor, organization, true, sql);
        const rows = await this.db.rows<{ id: string; status: string }>(
          `SELECT id,status FROM listings
         WHERE id=ANY($1::uuid[]) AND organization_id=$2
         ORDER BY id FOR UPDATE`,
          [input.listingIds, organization],
          sql,
        );
        if (rows.length !== new Set(input.listingIds).size)
          throw new ForbiddenException(
            'All listings must belong to the organization',
          );
        if (rows.some((row) => row.status !== 'published'))
          throw new BadRequestException(
            'Bulk pause requires published listings',
          );
        await sql.query(
          `UPDATE listings
         SET status='paused',version=version+1,updated_at=now()
         WHERE id=ANY($1::uuid[])`,
          [[...new Set(input.listingIds)]],
        );
        for (const row of rows) {
          await this.audit.history(
            sql,
            actor.id,
            row.id,
            'listing.status.changed',
            { status: row.status },
            { status: 'paused' },
          );
          await this.audit.record(
            sql,
            actor.id,
            'professional.listing.bulk_paused',
            'listing',
            row.id,
            { organizationId: organization },
          );
        }
        return { paused: rows.length };
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
  }

  async createPartnerClient(
    actor: Actor,
    organizationId: string,
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const organization = parse(uuid, organizationId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z
        .object({
          name: z.string().trim().min(2).max(120),
          scopes: z.array(scope).min(1).max(10),
          expiresAt: z.iso.datetime().optional(),
          requestsPerMinute: z.number().int().min(1).max(1000).default(60),
        })
        .strict(),
      body,
    );
    if (
      input.expiresAt &&
      (Date.parse(input.expiresAt) <= Date.now() ||
        Date.parse(input.expiresAt) > Date.now() + 366 * 86400000)
    )
      throw new BadRequestException('Key expiry must be within one year');
    let secret: string | undefined;
    const clientResult = await this.idem.run(
      actor,
      `professional.partner.create:${organization}`,
      key,
      input,
      async (sql) => {
        secret = token();
        await this.organizations.permission(actor, organization, true, sql);
        const [client] = await this.db.rows<{ id: string }>(
          `INSERT INTO partner_clients(
           organization_id,name,token_digest,scopes,requests_per_minute,created_by,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            organization,
            input.name,
            hash(secret),
            input.scopes,
            input.requestsPerMinute,
            actor.id,
            input.expiresAt ??
              new Date(Date.now() + 90 * 86400000).toISOString(),
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
        return { id: client!.id };
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
    return { ...clientResult, token: secret ?? null };
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
        created_by: string;
      }>(
        `SELECT k.id,k.organization_id,k.scopes,k.requests_per_minute,k.created_by FROM partner_clients k JOIN organizations o ON o.id=k.organization_id JOIN memberships m ON m.organization_id=k.organization_id AND m.user_id=k.created_by JOIN users u ON u.id=k.created_by WHERE k.token_digest=$1 AND k.active AND (k.expires_at IS NULL OR k.expires_at>now()) AND o.active AND m.active AND m.role IN ('owner','admin') AND u.active AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL FOR UPDATE OF k FOR SHARE OF o,m`,
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
        throw new HttpException('Partner rate limit exceeded', 429);
      await sql.query(
        'UPDATE partner_clients SET last_used_at=now() WHERE id=$1',
        [client.id],
      );
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

  async portfolios(actor: Actor, org: string) {
    await this.organizations.permission(actor, parse(uuid, org));
    return this.db.rows(
      'SELECT id,name,created_at FROM professional_portfolios WHERE organization_id=$1 ORDER BY id LIMIT 100',
      [org],
    );
  }
  async portfolioListings(actor: Actor, org: string, id: string) {
    await this.organizations.permission(actor, parse(uuid, org));
    return this.db.rows(
      'SELECT l.id,l.property_id,l.title,l.price,l.status,l.version FROM professional_portfolio_listings pl JOIN professional_portfolios p ON p.id=pl.portfolio_id JOIN listings l ON l.id=pl.listing_id WHERE p.id=$1 AND p.organization_id=$2 AND l.organization_id=$2 ORDER BY l.id LIMIT 200',
      [parse(uuid, id), org],
    );
  }
  async clients(actor: Actor, org: string) {
    await this.organizations.permission(actor, parse(uuid, org), true);
    return this.db.rows(
      'SELECT id,name,scopes,requests_per_minute,active,expires_at,last_used_at FROM partner_clients WHERE organization_id=$1 ORDER BY id LIMIT 100',
      [org],
    );
  }
  async revoke(actor: Actor, id: string, admin = false) {
    seller(actor);
    return this.db.transaction(async (sql) => {
      const [row] = await this.db.rows<{
        organization_id: string;
        active: boolean;
      }>(
        'SELECT organization_id,active FROM partner_clients WHERE id=$1 FOR UPDATE',
        [parse(uuid, id)],
        sql,
      );
      if (!row) throw new BadRequestException('Partner client not found');
      if (admin) {
        verified(actor);
        if (actor.role !== 'admin') throw new ForbiddenException();
      } else
        await this.organizations.permission(
          actor,
          row.organization_id,
          true,
          sql,
        );
      if (row.active) {
        await sql.query('UPDATE partner_clients SET active=false WHERE id=$1', [
          id,
        ]);
        await this.audit.record(
          sql,
          actor.id,
          'partner.client.revoked',
          'partner_client',
          id,
          { admin },
        );
      }
      return { ok: true };
    });
  }
  async partnerActor(client: { created_by: string }): Promise<Actor> {
    const [actor] = await this.db.rows<Actor>(
      "SELECT id,role,email_verified_at,phone_verified_at,'partner' AS session_id FROM users WHERE id=$1 AND active",
      [client.created_by],
    );
    if (!actor) throw new ForbiddenException();
    seller(actor);
    return actor;
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
  async adminClients(actor: Actor) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    return this.db.rows(
      'SELECT id,organization_id,name,scopes,active,expires_at,last_used_at FROM partner_clients ORDER BY id LIMIT 100',
    );
  }
}

@Controller('v1/organizations/:organizationId/professional')
export class ProfessionalController {
  constructor(
    private readonly platform: ProfessionalPlatform,
    private readonly structures: Structures,
  ) {}

  @Get('hierarchy') hierarchy(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
  ) {
    return this.structures.hierarchy(a, parse(uuid, o));
  }
  @Get('portfolios') portfolios(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
  ) {
    return this.platform.portfolios(a, o);
  }
  @Get('portfolios/:portfolioId/listings') readPortfolio(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('portfolioId') id: string,
  ) {
    return this.platform.portfolioListings(a, o, id);
  }
  @Get('partner-clients') clients(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
  ) {
    return this.platform.clients(a, o);
  }
  @Post('partner-clients/:id/revoke') async revoke(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('id') id: string,
  ) {
    const clients = await this.platform.clients(a, o);
    if (!clients.some((c) => c.id === id)) throw new ForbiddenException();
    return this.platform.revoke(a, id);
  }
  @Post('portfolios')
  portfolio(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.platform.createPortfolio(actor, organizationId, body, key);
  }

  @Post('portfolios/:portfolioId/listings')
  portfolioListings(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('portfolioId') portfolioId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.platform.addPortfolioListings(
      actor,
      organizationId,
      portfolioId,
      body,
      key,
    );
  }

  @Post('listings/bulk-pause')
  bulkPause(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.platform.bulkPause(actor, organizationId, body, key);
  }

  @Post('partner-clients')
  partnerClient(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.platform.createPartnerClient(actor, organizationId, body, key);
  }
}

@Controller('v1/partner')
export class PartnerController {
  constructor(
    private readonly platform: ProfessionalPlatform,
    private readonly imports: ProfessionalImports,
  ) {}

  @Public()
  @Get('listings')
  listings(@Headers('x-partner-token') partnerToken: unknown) {
    return this.platform.partnerListings(partnerToken);
  }
  @Public() @Post('feeds/:id/apply') async apply(
    @Headers('x-partner-token') raw: unknown,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k: unknown,
  ) {
    const client = await this.platform.partner(raw, 'feeds:write');
    return this.imports.apply(
      await this.platform.partnerActor(client),
      client.organization_id,
      id,
      b,
      k,
    );
  }
  @Public() @Post('listings/bulk-pause') async bulk(
    @Headers('x-partner-token') raw: unknown,
    @Body() b: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const client = await this.platform.partner(raw, 'listings:write');
    return this.platform.bulkPause(
      await this.platform.partnerActor(client),
      client.organization_id,
      b,
      key,
    );
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

@Controller('v1/admin/integrations/partners')
@AdminOnly()
export class PartnerAdminController {
  constructor(private readonly platform: ProfessionalPlatform) {}
  @Get() list(@CurrentActor() a: Actor) {
    return this.platform.adminClients(a);
  }
  @Post(':id/revoke') revoke(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
  ) {
    return this.platform.revoke(a, id, true);
  }
}
@Module({
  imports: [
    OrganizationsModule,
    ProfessionalImportsModule,
    StructuresModule,
    AuditModule,
  ],
  controllers: [
    ProfessionalController,
    PartnerAdminController,
    PartnerController,
    NotificationPreferencesController,
  ],
  providers: [ProfessionalPlatform, Idempotency],
  exports: [ProfessionalPlatform],
})
export class ProfessionalPlatformModule {}
