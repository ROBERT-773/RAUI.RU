import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import {
  Actor,
  Idempotency,
  parse,
  uuid,
  verified,
} from '../../common/security';
const fields = `r.id,r.user_id,u.public_id,u.display_name,u.role,u.email_verified_at,u.phone_verified_at,r.requested_at`;
interface QueueItem {
  id: string;
  user_id: string;
  public_id: string;
  display_name: string;
  role: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  requested_at: Date | string;
  cursor_at: string;
}
const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();
@Injectable()
export class RegistrationApprovals {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async queue(after?: string) {
    let cursor: { requestedAt: string; id: string } | null = null;
    if (after !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,500}$/.test(after)) throw new Error();
        cursor = parse(
          z
            .object({ requestedAt: z.iso.datetime({ offset: true }), id: uuid })
            .strict(),
          JSON.parse(Buffer.from(after, 'base64url').toString('utf8')),
        );
      } catch {
        throw new BadRequestException('Invalid queue cursor');
      }
    }
    const rows = await this.db.rows<QueueItem>(
      `SELECT ${fields},to_char(r.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM registration_approval_requests r JOIN users u ON u.id=r.user_id
      WHERE r.state='pending' AND ($1::timestamptz IS NULL OR (r.requested_at,r.id)>($1::timestamptz,$2::uuid))
      ORDER BY r.requested_at,r.id LIMIT 101`,
      [cursor?.requestedAt ?? null, cursor?.id ?? null],
    );
    const page = rows.slice(0, 100);
    const items = page.map(({ cursor_at, ...item }) => {
      void cursor_at;
      return item;
    });
    const last = page.at(-1);
    return {
      items,
      cursor:
        rows.length > 100 && last
          ? Buffer.from(
              JSON.stringify({ requestedAt: last.cursor_at, id: last.id }),
            ).toString('base64url')
          : null,
    };
  }
  async detail(id: string) {
    const [row] = await this.db.rows(
      `SELECT ${fields},u.email,u.phone,r.state,r.reason,r.resolved_at
      FROM registration_approval_requests r JOIN users u ON u.id=r.user_id WHERE r.id=$1`,
      [parse(uuid, id)],
    );
    if (!row) throw new NotFoundException();
    return row;
  }
  private async authorize(sql: Sql, actor: Actor) {
    // Row locks serialize with role/deactivation, session revocation and grant changes.
    const [current] = await this.db.rows<Actor & { active: boolean }>(
      'SELECT id,role,active,email_verified_at,phone_verified_at,registration_approval_state FROM users WHERE id=$1 FOR UPDATE',
      [actor.id],
      sql,
    );
    if (!current?.active || current.registration_approval_state !== 'approved')
      throw new ForbiddenException('Staff access unavailable');
    verified(current);
    const [session] = await this.db.rows(
      'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
      [actor.session_id, actor.id],
      sql,
    );
    if (!session) throw new ForbiddenException('Staff session unavailable');
    if (current.role !== 'admin') {
      const [grant] = await this.db.rows(
        "SELECT user_id FROM staff_permission_grants WHERE user_id=$1 AND permission='registration.decide' FOR UPDATE",
        [actor.id],
        sql,
      );
      if (!grant) throw new ForbiddenException('Staff permission required');
    }
  }
  async decision(actor: Actor, id: string, body: unknown, key: unknown) {
    parse(uuid, id);
    const input = parse(decisionSchema, body);
    return this.idem.run(
      actor,
      `registration:${id}`,
      key,
      input,
      async (sql) => {
        const [reference] = await this.db.rows<{ user_id: string }>(
          'SELECT user_id FROM registration_approval_requests WHERE id=$1',
          [id],
          sql,
        );
        if (!reference) throw new NotFoundException();
        if (reference.user_id === actor.id)
          throw new ForbiddenException('Cannot review own registration');
        const [applicant] = await this.db.rows<Actor & { active: boolean }>(
          'SELECT id,active,email_verified_at,phone_verified_at,registration_approval_state FROM users WHERE id=$1 FOR UPDATE',
          [reference.user_id],
          sql,
        );
        const [request] = await this.db.rows<{ state: string }>(
          'SELECT state FROM registration_approval_requests WHERE id=$1 FOR UPDATE',
          [id],
          sql,
        );
        if (
          request?.state !== 'pending' ||
          applicant?.registration_approval_state !== 'pending'
        )
          throw new ConflictException('Stale registration request');
        if (input.decision === 'approve') {
          if (!applicant.active)
            throw new ConflictException('Applicant inactive');
          verified(applicant);
        }
        const state = input.decision === 'approve' ? 'approved' : 'rejected';
        const [result] = await this.db.rows(
          `UPDATE registration_approval_requests SET state=$2,reviewer_id=$3,reason=$4,resolved_at=now()
        WHERE id=$1 RETURNING id,user_id,state,reason,resolved_at`,
          [id, state, actor.id, input.reason],
          sql,
        );
        await sql.query(
          'UPDATE users SET registration_approval_state=$2,updated_at=now() WHERE id=$1',
          [reference.user_id, state],
        );
        if (state === 'rejected')
          await sql.query(
            'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
            [reference.user_id],
          );
        await this.audit.record(
          sql,
          actor.id,
          'admin.registration.decided',
          'user',
          reference.user_id,
          { requestId: id, state, reason: input.reason },
        );
        return result;
      },
      (sql) => this.authorize(sql, actor),
    );
  }
}
