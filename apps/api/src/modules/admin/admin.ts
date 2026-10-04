import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AdminOnly,
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
  verified,
  seller,
} from '../../common/security';
import { Database } from '../database/database';
import { Audit } from '../audit/audit';
import { Listings, ListingsModule } from '../listings/listings';
import type { Listing } from '../listings/access';
@Injectable()
export class Administration {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly listings: Listings,
    private readonly idem: Idempotency,
  ) {}
  async mediaJobs() {
    return this.db.rows(
      'SELECT id,media_id,state,attempts,available_at,lease_until,last_error FROM media_jobs ORDER BY available_at LIMIT 100',
    );
  }
  async retryMedia(actor: Actor, id: string, key: unknown) {
    verified(actor);
    parse(uuid, id);
    return this.idem.run(actor, `media.retry:${id}`, key, {}, async (sql) => {
      const [job] = await this.db.rows<{ media_id: string }>(
        "UPDATE media_jobs SET state='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1 AND state='dead' RETURNING media_id",
        [id],
        sql,
      );
      if (!job) throw new ConflictException('Dead job required');
      await sql.query("UPDATE media SET state='queued' WHERE id=$1", [
        job.media_id,
      ]);
      await this.audit.record(
        sql,
        actor.id,
        'admin.media.retried',
        'media',
        job.media_id,
      );
      return { ok: true };
    });
  }
  async resources(kind: 'organizations' | 'properties' | 'listings') {
    const queries = {
      organizations:
        'SELECT id,name,kind,active,created_at FROM organizations ORDER BY id LIMIT 100',
      properties:
        'SELECT id,created_by,organization_id,category_code,address_id,version FROM properties ORDER BY id LIMIT 100',
      listings:
        'SELECT id,property_id,source_id,seller_id,organization_id,status,version FROM listings ORDER BY id LIMIT 100',
    };
    return this.db.rows(queries[kind]);
  }
  async users(after?: string) {
    if (after) parse(uuid, after);
    return this.db.rows(
      'SELECT id,email,display_name,role,active,email_verified_at,phone_verified_at,created_at FROM users WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 100',
      [after ?? null],
    );
  }
  async user(actor: Actor, id: string, body: unknown) {
    verified(actor);
    if (id === actor.id)
      throw new ForbiddenException('Cannot change own admin privileges');
    const input = parse(
      z
        .object({
          active: z.boolean().optional(),
          role: z
            .enum(['buyer', 'owner', 'agent', 'agency', 'developer', 'admin'])
            .optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0),
      body,
    );
    return this.db.transaction(async (sql) => {
      const [row] = await this.db.rows<{ id: string }>(
        'UPDATE users SET active=COALESCE($2,active),role=COALESCE($3,role),updated_at=now() WHERE id=$1 RETURNING id',
        [parse(uuid, id), input.active ?? null, input.role ?? null],
        sql,
      );
      if (!row) throw new NotFoundException();
      await sql.query(
        'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [id],
      );
      await this.audit.record(
        sql,
        actor.id,
        'admin.user.changed',
        'user',
        id,
        input,
      );
      return row;
    });
  }
  async organization(actor: Actor, id: string, body: unknown) {
    verified(actor);
    const input = parse(z.object({ active: z.boolean() }).strict(), body);
    return this.db.transaction(async (sql) => {
      const result = await sql.query(
        'UPDATE organizations SET active=$2 WHERE id=$1 RETURNING id',
        [parse(uuid, id), input.active],
      );
      if (!result.rowCount) throw new NotFoundException();
      await this.audit.record(
        sql,
        actor.id,
        'admin.organization.changed',
        'organization',
        id,
        input,
      );
      return { id, active: input.active };
    });
  }
  async auditLog(query: unknown) {
    const input = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        entityId: z.string().max(100).optional(),
      }),
      query,
    );
    return this.db.rows(
      'SELECT * FROM audit_events WHERE id>$1 AND ($2::text IS NULL OR entity_id=$2) ORDER BY id LIMIT 100',
      [input.after, input.entityId ?? null],
    );
  }
  async cases() {
    return this.db.rows(
      "SELECT * FROM moderation_cases WHERE state='pending' ORDER BY created_at LIMIT 100",
    );
  }
  async decision(actor: Actor, id: string, body: unknown, key: unknown) {
    verified(actor);
    parse(uuid, id);
    const input = parse(
      z
        .object({
          decision: z.enum(['approve', 'reject']),
          reason: z.string().trim().min(3).max(2000),
        })
        .strict(),
      body,
    );
    return this.idem.run(actor, `moderation:${id}`, key, input, async (sql) => {
      const [pending] = await this.db.rows<{
        listing_id: string;
        listing_version: number;
        state: string;
      }>('SELECT * FROM moderation_cases WHERE id=$1', [id], sql);
      if (!pending) throw new NotFoundException();
      const [reference] = await this.db.rows<Listing>(
        'SELECT * FROM listings WHERE id=$1',
        [pending.listing_id],
        sql,
      );
      await sql.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE', [
        reference!.property_id,
      ]);
      const [listing] = await this.db.rows<Listing>(
        'SELECT * FROM listings WHERE id=$1 FOR UPDATE',
        [pending.listing_id],
        sql,
      );
      const [current] = await this.db.rows<{ state: string }>(
        'SELECT state FROM moderation_cases WHERE id=$1 FOR UPDATE',
        [id],
        sql,
      );
      if (
        current!.state !== 'pending' ||
        listing!.status !== 'moderation' ||
        listing!.version !== pending.listing_version
      )
        throw new ConflictException('Stale moderation case');
      if (listing!.seller_id === actor.id)
        throw new ForbiddenException('Cannot moderate own listing');
      // Eligibility is checked against the original seller, not reviewer privileges.
      const [sellerActor] = await this.db.rows<Actor>(
        'SELECT id,role,email_verified_at,phone_verified_at FROM users WHERE id=$1 AND active',
        [listing!.seller_id],
        sql,
      );
      if (!sellerActor) throw new ConflictException('Seller inactive');
      if (input.decision === 'approve') {
        seller(sellerActor);
        await this.listings.validate(sql, listing!, sellerActor);
      }
      const status = input.decision === 'approve' ? 'published' : 'rejected';
      await sql.query(
        'UPDATE moderation_cases SET state=$2,reviewer_id=$3,reason=$4,resolved_at=now() WHERE id=$1',
        [
          id,
          input.decision === 'approve' ? 'approved' : 'rejected',
          actor.id,
          input.reason,
        ],
      );
      await sql.query(
        "UPDATE listings SET status=$2,version=version+1,published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1",
        [listing!.id, status],
      );
      await this.audit.history(
        sql,
        actor.id,
        listing!.id,
        'moderation.decided',
        { status: listing!.status },
        { status, caseId: id, reason: input.reason },
      );
      return { listingId: listing!.id, status };
    });
  }
}
@AdminOnly()
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly admin: Administration) {}
  @Get('media-jobs') jobs() {
    return this.admin.mediaJobs();
  }
  @Post('media-jobs/:id/retry') retry(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.admin.retryMedia(actor, id, key);
  }
  @Get('organizations') organizations() {
    return this.admin.resources('organizations');
  }
  @Get('properties') properties() {
    return this.admin.resources('properties');
  }
  @Get('listings') listings() {
    return this.admin.resources('listings');
  }
  @Get('users') users(@Query('after') after?: string) {
    return this.admin.users(after);
  }
  @Patch('users/:id') user(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.user(actor, id, body);
  }
  @Patch('organizations/:id') organization(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.organization(actor, id, body);
  }
  @Get('audit') audit(@Query() query: unknown) {
    return this.admin.auditLog(query);
  }
  @Get('moderation') cases() {
    return this.admin.cases();
  }
  @Post('moderation/:id/decision') decision(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.admin.decision(actor, id, body, key);
  }
}
@Module({
  imports: [ListingsModule],
  controllers: [AdminController],
  providers: [Administration, Idempotency],
})
export class AdminModule {}
