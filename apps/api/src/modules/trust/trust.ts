import {
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
  verified,
  hash,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { evaluateRules } from './rules';
import { RULE_VERSION } from '../ai/contracts';
export const trustDecision = z
  .object({
    factHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['allow', 'reject', 'needs_info']),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
export const duplicateDecision = z
  .object({
    decision: z.enum(['confirmed_duplicate', 'distinct', 'needs_info']),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
export interface Snapshot {
  id: string;
  property_id: string;
  seller_id: string;
  version: number;
  property_version: number;
  title: string;
  description: string;
  price: string | null;
  status: string;
  deal_type: string;
  category_code: string;
  attributes: Record<string, unknown>;
  unit_number: string | null;
  formatted: string;
  locality: string;
  longitude: number;
  latitude: number;
  source_id: string;
  external_reference: string | null;
  media: {
    id: string;
    state: string;
    content_sha256: string | null;
    variants: Record<string, { width?: number; height?: number }>;
  }[];
  factHash: string;
}
export function adminActor(actor: Actor) {
  verified(actor);
  if (actor.role !== 'admin') throw new ForbiddenException();
}
@Injectable()
export class Trust {
  constructor(
    readonly db: Database,
    readonly access: ListingAccess,
    readonly audit: Audit,
    readonly idem: Idempotency,
  ) {}
  async snapshot(id: string, sql: Sql = this.db.pool): Promise<Snapshot> {
    const [row] = await this.db.rows<Omit<Snapshot, 'factHash'>>(
      `SELECT l.id,l.property_id,l.seller_id,l.version,l.title,l.description,l.price,l.status,l.deal_type,l.source_id,p.version AS property_version,p.category_code,p.attributes,p.unit_number,a.formatted,a.locality,ST_X(a.point) AS longitude,ST_Y(a.point) AS latitude,s.external_reference,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'state',m.state,'content_sha256',m.content_sha256,'variants',m.variants) ORDER BY m.id) FROM media m WHERE m.listing_id=l.id),'[]'::jsonb) AS media FROM listings l JOIN properties p ON p.id=l.property_id JOIN addresses a ON a.id=p.address_id JOIN listing_sources s ON s.id=l.source_id WHERE l.id=$1`,
      [parse(uuid, id)],
      sql,
    );
    if (!row) throw new NotFoundException();
    // Only a digest of the exact private snapshot is exposed as a review concurrency token.
    return { ...row, factHash: hash(JSON.stringify(row)) };
  }
  async enqueue(actor: Actor, id: string, key: unknown) {
    verified(actor);
    parse(uuid, id);
    return this.idem.run(
      actor,
      'trust.scan:' + id,
      key,
      {},
      async (sql) => {
        const snapshot = await this.snapshot(id, sql);
        const [job] = await this.db.rows(
          `INSERT INTO trust_jobs(listing_id,listing_version,fact_hash,rule_version) VALUES($1,$2,$3,$4) ON CONFLICT(listing_id,fact_hash,rule_version) DO UPDATE SET listing_id=EXCLUDED.listing_id RETURNING id,state`,
          [id, snapshot.version, snapshot.factHash, RULE_VERSION],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'trust.scan.queued',
          'listing',
          id,
          { jobId: job!.id, ruleVersion: RULE_VERSION },
        );
        return job;
      },
      (sql) => this.access.get(actor, id, sql),
    );
  }
  async result(actor: Actor, id: string) {
    await this.access.get(actor, id);
    const current = await this.snapshot(id);
    const [assessment] = await this.db.rows(
      `SELECT id,listing_version,fact_hash,rule_version,findings,created_at FROM trust_assessments WHERE listing_id=$1 AND fact_hash=$2 AND rule_version=$3`,
      [id, current.factHash, RULE_VERSION],
    );
    // Owners receive only their own rule findings, never another owner's private candidate identity.
    return {
      schemaVersion: 1,
      factHash: current.factHash,
      ruleVersion: RULE_VERSION,
      findings:
        assessment?.findings ??
        evaluateRules({
          ...current,
          price: current.price ? Number(current.price) : null,
        }),
      assessed: Boolean(assessment),
    };
  }
  async checkPublication(sql: Sql, id: string) {
    const snapshot = await this.snapshot(id, sql),
      findings = evaluateRules({
        ...snapshot,
        price: snapshot.price ? Number(snapshot.price) : null,
      });
    if (findings.some((x) => x.severity === 'block'))
      throw new ConflictException(
        'Deterministic trust rule blocked publication',
      );
    const [assessment] = await this.db.rows<{
      findings: { severity: string }[];
    }>(
      `SELECT findings FROM trust_assessments WHERE listing_id=$1 AND fact_hash=$2 AND rule_version=$3`,
      [id, snapshot.factHash, RULE_VERSION],
      sql,
    );
    const [review] = await this.db.rows<{ decision: string }>(
      `SELECT decision FROM trust_reviews WHERE listing_id=$1 AND fact_hash=$2 AND rule_version=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [id, snapshot.factHash, RULE_VERSION],
      sql,
    );
    if (review && review.decision !== 'allow')
      throw new ConflictException('Human trust review required');
    if (
      (findings.some((x) => x.severity === 'review') ||
        assessment?.findings.some((x) => x.severity === 'review')) &&
      review?.decision !== 'allow'
    )
      throw new ConflictException('Human trust review required');
  }
  async review(actor: Actor, id: string, body: unknown, key: unknown) {
    adminActor(actor);
    const input = parse(trustDecision, body);
    parse(uuid, id);
    return this.idem.run(
      actor,
      'trust.review:' + id,
      key,
      input,
      async (sql) => {
        const reference = await this.snapshot(id, sql);
        await sql.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE', [
          reference.property_id,
        ]);
        await sql.query('SELECT id FROM listings WHERE id=$1 FOR UPDATE', [id]);
        const current = await this.snapshot(id, sql);
        if (current.seller_id === actor.id)
          throw new ForbiddenException('Cannot review own listing');
        if (current.factHash !== input.factHash)
          throw new ConflictException('Stale trust snapshot');
        const [review] = await this.db.rows(
          `INSERT INTO trust_reviews(listing_id,fact_hash,rule_version,reviewer_id,decision,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,decision`,
          [
            id,
            current.factHash,
            RULE_VERSION,
            actor.id,
            input.decision,
            input.reason,
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'trust.review.decided',
          'listing',
          id,
          { ...input, ruleVersion: RULE_VERSION },
        );
        return review;
      },
    );
  }
  async candidates(actor: Actor) {
    adminActor(actor);
    return this.db.rows(
      `SELECT d.*,a.fact_hash FROM duplicate_candidates d JOIN trust_assessments a ON a.id=d.assessment_id ORDER BY d.created_at DESC,d.id LIMIT 100`,
    );
  }
  async reviewDuplicate(actor: Actor, id: string, body: unknown, key: unknown) {
    adminActor(actor);
    const input = parse(duplicateDecision, body);
    parse(uuid, id);
    return this.idem.run(
      actor,
      'duplicate.review:' + id,
      key,
      input,
      async (sql) => {
        const [candidate] = await this.db.rows<{
          listing_id: string;
          candidate_id: string;
          candidate_version: number;
          candidate_fact_hash: string;
          fact_hash: string;
        }>(
          `SELECT d.*,a.fact_hash FROM duplicate_candidates d JOIN trust_assessments a ON a.id=d.assessment_id WHERE d.id=$1`,
          [id],
          sql,
        );
        if (!candidate) throw new NotFoundException();
        const ids = [candidate.listing_id, candidate.candidate_id].sort();
        await sql.query(
          'SELECT id FROM properties WHERE id IN (SELECT property_id FROM listings WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE',
          [ids],
        );
        await sql.query(
          'SELECT id FROM listings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [ids],
        );
        const source = await this.snapshot(candidate.listing_id, sql),
          other = await this.snapshot(candidate.candidate_id, sql);
        if ([source.seller_id, other.seller_id].includes(actor.id))
          throw new ForbiddenException('Cannot review own duplicate candidate');
        if (
          source.factHash !== candidate.fact_hash ||
          other.factHash !== candidate.candidate_fact_hash
        )
          throw new ConflictException('Stale duplicate candidate');
        const [review] = await this.db.rows(
          'INSERT INTO duplicate_reviews(candidate_id,reviewer_id,decision,reason) VALUES($1,$2,$3,$4) RETURNING id,decision',
          [id, actor.id, input.decision, input.reason],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'duplicate.review.decided',
          'duplicate_candidate',
          id,
          input,
        );
        return review;
      },
    );
  }
  async jobs(actor: Actor) {
    adminActor(actor);
    return this.db.rows(
      'SELECT id,listing_id,state,attempts,available_at,last_error FROM trust_jobs ORDER BY created_at DESC LIMIT 100',
    );
  }
  async retry(actor: Actor, id: string) {
    adminActor(actor);
    parse(uuid, id);
    return this.db.transaction(async (sql) => {
      const [job] = await this.db.rows(
        "UPDATE trust_jobs SET state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND state='dead' RETURNING id",
        [id],
        sql,
      );
      if (!job) throw new ConflictException('Dead trust job required');
      await this.audit.record(
        sql,
        actor.id,
        'trust.job.retried',
        'trust_job',
        id,
      );
      return job;
    });
  }
}
@Controller('v1/trust/listings')
class TrustController {
  constructor(readonly trust: Trust) {}
  @Get(':id') result(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.trust.result(actor, id);
  }
  @Post(':id/scan') scan(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.trust.enqueue(actor, id, key);
  }
}
@AdminOnly()
@Controller('v1/admin/trust')
class TrustAdminController {
  constructor(readonly trust: Trust) {}
  @Get('candidates') candidates(@CurrentActor() actor: Actor) {
    return this.trust.candidates(actor);
  }
  @Get('jobs') jobs(@CurrentActor() actor: Actor) {
    return this.trust.jobs(actor);
  }
  @Post('jobs/:id/retry') retry(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.trust.retry(actor, id);
  }
  @Post('listings/:id/decision') review(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.trust.review(actor, id, body, key);
  }
  @Post('candidates/:id/decision') duplicate(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.trust.reviewDuplicate(actor, id, body, key);
  }
}
@Module({
  imports: [ListingAccessModule],
  providers: [Trust, Idempotency],
  controllers: [TrustController, TrustAdminController],
  exports: [Trust],
})
export class TrustModule {}
