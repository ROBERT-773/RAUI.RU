import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { Actor, hash, parse } from '../../common/security';
import { loadConfig, phoneOtpCapability } from '../../config';
import { Audit } from '../audit/audit';
import { Database, Sql } from '../database/database';
import { PhoneOtpDelivery, PhoneOtpDispatch } from './phone-otp-delivery';
export interface PhoneOtpRequestResult {
  challengeId: string;
  expiresAt: string;
  resendAfter: string;
  delivery: PhoneOtpDispatch;
}
export const phoneOtpKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const phoneOtpRequestSchema = z
  .object({ phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/) })
  .strict();
export const phoneOtpConfirmSchema = z
  .object({ challengeId: z.uuid(), code: z.string().regex(/^[0-9]{6}$/) })
  .strict();
const scope = 'phone-otp-request';
export function phoneOtpDigest(
  pepper: Buffer,
  id: string,
  user: string,
  destination: string,
  code: string,
) {
  return createHmac('sha256', pepper)
    .update(JSON.stringify(['raui.phone-otp.v1', id, user, destination, code]))
    .digest('hex');
}
export function phoneOtpDestinationDigest(pepper: Buffer, destination: string) {
  return createHmac('sha256', pepper)
    .update(JSON.stringify(['raui.phone-otp.destination.v1', destination]))
    .digest('hex');
}
export async function lockPhoneOtpActor(sql: Sql, actor: Actor) {
  // Serialize identity changes while permitting audit/session FK KEY SHARE locks.
  // A key-changing contact UPDATE happens only after our session lock is acquired.
  const users = await sql.query(
    'SELECT id,active,registration_approval_state FROM users WHERE id=$1 FOR NO KEY UPDATE',
    [actor.id],
  );
  const user = users.rows[0];
  if (!user?.active) throw new UnauthorizedException();
  if (
    !['pending', 'approved'].includes(
      user.registration_approval_state as string,
    )
  )
    throw new ForbiddenException();
  const sessions = await sql.query(
    'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',
    [actor.session_id, actor.id],
  );
  if (!sessions.rowCount) throw new UnauthorizedException();
  // Row-lock acquisition can outlast a session without changing its tuple.
  // Evaluate wall time again after the lock, rather than accepting a stale predicate.
  const current = await sql.query(
    'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
    [actor.session_id, actor.id],
  );
  if (!current.rowCount) throw new UnauthorizedException();
}
export async function invalidatePhoneChallenges(sql: Sql, userId: string) {
  await sql.query(
    "UPDATE auth_challenges SET used_at=clock_timestamp() WHERE user_id=$1 AND purpose='phone' AND used_at IS NULL",
    [userId],
  );
  await sql.query(
    'UPDATE phone_otp_challenges SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL AND invalidated_at IS NULL',
    [userId],
  );
}
export async function reservePhoneOtpSend(
  sql: Sql,
  userId: string,
  destination: string,
) {
  const cfg = loadConfig();
  if (!phoneOtpCapability(cfg).available) return;
  const digest = phoneOtpDestinationDigest(
    Buffer.from(cfg.PHONE_OTP_PEPPER!, 'base64url'),
    destination,
  );
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'phone-otp-destination:' + digest,
  ]);
  const { rows } = await sql.query<{ retry: number }>(
    `WITH moment AS (SELECT clock_timestamp() AS t),
 recent AS (SELECT e.*,m.t FROM phone_otp_send_events e CROSS JOIN moment m WHERE e.created_at>m.t-interval '1 hour' AND (e.user_id=$1 OR e.destination_digest=$2)),
 limits AS (SELECT max(created_at) FILTER (WHERE user_id=$1) AS latest,
 count(*) FILTER (WHERE user_id=$1) AS own_count, count(*) FILTER (WHERE destination_digest=$2) AS dest_count,
 min(created_at) FILTER (WHERE user_id=$1) AS own_first, min(created_at) FILTER (WHERE destination_digest=$2) AS dest_first FROM recent)
 SELECT ceil(greatest(0,extract(epoch FROM latest+interval '60 seconds'-t),
 CASE WHEN own_count>=5 THEN extract(epoch FROM own_first+interval '1 hour'-t) ELSE 0 END,
 CASE WHEN dest_count>=5 THEN extract(epoch FROM dest_first+interval '1 hour'-t) ELSE 0 END))::integer AS retry FROM limits CROSS JOIN moment`,
    [userId, digest],
  );
  const retry = rows[0]?.retry ?? 0;
  if (retry > 0)
    throw new HttpException(
      {
        code: 'phone_otp_rate_limited',
        retryAfterSeconds: retry,
        message: 'Phone verification temporarily unavailable',
      },
      429,
    );
  await sql.query(
    'INSERT INTO phone_otp_send_events(id,user_id,destination_digest,created_at) VALUES($1,$2,$3,clock_timestamp())',
    [randomUUID(), userId, digest],
  );
}
@Injectable()
export class PhoneOtpService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly delivery: PhoneOtpDelivery,
  ) {}
  async capabilities(actor: Actor) {
    await this.db.transaction((sql) => lockPhoneOtpActor(sql, actor));
    return {
      numericOtp: phoneOtpCapability(loadConfig()),
      legacyToken: { available: true as const },
    };
  }
  private async keyLock(sql: Sql, actor: Actor, key: string) {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.id + ':' + scope + ':' + key,
    ]);
    await lockPhoneOtpActor(sql, actor);
  }
  async request(
    actor: Actor,
    body: unknown,
    key: unknown,
  ): Promise<PhoneOtpRequestResult> {
    const input = parse(phoneOtpRequestSchema, body),
      normalized = parse(phoneOtpKeySchema, key);
    const cfg = loadConfig();
    if (!phoneOtpCapability(cfg).available)
      throw new ServiceUnavailableException({
        code: 'phone_otp_unavailable',
        message: 'Phone verification unavailable',
      });
    const fingerprint = hash(JSON.stringify(input));
    let code: string | undefined;
    const allocation = await this.db.transaction(async (sql) => {
      await this.keyLock(sql, actor, normalized);
      const prior = (
        await sql.query<{
          request_hash: string;
          response: PhoneOtpRequestResult;
        }>(
          'SELECT request_hash,response FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND key=$3',
          [actor.id, scope, normalized],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new ConflictException(
            'Idempotency key reused with another payload',
          );
        return prior.response;
      }
      await reservePhoneOtpSend(sql, actor.id, input.phone);
      await invalidatePhoneChallenges(sql, actor.id);
      code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const id = randomUUID();
      const digest = phoneOtpDigest(
        Buffer.from(cfg.PHONE_OTP_PEPPER!, 'base64url'),
        id,
        actor.id,
        input.phone,
        code,
      );
      const row = (
        await sql.query<{ expires_at: Date; created_at: Date }>(
          `INSERT INTO phone_otp_challenges(id,user_id,destination,code_digest,created_at,expires_at)
 SELECT $1,$2,$3,$4,t,t+interval '5 minutes' FROM (SELECT clock_timestamp() t) m RETURNING expires_at,created_at`,
          [id, actor.id, input.phone, digest],
        )
      ).rows[0]!;
      const result: PhoneOtpRequestResult = {
        challengeId: id,
        expiresAt: row.expires_at.toISOString(),
        resendAfter: new Date(row.created_at.getTime() + 60_000).toISOString(),
        delivery: 'unknown',
      };
      await sql.query(
        'INSERT INTO idempotency_records(actor_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)',
        [actor.id, scope, normalized, fingerprint, JSON.stringify(result)],
      );
      await this.audit.record(
        sql,
        actor.id,
        'auth.phone_otp.requested',
        'phone_otp',
        id,
      );
      return result;
    });
    if (!code) return allocation;
    const claimed = await this.db.transaction(async (sql) => {
      await this.keyLock(sql, actor, normalized);
      return (
        (
          await sql.query(
            `UPDATE phone_otp_challenges SET dispatch_state='unknown' WHERE id=$1 AND user_id=$2 AND dispatch_state='pending' AND used_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
            [allocation.challengeId, actor.id],
          )
        ).rowCount === 1
      );
    });
    if (!claimed) return allocation;
    let delivery: PhoneOtpDispatch = 'unknown';
    try {
      delivery = await this.delivery.send({
        version: 1,
        challengeId: allocation.challengeId,
        destination: input.phone,
        code,
        expiresAt: allocation.expiresAt,
      });
    } catch {
      /* Do not leak provider error. */
    }
    code = undefined;
    const result = { ...allocation, delivery };
    await this.db.transaction(async (sql) => {
      await this.keyLock(sql, actor, normalized);
      await sql.query(
        'UPDATE phone_otp_challenges SET dispatch_state=$2 WHERE id=$1',
        [allocation.challengeId, delivery],
      );
      await sql.query(
        'UPDATE idempotency_records SET response=$4 WHERE actor_id=$1 AND scope=$2 AND key=$3',
        [actor.id, scope, normalized, JSON.stringify(result)],
      );
    });
    return result;
  }
  async confirm(actor: Actor, body: unknown): Promise<{ verified: true }> {
    const input = parse(phoneOtpConfirmSchema, body);
    const cfg = loadConfig();
    if (!phoneOtpCapability(cfg).available)
      throw new ServiceUnavailableException({
        code: 'phone_otp_unavailable',
        message: 'Phone verification unavailable',
      });
    const outcome = await this.db.transaction(async (sql) => {
      await lockPhoneOtpActor(sql, actor);
      const row = (
        await sql.query<{
          destination: string;
          code_digest: string;
          eligible: boolean;
        }>(
          `SELECT destination,code_digest,(used_at IS NULL AND invalidated_at IS NULL AND attempts<5 AND expires_at>clock_timestamp()) eligible FROM phone_otp_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE`,
          [input.challengeId, actor.id],
        )
      ).rows[0];
      const eligible =
        row &&
        (
          await sql.query<{ eligible: boolean }>(
            'SELECT used_at IS NULL AND invalidated_at IS NULL AND attempts<5 AND expires_at>clock_timestamp() eligible FROM phone_otp_challenges WHERE id=$1',
            [input.challengeId],
          )
        ).rows[0]?.eligible;
      if (!eligible || !row) return 'invalid';
      const expected = Buffer.from(
          phoneOtpDigest(
            Buffer.from(cfg.PHONE_OTP_PEPPER!, 'base64url'),
            input.challengeId,
            actor.id,
            row.destination,
            input.code,
          ),
          'hex',
        ),
        actual = Buffer.from(row.code_digest, 'hex');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        await sql.query(
          'UPDATE phone_otp_challenges SET attempts=attempts+1,invalidated_at=CASE WHEN attempts+1>=5 THEN clock_timestamp() ELSE invalidated_at END WHERE id=$1',
          [input.challengeId],
        );
        return 'invalid';
      }
      await sql.query('SAVEPOINT phone_otp_contact');
      try {
        await sql.query(
          'UPDATE users SET phone=$2,phone_verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',
          [actor.id, row.destination],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await sql.query('ROLLBACK TO SAVEPOINT phone_otp_contact');
        await sql.query(
          'UPDATE phone_otp_challenges SET invalidated_at=clock_timestamp() WHERE id=$1',
          [input.challengeId],
        );
        return 'conflict';
      }
      await sql.query('RELEASE SAVEPOINT phone_otp_contact');
      await sql.query(
        'UPDATE phone_otp_challenges SET used_at=clock_timestamp() WHERE id=$1',
        [input.challengeId],
      );
      await invalidatePhoneChallenges(sql, actor.id);
      await this.audit.record(
        sql,
        actor.id,
        'auth.phone_otp.confirmed',
        'phone_otp',
        input.challengeId,
      );
      return 'verified';
    });
    if (outcome === 'conflict')
      throw new ConflictException({
        code: 'phone_otp_contact_unavailable',
        message: 'Phone contact unavailable',
      });
    if (outcome !== 'verified')
      throw new BadRequestException({
        code: 'phone_otp_invalid',
        message: 'Invalid or expired code',
      });
    return { verified: true };
  }
}
