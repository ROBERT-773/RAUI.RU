import { RegistrationApprovals } from './registration-approval';
import { Trust, TrustModule } from '../trust/trust';
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
  Res,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { ObjectStorage, StorageModule } from '../media/storage';
import {
  AdminOnly,
  StaffPermissionOnly,
  staffPermissions,
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
  verified,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { Listings, ListingsModule } from '../listings/listings';
import type { Listing } from '../listings/access';
import {
  PublicationQuotaModule,
  PublicationQuotas,
} from '../listings/publication-quota';
@Injectable()
export class Administration {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly listings: Listings,
    private readonly idem: Idempotency,
    private readonly trust: Trust,
    private readonly storage: ObjectStorage,
    private readonly quotas: PublicationQuotas,
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
  async permissions(id: string) {
    const [user] = await this.db.rows('SELECT id FROM users WHERE id=$1', [
      parse(uuid, id),
    ]);
    if (!user) throw new NotFoundException();
    const grants = await this.db.rows<{ permission: string }>(
      'SELECT permission FROM staff_permission_grants WHERE user_id=$1 ORDER BY permission',
      [id],
    );
    return { userId: id, permissions: grants.map((grant) => grant.permission) };
  }
  async permission(actor: Actor, id: string, body: unknown) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    parse(uuid, id);
    if (id === actor.id)
      throw new ForbiddenException('Cannot change own admin privileges');
    const input = parse(
      z
        .object({
          permission: z.enum(staffPermissions),
          granted: z.boolean(),
          reason: z.string().trim().min(3).max(2000),
        })
        .strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      const [user] = await this.db.rows(
        'SELECT id FROM users WHERE id=$1 FOR UPDATE',
        [id],
        sql,
      );
      if (!user) throw new NotFoundException();
      if (input.granted)
        await sql.query(
          'INSERT INTO staff_permission_grants(user_id,permission,granted_by) VALUES($1,$2,$3) ON CONFLICT(user_id,permission) DO NOTHING',
          [id, input.permission, actor.id],
        );
      else
        await sql.query(
          'DELETE FROM staff_permission_grants WHERE user_id=$1 AND permission=$2',
          [id, input.permission],
        );
      await this.audit.record(
        sql,
        actor.id,
        'admin.staff.permission.changed',
        'user',
        id,
        input,
      );
      return {
        userId: id,
        permission: input.permission,
        granted: input.granted,
      };
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
  async materials(id: string) {
    const [row] = await this.db.rows(
      `SELECT c.id AS "caseId",c.listing_version AS "listingVersion",
        jsonb_build_object('id',l.id,'title',l.title,'description',l.description,'price',l.price,'deal_type',l.deal_type,'version',l.version) AS listing,
        jsonb_build_object('id',p.id,'category_code',p.category_code,'attributes',p.attributes,'address',a.formatted) AS property,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'kind',m.kind,'state',m.state) ORDER BY m.id) FROM media m WHERE m.listing_id=l.id),'[]'::jsonb) AS media
       FROM moderation_cases c JOIN listings l ON l.id=c.listing_id
       JOIN properties p ON p.id=l.property_id JOIN addresses a ON a.id=p.address_id
       WHERE c.id=$1 AND c.state='pending' AND l.status='moderation' AND c.listing_version=l.version`,
      [parse(uuid, id)],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
  async materialImage(
    caseId: string,
    mediaId: string,
    variant: string,
    res: Response,
  ) {
    const [row] = await this.db.rows<{
      variants: Record<string, { key: string; mime: string }>;
    }>(
      `SELECT m.variants FROM moderation_cases c JOIN listings l ON l.id=c.listing_id
       JOIN media m ON m.listing_id=l.id WHERE c.id=$1 AND m.id=$2
       AND c.state='pending' AND l.status='moderation' AND c.listing_version=l.version AND m.state='ready'`,
      [parse(uuid, caseId), parse(uuid, mediaId)],
    );
    const image =
      row?.variants[
        parse(z.enum(['thumb', 'small', 'large', 'avif']), variant)
      ];
    if (!image) throw new NotFoundException();
    res.setHeader('Content-Type', image.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(image.key));
  }
  private async authorizeDecision(
    sql: Sql,
    actor: Actor,
    caseId: string,
    approving: boolean,
  ) {
    // Lock hints only: the mutation still validates the current listing references.
    const [reference] = approving
      ? await this.db.rows<{ seller_id: string }>(
          'SELECT l.seller_id FROM moderation_cases c JOIN listings l ON l.id=c.listing_id WHERE c.id=$1',
          [caseId],
          sql,
        )
      : [];
    // Both reviewers and sellers may be staff. Use one deterministic order and
    // preserve FK KEY SHARE compatibility for audit/history/idempotency inserts.
    const userIds = [
      ...new Set([actor.id, ...(reference ? [reference.seller_id] : [])]),
    ].sort();
    const users = await this.db.rows<Actor & { active: boolean }>(
      'SELECT id,role,active,email_verified_at,phone_verified_at,registration_approval_state FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
      [userIds],
      sql,
    );
    const current = users.find((user) => user.id === actor.id);
    if (!current?.active || current.registration_approval_state !== 'approved')
      throw new ForbiddenException('Staff access unavailable');
    verified(current);
    const [session] = await this.db.rows(
      'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [actor.session_id, actor.id],
      sql,
    );
    if (!session) throw new ForbiddenException('Staff session unavailable');
    if (current.role !== 'admin') {
      const [grant] = await this.db.rows(
        "SELECT user_id FROM staff_permission_grants WHERE user_id=$1 AND permission='moderation.decide' FOR UPDATE",
        [actor.id],
        sql,
      );
      if (!grant) throw new ForbiddenException('Staff permission required');
    }
    // Evaluate wall time only after all authorization locks have been acquired.
    const [validSession] = await this.db.rows(
      'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
      [actor.session_id, actor.id],
      sql,
    );
    if (!validSession)
      throw new ForbiddenException('Staff session unavailable');
    return reference?.seller_id;
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
    let authorizedSellerId: string | undefined;
    return this.idem.run(
      actor,
      `moderation:${id}`,
      key,
      input,
      async (sql) => {
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
        if (
          !reference ||
          (input.decision === 'approve' &&
            reference.seller_id !== authorizedSellerId)
        )
          throw new ConflictException('Stale moderation case');
        const publicationSeller =
          input.decision === 'approve'
            ? await this.quotas.lockSeller(sql, reference.seller_id)
            : undefined;
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
          !current ||
          !listing ||
          listing.seller_id !== reference.seller_id ||
          listing.property_id !== reference.property_id ||
          current!.state !== 'pending' ||
          listing!.status !== 'moderation' ||
          listing!.version !== pending.listing_version
        )
          throw new ConflictException('Stale moderation case');
        if (listing!.seller_id === actor.id)
          throw new ForbiddenException('Cannot moderate own listing');
        // Eligibility is checked against the original seller, not reviewer privileges.
        if (input.decision === 'approve') {
          const sellerActor: Actor = { ...publicationSeller!, session_id: '' };
          await this.listings.validate(sql, listing!, sellerActor);
          await this.trust.checkPublication(sql, listing!.id);
          await this.quotas.assertCapacity(
            sql,
            publicationSeller!,
            listing!.property_id,
          );
        } else {
          const [sellerActor] = await this.db.rows<Actor>(
            'SELECT id,role,email_verified_at,phone_verified_at,registration_approval_state FROM users WHERE id=$1 AND active',
            [listing!.seller_id],
            sql,
          );
          if (!sellerActor) throw new ConflictException('Seller inactive');
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
      },
      async (sql) => {
        authorizedSellerId = await this.authorizeDecision(
          sql,
          actor,
          id,
          input.decision === 'approve',
        );
      },
    );
  }
}
@AdminOnly()
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly admin: Administration,
    private readonly registrations: RegistrationApprovals,
  ) {}
  @StaffPermissionOnly('registration.read')
  @Get('registration-approvals')
  registrationQueue(@Query('after') after?: string) {
    return this.registrations.queue(after);
  }
  @StaffPermissionOnly('registration.read')
  @Get('registration-approvals/:id')
  registrationDetail(@Param('id') id: string) {
    return this.registrations.detail(id);
  }
  @StaffPermissionOnly('registration.decide')
  @Post('registration-approvals/:id/decision')
  registrationDecision(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.registrations.decision(actor, id, body, key);
  }
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
  @Get('users/:id/permissions') permissions(@Param('id') id: string) {
    return this.admin.permissions(id);
  }
  @Patch('users/:id/permissions') permission(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.permission(actor, id, body);
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
  @StaffPermissionOnly('moderation.read')
  @Get('moderation')
  cases() {
    return this.admin.cases();
  }
  @StaffPermissionOnly('moderation.read')
  @Get('moderation/:id/materials')
  materials(@Param('id') id: string) {
    return this.admin.materials(id);
  }
  @StaffPermissionOnly('moderation.read')
  @Get('moderation/:id/media/:mediaId/:variant')
  materialImage(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Param('variant') variant: string,
    @Res() res: Response,
  ) {
    return this.admin.materialImage(id, mediaId, variant, res);
  }
  @StaffPermissionOnly('moderation.decide')
  @Post('moderation/:id/decision')
  decision(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.admin.decision(actor, id, body, key);
  }
}
@Module({
  imports: [ListingsModule, TrustModule, StorageModule, PublicationQuotaModule],
  controllers: [AdminController],
  providers: [Administration, RegistrationApprovals, Idempotency],
})
export class AdminModule {}
