import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor, hash, parse, uuid, verified } from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { nextDue } from './contracts';
import { validateFeedUrl } from './feed-fetch';

const approval = z
  .object({
    version: z.number().int().positive(),
    trusted: z.boolean(),
  })
  .strict();
const hourly = '0 * * * *';
type Link = {
  id: string;
  version: number;
  created_by: string;
  organization_id: string | null;
  transport: { url?: string };
};

// Both the display and the approval operation use the latest URL check of this revision.
const eligible = `COALESCE((
  SELECT r.status IN ('succeeded','quarantined') AND (r.stats->>'valid')::integer>0
  FROM professional_import_runs r WHERE r.feed_id=f.id AND r.mode='dry_run' AND r.source_version=f.version
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1),false)`;
const managed = `f.format='xml' AND f.transport @> '{"kind":"https","linkSlot":true}'`;
const adminRows = `SELECT f.id,f.name,f.organization_id,COALESCE(o.name,u.display_name) AS "ownerName",
  f.active,f.version,f.next_run_at,
  CASE WHEN ${managed} THEN f.transport->>'provider' END AS provider,
  CASE WHEN ${managed} THEN f.transport->>'url' END AS url,
  f.publication_approved_at IS NOT NULL AS trusted,
  (f.active AND ${managed} AND ${eligible}) AS "trustEligible"
  FROM professional_feed_definitions f JOIN users u ON u.id=f.created_by
  LEFT JOIN organizations o ON o.id=f.organization_id`;

function admin(actor: Actor) {
  verified(actor);
  if (actor.role !== 'admin') throw new ForbiddenException();
}
type AdminSource = {
  id: string;
  name: string;
  organization_id: string | null;
  ownerName: string;
  active: boolean;
  version: number;
  next_run_at: Date | null;
  provider: string | null;
  url: string | null;
  trusted: boolean;
  trustEligible: boolean;
};

function publicRow({ url, ...row }: AdminSource) {
  return { ...row, host: url ? new URL(url).hostname : null };
}

@Injectable()
export class TrustedFeedSources {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
  ) {}

  async list(actor: Actor, after?: string) {
    admin(actor);
    const rows = await this.db.rows<AdminSource>(
      adminRows +
        ' WHERE ($1::uuid IS NULL OR f.id>$1) ORDER BY f.id LIMIT 100',
      [after === undefined ? null : parse(uuid, after)],
    );
    return rows.map(publicRow);
  }

  async set(actor: Actor, feedId: string, body: unknown) {
    admin(actor);
    const input = parse(approval, body);
    const id = parse(uuid, feedId);
    return this.db.transaction(async (sql) => {
      const [feed] = await this.db.rows<
        Link & { active: boolean; trusted: boolean; eligible: boolean }
      >(
        `SELECT f.*,f.publication_approved_at IS NOT NULL AS trusted,${eligible} AS eligible
         FROM professional_feed_definitions f WHERE f.id=$1 AND ${managed} FOR UPDATE OF f`,
        [id],
        sql,
      );
      if (!feed) throw new NotFoundException();
      if (feed.version !== input.version)
        throw new ConflictException('Stale feed version');
      if (input.trusted !== feed.trusted) {
        if (input.trusted) {
          if (!feed.active || !feed.eligible)
            throw new ConflictException('Current feed preview required');
          validateFeedUrl(
            feed.transport.url!,
            (process.env.FEED_ALLOWED_HOSTS ?? '')
              .split(',')
              .map((x) => x.trim()),
          );
        }
        const [changed] = await this.db.rows<Link>(
          `UPDATE professional_feed_definitions SET
             publication_approved_at=CASE WHEN $2 THEN now() END,
             publication_approved_by=CASE WHEN $2 THEN $3::uuid END,
             version=version+1,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, input.trusted, actor.id],
          sql,
        );
        if (input.trusted) await this.enqueue(sql, changed!);
        await this.audit.record(
          sql,
          actor.id,
          input.trusted
            ? 'professional.feed.approved'
            : 'professional.feed.revoked',
          'professional_feed',
          id,
          { version: changed!.version },
        );
      }
      const [row] = await this.db.rows<AdminSource>(
        adminRows + ' WHERE f.id=$1',
        [id],
        sql,
      );
      return publicRow(row!);
    });
  }

  // The caller holds the source row lock. Each job records the approval revision it may use.
  async enqueue(sql: Sql, feed: Link) {
    const [run] = await this.db.rows<{ id: string }>(
      `INSERT INTO professional_import_runs(feed_id,organization_id,requested_by,mode,status,stats,source_version,created_at)
       VALUES($1,$2,$3,'apply','running',$4,$5,clock_timestamp()) RETURNING id`,
      [
        feed.id,
        feed.organization_id,
        feed.created_by,
        JSON.stringify({
          stage: 'queued',
          sourceHash: hash(feed.transport.url!),
        }),
        feed.version,
      ],
      sql,
    );
    await sql.query('INSERT INTO professional_import_jobs(run_id) VALUES($1)', [
      run!.id,
    ]);
    await sql.query(
      'UPDATE professional_feed_definitions SET next_run_at=$2,last_apply_run_id=$3 WHERE id=$1',
      [feed.id, nextDue(hourly), run!.id],
    );
    await this.audit.record(
      sql,
      null,
      'professional.feed.scheduled',
      'professional_import_run',
      run!.id,
      { feedId: feed.id, version: feed.version },
    );
  }
}
