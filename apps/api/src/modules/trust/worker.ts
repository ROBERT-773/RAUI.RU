import { Injectable, Module } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../database/database';
import { Audit } from '../audit/audit';
import { Trust, TrustModule, Snapshot } from './trust';
import { RULE_VERSION } from '../ai/contracts';
import { evaluateRules } from './rules';
const candidateResult = z
  .object({
    id: z.uuid(),
    confidence: z.number().min(0).max(1),
    reasons: z
      .array(
        z.enum([
          'shared_property',
          'address',
          'geo',
          'area',
          'layout',
          'photo',
          'source',
          'unit_conflict',
        ]),
      )
      .max(8),
    autoMerge: z.literal(false),
    requiresHumanReview: z.literal(true),
    ruleVersion: z.literal(RULE_VERSION),
  })
  .strict();
const report = z
  .object({
    schemaVersion: z.literal(1),
    candidates: z.array(candidateResult).max(100),
  })
  .strict();
export abstract class DuplicateScorer {
  abstract score(input: unknown): Promise<z.infer<typeof report>>;
}
@Injectable()
export class PythonDuplicateScorer extends DuplicateScorer {
  async score(input: unknown) {
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 256000) throw new Error('trust_input_limit');
    return new Promise<z.infer<typeof report>>((done, reject) => {
      const child = spawn('python3', ['-m', 'raui_ai.worker'], {
        cwd: resolve(process.cwd(), '../ai'),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let size = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('trust_data_deadline'));
      }, 4000);
      child.stdin.on('error', () => reject(new Error('trust_data_failed')));
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128000) {
          child.kill('SIGKILL');
          reject(new Error('trust_output_limit'));
        } else chunks.push(chunk);
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('trust_data_failed'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error('trust_data_failed'));
          return;
        }
        try {
          done(
            report.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
          );
        } catch {
          reject(new Error('trust_data_invalid'));
        }
      });
      child.stdin.end(body);
    });
  }
}
function facts(s: Snapshot, distanceMeters = 0) {
  return {
    id: s.id,
    propertyId: s.property_id,
    category: s.category_code,
    address: s.formatted,
    attributes: Object.fromEntries(
      ['area', 'rooms', 'floor']
        .filter(
          (key) =>
            typeof s.attributes[key] === 'number' &&
            Number.isFinite(s.attributes[key]),
        )
        .map((key) => [key, s.attributes[key]]),
    ),
    unit: s.unit_number,
    photos: s.media
      .filter((x) => x.state === 'ready' && x.content_sha256)
      .map((x) => x.content_sha256)
      .slice(0, 10),
    sourceReference: s.external_reference
      ? s.source_id + ':' + s.external_reference
      : null,
    distanceMeters,
  };
}
interface Job {
  id: string;
  listing_id: string;
  fact_hash: string;
  lease_token: string;
  attempts: number;
}
@Injectable()
export class TrustWorker {
  private scheduleCursor: { createdAt: string; id: string } | null = null;
  constructor(
    readonly db: Database,
    readonly trust: Trust,
    readonly scorer: DuplicateScorer,
    readonly audit: Audit,
  ) {}
  async schedule() {
    const page = () =>
      this.db.rows<{ listing_id: string; id: string; created_at: string }>(
        "SELECT id,listing_id,created_at::text FROM moderation_cases WHERE state='pending' AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid)) ORDER BY created_at,id LIMIT 100",
        [
          this.scheduleCursor?.createdAt ?? null,
          this.scheduleCursor?.id ?? null,
        ],
      );
    let rows = await page();
    if (!rows.length && this.scheduleCursor) {
      this.scheduleCursor = null;
      rows = await page();
    }
    for (const row of rows) {
      const snapshot = await this.trust.snapshot(row.listing_id);
      await this.db.pool.query(
        'INSERT INTO trust_jobs(listing_id,listing_version,fact_hash,rule_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [snapshot.id, snapshot.version, snapshot.factHash, RULE_VERSION],
      );
    }
    const last = rows.at(-1);
    if (last) this.scheduleCursor = { createdAt: last.created_at, id: last.id };
  }
  async once() {
    await this.schedule();
    const job = await this.db.transaction(async (sql) => {
      const [j] = await this.db.rows<Job>(
        "SELECT * FROM trust_jobs WHERE (state='pending' AND available_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [],
        sql,
      );
      if (!j) return null;
      if (j.attempts >= 3) {
        await sql.query(
          "UPDATE trust_jobs SET state='dead',lease_token=NULL,lease_until=NULL,last_error='lease_attempts_exhausted' WHERE id=$1",
          [j.id],
        );
        await this.audit.record(sql, null, 'trust.dead', 'trust_job', j.id, {
          attempt: j.attempts,
          reason: 'lease_attempts_exhausted',
        });
        return null;
      }
      const lease = randomUUID();
      await sql.query(
        "UPDATE trust_jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",
        [j.id, lease],
      );
      return { ...j, lease_token: lease, attempts: j.attempts + 1 };
    });
    if (!job) return false;
    try {
      const subject = await this.trust.snapshot(job.listing_id);
      if (subject.factHash !== job.fact_hash) {
        await this.finishStale(job);
        return true;
      }
      const matches = await this.db.rows<{ id: string; distance: number }>(
        `SELECT l.id,ST_Distance(a.point::geography,b.point::geography) AS distance FROM listings l JOIN properties p ON p.id=l.property_id JOIN addresses a ON a.id=p.address_id JOIN addresses b ON b.id=(SELECT address_id FROM properties WHERE id=$2) WHERE l.id<>$1 AND p.category_code=$3 AND l.status NOT IN ('archived','sold','rented','rejected') AND (p.id=$2 OR ST_DWithin(a.point::geography,b.point::geography,50)) ORDER BY distance,l.id LIMIT 100`,
        [subject.id, subject.property_id, subject.category_code],
      );
      const snapshots = await Promise.all(
        matches.map((x) => this.trust.snapshot(x.id)),
      );
      const scored = await this.scorer.score({
        schemaVersion: 1,
        subject: facts(subject),
        candidates: snapshots.map((s, i) => facts(s, matches[i]!.distance)),
      });
      const seen = new Set<string>();
      for (const c of scored.candidates) {
        if (!snapshots.some((s) => s.id === c.id) || seen.has(c.id))
          throw new Error('invalid_candidate');
        seen.add(c.id);
      }
      const findings = evaluateRules({
        ...subject,
        price: subject.price ? Number(subject.price) : null,
      });
      await this.db.transaction(async (sql) => {
        const [held] = await this.db.rows(
          "SELECT id FROM trust_jobs WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
          [job.id, job.lease_token],
          sql,
        );
        if (!held) return;
        const ids = [subject.id, ...snapshots.map((s) => s.id)].sort();
        await sql.query(
          'SELECT id FROM properties WHERE id IN (SELECT property_id FROM listings WHERE id=ANY($1::uuid[])) ORDER BY id FOR SHARE',
          [ids],
        );
        await sql.query(
          'SELECT id FROM listings WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [ids],
        );
        const current = await this.trust.snapshot(subject.id, sql);
        if (current.factHash !== subject.factHash) {
          await sql.query(
            "UPDATE trust_jobs SET state='stale',lease_token=NULL,lease_until=NULL WHERE id=$1",
            [job.id],
          );
          return;
        }
        const stable: typeof scored.candidates = [];
        for (const c of scored.candidates) {
          const fresh = await this.trust.snapshot(c.id, sql),
            original = snapshots.find((s) => s.id === c.id)!;
          if (fresh.factHash === original.factHash) stable.push(c);
        }
        // Multiple signals are evidence for review, never automatic mutation or publication.
        if (
          stable.some(
            (c) => c.confidence >= 0.5 && !c.reasons.includes('unit_conflict'),
          )
        )
          findings.push({
            code: 'duplicate_candidate',
            severity: 'review',
            confidence: Math.max(...stable.map((c) => c.confidence)),
          });
        const [assessment] = await this.db.rows<{ id: string }>(
          'INSERT INTO trust_assessments(listing_id,listing_version,fact_hash,rule_version,findings) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
          [
            subject.id,
            subject.version,
            subject.factHash,
            RULE_VERSION,
            JSON.stringify(findings),
          ],
          sql,
        );
        if (assessment)
          for (const c of stable) {
            if (c.confidence < 0.3) continue;
            const candidate = snapshots.find((s) => s.id === c.id)!;
            await sql.query(
              'INSERT INTO duplicate_candidates(assessment_id,listing_id,candidate_id,candidate_version,candidate_fact_hash,confidence,reasons,rule_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                assessment.id,
                subject.id,
                c.id,
                candidate.version,
                candidate.factHash,
                c.confidence,
                JSON.stringify(c.reasons),
                RULE_VERSION,
              ],
            );
          }
        await sql.query(
          "UPDATE trust_jobs SET state='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1",
          [job.id],
        );
        await this.audit.record(
          sql,
          null,
          'trust.assessed',
          'listing',
          subject.id,
          {
            ruleVersion: RULE_VERSION,
            assessmentId: assessment?.id,
            candidateCount: stable.length,
          },
        );
      });
    } catch {
      await this.db.transaction(async (sql) => {
        const result = await sql.query(
          "UPDATE trust_jobs SET state=$3,available_at=now()+interval '1 second'*LEAST(300,10*power(2,attempts)),lease_token=NULL,lease_until=NULL,last_error='assessment_failed' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='running' RETURNING id",
          [job.id, job.lease_token, job.attempts >= 3 ? 'dead' : 'pending'],
        );
        if (result.rowCount)
          await this.audit.record(
            sql,
            null,
            job.attempts >= 3 ? 'trust.dead' : 'trust.retry',
            'trust_job',
            job.id,
            { attempt: job.attempts },
          );
      });
    }
    return true;
  }
  async finishStale(job: Job) {
    await this.db.pool.query(
      "UPDATE trust_jobs SET state='stale',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='running'",
      [job.id, job.lease_token],
    );
  }
}
@Module({
  imports: [TrustModule],
  providers: [
    TrustWorker,
    { provide: DuplicateScorer, useClass: PythonDuplicateScorer },
  ],
  exports: [TrustWorker, DuplicateScorer],
})
export class TrustWorkerModule {}
