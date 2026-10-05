import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
  Get,
  Query,
  Patch,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Actor,
  CurrentActor,
  Idempotency,
  AdminOnly,
  parse,
  uuid,
  seller,
  verified,
  hash,
} from '../../common/security';
import { Audit, AuditModule } from '../audit/audit';
import { Database, Sql } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { Catalog, CatalogModule, validateAttributes } from '../catalog/catalog';
import { Properties, PropertiesModule } from '../properties/properties';
import {
  importItem,
  importInput,
  feedConfig,
  cadence,
  nextDue,
  normalizedFingerprint,
} from './contracts';
import { FeedFetcher, HttpsFeedFetcher } from './feed-fetch';
import { parseFeed } from './feed-parser';
interface Feed {
  id: string;
  organization_id: string;
  created_by: string;
  active: boolean;
  schedule_cron: string | null;
  format: string;
  transport: { kind: string; url?: string };
  mapping: Record<string, string>;
}
interface Job {
  run_id: string;
  feed_id: string;
  organization_id: string;
  requested_by: string;
  mode: 'apply' | 'dry_run';
  payload: unknown[] | null;
  lease_token: string;
  attempts: number;
}
interface RecordRow {
  listing_id: string;
  property_id: string;
  source_id: string;
  fingerprint: string | null;
}
const pages = z
  .object({
    after: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
@Injectable()
export class ProfessionalImports {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
    private readonly catalog: Catalog,
    private readonly properties: Properties,
    private readonly fetcher: FeedFetcher,
  ) {}
  async permission(
    actor: Actor,
    organization: string,
    feedId: string,
    manage = false,
    sql: Sql = this.db.pool,
    admin = false,
  ) {
    if (admin) {
      verified(actor);
      if (actor.role !== 'admin') throw new ForbiddenException();
    } else
      await this.organizations.permission(
        actor,
        parse(uuid, organization),
        manage,
        sql,
      );
    const [feed] = await this.db.rows<Feed>(
      'SELECT * FROM professional_feed_definitions WHERE id=$1 AND organization_id=$2',
      [parse(uuid, feedId), organization],
      sql,
    );
    if (!feed) throw new NotFoundException();
    return feed;
  }
  async apply(
    actor: Actor,
    organizationId: string,
    feedId: string,
    body: unknown,
    key: unknown,
    mode: 'apply' | 'dry_run' = 'apply',
  ) {
    const input = parse(importInput, body);
    seller(actor);
    if (Buffer.byteLength(JSON.stringify(input)) > 2_000_000)
      throw new BadRequestException('Import exceeds 2 MB');
    return this.idem.run(
      actor,
      `professional.feed.${mode}:${feedId}`,
      key,
      input,
      async (sql) => {
        const feed = await this.permission(
          actor,
          organizationId,
          feedId,
          true,
          sql,
        );
        if (!feed.active) throw new ConflictException('Feed disabled');
        const [run] = await this.db.rows<{ id: string }>(
          'INSERT INTO professional_import_runs(feed_id,organization_id,requested_by,mode,status,stats) VALUES($1,$2,$3,$4,\'running\',\'{"stage":"queued"}\') RETURNING id',
          [feed.id, feed.organization_id, actor.id, mode],
          sql,
        );
        await sql.query(
          'INSERT INTO professional_import_jobs(run_id,payload) VALUES($1,$2)',
          [run!.id, JSON.stringify(input.items)],
        );
        await this.audit.record(
          sql,
          actor.id,
          'professional.feed.queued',
          'professional_import_run',
          run!.id,
          { feedId, mode, count: input.items.length },
        );
        return { runId: run!.id, status: 'queued' };
      },
      (sql) => this.permission(actor, organizationId, feedId, true, sql),
    );
  }
  async configure(
    actor: Actor,
    org: string,
    id: string,
    body: unknown,
    admin = false,
  ) {
    seller(actor);
    const input = parse(feedConfig, body);
    return this.db.transaction(async (sql) => {
      await this.permission(actor, org, id, true, sql, admin);
      const [feed] = await this.db.rows(
        'UPDATE professional_feed_definitions SET active=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING id,active,version',
        [id, input.active, input.version],
        sql,
      );
      if (!feed) throw new ConflictException('Stale feed version');
      await this.audit.record(
        sql,
        actor.id,
        'professional.feed.configured',
        'professional_feed',
        id,
        { ...input, admin },
      );
      return feed;
    });
  }
  async logs(
    actor: Actor,
    org: string,
    id: string,
    query: unknown,
    admin = false,
  ) {
    await this.permission(actor, org, id, false, this.db.pool, admin);
    const q = parse(pages, query);
    return this.db.rows(
      'SELECT r.id,r.mode,r.status,r.stats,r.error,r.created_at,r.finished_at,j.state AS job_state,j.attempts,j.available_at,j.last_error FROM professional_import_runs r LEFT JOIN professional_import_jobs j ON j.run_id=r.id WHERE r.feed_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT $3',
      [id, q.after ?? null, q.limit],
    );
  }
  async items(
    actor: Actor,
    org: string,
    id: string,
    runId: string,
    query: unknown,
  ) {
    await this.permission(actor, org, id);
    const q = parse(
      z
        .object({
          after: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .strict(),
      query,
    );
    return this.db.rows(
      'SELECT i.external_reference,i.property_id,i.listing_id,i.status,i.errors FROM professional_import_items i JOIN professional_import_runs r ON r.id=i.run_id WHERE i.run_id=$1 AND r.feed_id=$2 AND ($3::text IS NULL OR i.external_reference>$3) ORDER BY i.external_reference LIMIT $4',
      [parse(uuid, runId), id, q.after ?? null, q.limit],
    );
  }
  async retry(
    actor: Actor,
    org: string,
    id: string,
    runId: string,
    admin = false,
  ) {
    seller(actor);
    return this.db.transaction(async (sql) => {
      await this.permission(actor, org, id, true, sql, admin);
      const [row] = await this.db.rows(
        "UPDATE professional_import_jobs j SET state='pending',attempts=0,available_at=now(),last_error=NULL FROM professional_import_runs r WHERE r.id=j.run_id AND j.run_id=$1 AND r.feed_id=$2 AND j.state='dead' RETURNING j.run_id",
        [parse(uuid, runId), id],
        sql,
      );
      if (!row) throw new ConflictException('Dead import required');
      await sql.query(
        "UPDATE professional_import_runs SET status='running',error=NULL,finished_at=NULL WHERE id=$1",
        [runId],
      );
      await this.audit.record(
        sql,
        actor.id,
        'professional.feed.retry',
        'professional_import_run',
        runId,
        { admin },
      );
      return row;
    });
  }
  async schedule() {
    return this.db.transaction(async (sql) => {
      const feeds = await this.db.rows<Feed>(
        `SELECT f.* FROM professional_feed_definitions f WHERE f.active AND f.schedule_cron IS NOT NULL AND f.transport->>'kind'='https' AND f.next_run_at<=now() AND NOT EXISTS(SELECT 1 FROM professional_import_jobs j JOIN professional_import_runs r ON r.id=j.run_id WHERE r.feed_id=f.id AND j.state IN ('pending','running')) ORDER BY f.next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [],
        sql,
      );
      for (const feed of feeds) {
        try {
          cadence(feed.schedule_cron!);
        } catch {
          await sql.query(
            'UPDATE professional_feed_definitions SET active=false,version=version+1 WHERE id=$1',
            [feed.id],
          );
          await this.audit.record(
            sql,
            null,
            'professional.feed.schedule_rejected',
            'professional_feed',
            feed.id,
          );
          continue;
        }
        const [run] = await this.db.rows<{ id: string }>(
          "INSERT INTO professional_import_runs(feed_id,organization_id,requested_by,mode,status,stats) VALUES($1,$2,$3,'apply','running','{\"stage\":\"queued\"}') RETURNING id",
          [feed.id, feed.organization_id, feed.created_by],
          sql,
        );
        await sql.query(
          'INSERT INTO professional_import_jobs(run_id) VALUES($1)',
          [run!.id],
        );
        await sql.query(
          'UPDATE professional_feed_definitions SET next_run_at=$2 WHERE id=$1',
          [feed.id, nextDue(feed.schedule_cron!)],
        );
        await this.audit.record(
          sql,
          null,
          'professional.feed.scheduled',
          'professional_import_run',
          run!.id,
          { feedId: feed.id },
        );
      }
      return feeds.length;
    });
  }
  async once() {
    await this.schedule();
    const job = await this.db.transaction(async (sql) => {
      const [j] = await this.db.rows<Job>(
        "SELECT j.*,r.feed_id,r.organization_id,r.requested_by,r.mode FROM professional_import_jobs j JOIN professional_import_runs r ON r.id=j.run_id JOIN professional_feed_definitions f ON f.id=r.feed_id WHERE j.state IN ('pending','running') AND j.available_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) AND NOT EXISTS(SELECT 1 FROM professional_import_jobs prior JOIN professional_import_runs pr ON pr.id=prior.run_id WHERE pr.feed_id=r.feed_id AND prior.state IN ('pending','running') AND (pr.created_at,pr.id)<(r.created_at,r.id)) ORDER BY j.available_at,j.run_id LIMIT 1 FOR UPDATE OF j,f SKIP LOCKED",
        [],
        sql,
      );
      if (!j) return null;
      const lease = randomUUID();
      await sql.query(
        "UPDATE professional_import_jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds' WHERE run_id=$1",
        [j.run_id, lease],
      );
      return { ...j, lease_token: lease, attempts: j.attempts + 1 };
    });
    if (!job) return false;
    try {
      const [actor] = await this.db.rows<Actor>(
        "SELECT id,role,email_verified_at,phone_verified_at,'worker' AS session_id FROM users WHERE id=$1 AND active",
        [job.requested_by],
      );
      if (!actor) throw new ForbiddenException();
      seller(actor);
      const feed = await this.permission(
        actor,
        job.organization_id,
        job.feed_id,
        true,
      );
      if (!feed.active) throw new ConflictException();
      const payload =
        job.payload ??
        parseFeed(
          await this.fetcher.fetch(feed.transport.url!),
          feed.format,
          feed.mapping,
        );
      if (!job.payload)
        await this.db.pool.query(
          'UPDATE professional_import_jobs SET payload=$3 WHERE run_id=$1 AND lease_token=$2 AND lease_until>now()',
          [job.run_id, job.lease_token, JSON.stringify(payload)],
        );
      const seen = new Set<string>();
      for (let i = 0; i < payload.length; i++) {
        const parsed = importItem.safeParse(payload[i]);
        const reference = parsed.success
          ? parsed.data.externalReference
          : `invalid:${i}`;
        const duplicate = seen.has(reference);
        seen.add(reference);
        const logKey = duplicate
          ? `duplicate:${i}:${hash(reference)}`
          : reference;
        await this.process(job, actor, feed, payload[i], logKey, duplicate);
      }
      await this.db.transaction(async (sql) => {
        const result = await sql.query(
          "UPDATE professional_import_jobs SET state='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE run_id=$1 AND lease_token=$2 AND lease_until>now() RETURNING run_id",
          [job.run_id, job.lease_token],
        );
        if (!result.rowCount) return;
        const [counts] = await this.db.rows<{
          total: number;
          valid: number;
          quarantined: number;
        }>(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE status IN ('upserted','valid'))::int AS valid,count(*) FILTER(WHERE status IN ('invalid','quarantined'))::int AS quarantined FROM professional_import_items WHERE run_id=$1",
          [job.run_id],
          sql,
        );
        await sql.query(
          'UPDATE professional_import_runs SET status=$2,stats=$3,error=NULL,finished_at=now() WHERE id=$1',
          [
            job.run_id,
            counts!.quarantined ? 'quarantined' : 'succeeded',
            JSON.stringify(counts),
          ],
        );
        await this.audit.record(
          sql,
          actor.id,
          job.mode === 'dry_run'
            ? 'professional.feed.dry_run'
            : 'professional.feed.applied',
          'professional_import_run',
          job.run_id,
          counts,
        );
      });
    } catch {
      await this.db.transaction(async (sql) => {
        const result = await sql.query(
          "UPDATE professional_import_jobs SET state=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,last_error='import_failed',available_at=now()+interval '1 second'*LEAST(3600,30*power(2,attempts)) WHERE run_id=$1 AND lease_token=$2 RETURNING state",
          [job.run_id, job.lease_token],
        );
        if (result.rows[0]?.state === 'dead') {
          await sql.query(
            "UPDATE professional_import_runs SET status='failed',error='import_failed',finished_at=now() WHERE id=$1",
            [job.run_id],
          );
          await this.audit.record(
            sql,
            null,
            'professional.feed.dead',
            'professional_import_run',
            job.run_id,
          );
        }
      });
    }
    return true;
  }
  async process(
    job: Job,
    actor: Actor,
    feed: Feed,
    raw: unknown,
    logKey: string,
    duplicate: boolean,
  ) {
    await this.db.transaction(async (sql) => {
      const [held] = await this.db.rows(
        'SELECT run_id FROM professional_import_jobs WHERE run_id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',
        [job.run_id, job.lease_token],
        sql,
      );
      if (!held) throw new ConflictException('Import lease expired');
      await sql.query(
        "UPDATE professional_import_jobs SET lease_until=now()+interval '60 seconds' WHERE run_id=$1",
        [job.run_id],
      );
      await this.permission(actor, feed.organization_id, feed.id, true, sql);
      const [enabled] = await this.db.rows(
        'SELECT id FROM professional_feed_definitions WHERE id=$1 AND active FOR SHARE',
        [feed.id],
        sql,
      );
      if (!enabled) throw new ForbiddenException();
      const [done] = await this.db.rows(
        'SELECT external_reference FROM professional_import_items WHERE run_id=$1 AND external_reference=$2',
        [job.run_id, logKey],
        sql,
      );
      if (done) return;
      await sql.query('SAVEPOINT feed_row');
      let listingId: string | null = null,
        propertyId: string | null = null;
      let status: string;
      let errors: unknown[] = [];
      try {
        if (duplicate)
          throw new BadRequestException('Duplicate external reference');
        const item = parse(importItem, raw);
        validateAttributes(
          await this.catalog.definitions(item.categoryCode, sql),
          item.attributes,
        );
        await sql.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${feed.id}:${item.externalReference}`],
        );
        const [record] = await this.db.rows<RecordRow>(
          'SELECT * FROM professional_feed_records WHERE feed_id=$1 AND external_reference=$2',
          [feed.id, item.externalReference],
          sql,
        );
        const fingerprint = normalizedFingerprint(item);
        if (record?.fingerprint === fingerprint) {
          listingId = record.listing_id;
          propertyId = record.property_id;
          status = job.mode === 'dry_run' ? 'valid' : 'upserted';
        } else {
          if (record) {
            const [existing] = await this.db.rows<{
              status: string;
              category_code: string;
              attributes: unknown;
              formatted: string;
              locality: string;
              district: string | null;
              longitude: number;
              latitude: number;
              organization_id: string;
            }>(
              `SELECT l.status,l.organization_id,p.category_code,p.attributes,a.formatted,a.locality,a.district,ST_X(a.point) AS longitude,ST_Y(a.point) AS latitude FROM listings l JOIN properties p ON p.id=l.property_id JOIN addresses a ON a.id=p.address_id WHERE l.id=$1 AND l.source_id=$2 FOR UPDATE OF l,p`,
              [record.listing_id, record.source_id],
              sql,
            );
            if (!existing || existing.organization_id !== feed.organization_id)
              throw new ForbiddenException('Source mismatch');
            if (!['draft', 'paused', 'rejected'].includes(existing.status))
              throw new ConflictException(
                'Pause listing before importing changes',
              );
            if (
              existing.category_code !== item.categoryCode ||
              !isDeepStrictEqual(existing.attributes, item.attributes) ||
              existing.formatted !== item.address.formatted ||
              existing.locality !== item.address.locality ||
              (existing.district ?? undefined) !== item.address.district ||
              existing.longitude !== item.address.longitude ||
              existing.latitude !== item.address.latitude
            )
              throw new ConflictException(
                'Use versioned Property workflow for physical changes',
              );
          }
          if (job.mode === 'dry_run') status = 'valid';
          else {
            if (record) {
              listingId = record.listing_id;
              propertyId = record.property_id;
              const [before] = await this.db.rows(
                'SELECT * FROM listings WHERE id=$1',
                [listingId],
                sql,
              );
              const [after] = await this.db.rows(
                "UPDATE listings SET title=$2,price=$3,description=$4,deal_type=$5,status='draft',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
                [
                  listingId,
                  item.title,
                  item.price,
                  item.description,
                  item.dealType,
                ],
                sql,
              );
              await this.audit.history(
                sql,
                actor.id,
                listingId,
                'professional.feed.updated',
                before!,
                after!,
              );
            } else {
              propertyId = (
                await this.properties.createWithSql(
                  actor,
                  {
                    organizationId: feed.organization_id,
                    category: item.categoryCode,
                    address: item.address,
                    attributes: item.attributes,
                  },
                  sql,
                )
              ).id;
              const [source] = await this.db.rows<{ id: string }>(
                "INSERT INTO listing_sources(kind,organization_id,external_reference,metadata) VALUES('feed',$1,$2,$3) RETURNING id",
                [
                  feed.organization_id,
                  `${feed.id}:${hash(item.externalReference)}`,
                  JSON.stringify({
                    feedId: feed.id,
                    externalReference: item.externalReference,
                    lastRunId: job.run_id,
                  }),
                ],
                sql,
              );
              const [listing] = await this.db.rows<{ id: string }>(
                'INSERT INTO listings(property_id,source_id,seller_id,organization_id,deal_type,title,price,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                [
                  propertyId,
                  source!.id,
                  actor.id,
                  feed.organization_id,
                  item.dealType,
                  item.title,
                  item.price,
                  item.description,
                ],
                sql,
              );
              listingId = listing!.id;
              await this.audit.history(
                sql,
                actor.id,
                listingId,
                'professional.feed.created',
                {},
                listing!,
              );
              await sql.query(
                'INSERT INTO professional_feed_records(feed_id,external_reference,listing_id,property_id,source_id) VALUES($1,$2,$3,$4,$5)',
                [
                  feed.id,
                  item.externalReference,
                  listingId,
                  propertyId,
                  source!.id,
                ],
              );
            }
            await sql.query(
              'UPDATE professional_feed_records SET fingerprint=$3,last_run_id=$4 WHERE feed_id=$1 AND external_reference=$2',
              [feed.id, item.externalReference, fingerprint, job.run_id],
            );
            status = 'upserted';
          }
        }
      } catch (e) {
        await sql.query('ROLLBACK TO SAVEPOINT feed_row');
        status = job.mode === 'dry_run' ? 'invalid' : 'quarantined';
        listingId = null;
        propertyId = null;
        errors = [
          {
            code:
              e instanceof ConflictException
                ? 'conflict'
                : e instanceof ForbiddenException
                  ? 'forbidden'
                  : 'validation',
            message: duplicate
              ? 'Duplicate external reference'
              : 'Row rejected; verify values and listing state',
          },
        ];
      }
      await sql.query('RELEASE SAVEPOINT feed_row');
      await sql.query(
        'INSERT INTO professional_import_items(run_id,external_reference,property_id,listing_id,status,payload,errors) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          job.run_id,
          logKey,
          propertyId,
          listingId,
          status,
          JSON.stringify(raw),
          JSON.stringify(errors),
        ],
      );
    });
  }
  async adminFeeds(actor: Actor) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    return this.db.rows(
      'SELECT id,organization_id,name,active,version,next_run_at FROM professional_feed_definitions ORDER BY id LIMIT 100',
    );
  }
  async adminOrganization(actor: Actor, id: string) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    const [feed] = await this.db.rows<{ organization_id: string }>(
      'SELECT organization_id FROM professional_feed_definitions WHERE id=$1',
      [parse(uuid, id)],
    );
    if (!feed) throw new NotFoundException();
    return feed.organization_id;
  }
}
@Controller('v1/organizations/:organizationId/feeds/:feedId')
export class ProfessionalImportsController {
  constructor(private readonly imports: ProfessionalImports) {}
  @Post('apply') apply(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('feedId') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k: unknown,
  ) {
    return this.imports.apply(a, o, id, b, k);
  }
  @Patch() configure(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('feedId') id: string,
    @Body() b: unknown,
  ) {
    return this.imports.configure(a, o, id, b);
  }
  @Get('runs') logs(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('feedId') id: string,
    @Query() q: unknown,
  ) {
    return this.imports.logs(a, o, id, q);
  }
  @Get('runs/:runId/items') items(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('feedId') id: string,
    @Param('runId') r: string,
    @Query() q: unknown,
  ) {
    return this.imports.items(a, o, id, r, q);
  }
  @Post('runs/:runId/retry') retry(
    @CurrentActor() a: Actor,
    @Param('organizationId') o: string,
    @Param('feedId') id: string,
    @Param('runId') r: string,
  ) {
    return this.imports.retry(a, o, id, r);
  }
}
@Controller('v1/admin/integrations/feeds')
@AdminOnly()
export class ProfessionalAdminController {
  constructor(private readonly imports: ProfessionalImports) {}
  @Get() list(@CurrentActor() a: Actor) {
    return this.imports.adminFeeds(a);
  }
  @Patch(':id') async configure(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.imports.configure(
      a,
      await this.imports.adminOrganization(a, id),
      id,
      b,
      true,
    );
  }
  @Get(':id/runs') async logs(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.imports.logs(
      a,
      await this.imports.adminOrganization(a, id),
      id,
      q,
      true,
    );
  }
  @Post(':id/runs/:runId/retry') async retry(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Param('runId') r: string,
  ) {
    return this.imports.retry(
      a,
      await this.imports.adminOrganization(a, id),
      id,
      r,
      true,
    );
  }
}
@Module({
  imports: [OrganizationsModule, CatalogModule, PropertiesModule, AuditModule],
  controllers: [ProfessionalImportsController, ProfessionalAdminController],
  providers: [
    ProfessionalImports,
    Idempotency,
    { provide: FeedFetcher, useClass: HttpsFeedFetcher },
  ],
  exports: [ProfessionalImports],
})
export class ProfessionalImportsModule {}
