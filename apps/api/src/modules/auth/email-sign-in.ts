import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
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
import { setTimeout as delay } from 'node:timers/promises';
import { hash, parse, passwordHash, token, uuid } from '../../common/security';
import { loadConfig } from '../../config';
import { Database, type Sql } from '../database/database';
import { Audit } from '../audit/audit';
import {
  emailSignInAvailable,
  EmailSignInDelivery,
} from './email-sign-in-delivery';
import { phoneOtpKeySchema } from './phone-otp';
import { SMTP_DEADLINE_MS, SmtpServiceUnavailable } from './reset-smtp';

export const emailSignInRequestSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .pipe(z.email().max(254))
    .transform((v) => v.toLowerCase()),
  browserKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const emailSignInConfirmSchema = emailSignInRequestSchema.extend({
  challengeId: uuid,
  code: z.string().regex(/^[0-9]{6}$/),
  registrationRole: z
    .enum(['buyer', 'owner', 'agent', 'agency', 'developer'])
    .optional(),
  existingOnly: z.literal(true).optional(),
});
export const emailSignInRequestResultSchema = z.strictObject({
  challengeId: uuid,
  expiresAt: z.iso.datetime(),
  resendAfter: z.iso.datetime(),
});
type RequestResult = z.infer<typeof emailSignInRequestResultSchema>;
interface Challenge {
  dispatch_state: 'sending' | 'receipt' | 'unavailable';
  id: string;
  destination_digest: string;
  created_at: Date;
  expires_at: Date;
}
function receipt(row: Challenge): RequestResult {
  return {
    challengeId: row.id,
    expiresAt: row.expires_at.toISOString(),
    resendAfter: new Date(row.created_at.getTime() + 60000).toISOString(),
  };
}
function signingKey() {
  const cfg = loadConfig();
  if (!emailSignInAvailable(cfg))
    throw new ServiceUnavailableException('Email sign-in unavailable');
  return Buffer.from(cfg.EMAIL_SIGN_IN_PEPPER!, 'base64url');
}
function digest(secret: Buffer, ...parts: string[]) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['raui.email-sign-in.v1', ...parts]))
    .digest('hex');
}
// All budget checks and allocations for an address serialize across browsers.
async function lockDestination(sql: Sql, dest: string) {
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'email-sign-in:' + dest,
  ]);
}
const eligible = `u.active AND u.email_verified_at IS NOT NULL AND u.registration_approval_state IN ('approved','pending')
  AND u.role IN ('buyer','owner','agent','agency','developer') AND NOT EXISTS(SELECT FROM staff_permission_grants g WHERE g.user_id=u.id)`;
async function retryDelay(sql: Sql, dest: string) {
  const {
    rows: [row],
  } = await sql.query<{ delay: number }>(
    `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t),
    sends AS (SELECT count(*) AS n,max(created_at) AS last,min(created_at) AS first FROM email_sign_in_challenges,clock
              WHERE destination_digest=$1 AND created_at>clock.t-interval '1 hour'),
    guesses AS (SELECT count(*) AS n,min(occurred_at) AS first FROM email_sign_in_failures,clock
              WHERE destination_digest=$1 AND occurred_at>clock.t-interval '1 hour')
    SELECT ceil(extract(epoch FROM greatest(clock.t,sends.last+interval '60 seconds',
      CASE WHEN sends.n>=5 THEN sends.first+interval '1 hour' END, CASE WHEN guesses.n>=5 THEN guesses.first+interval '1 hour' END)-clock.t))::int AS delay
    FROM clock,sends,guesses`,
    [dest],
  );
  return row!.delay;
}
@Injectable()
export class EmailSignInService {
  private readonly logger = new Logger(EmailSignInService.name);
  constructor(
    private readonly db: Database,
    private readonly mail: EmailSignInDelivery,
    private readonly audit: Audit,
  ) {}
  private async replay(row: Challenge) {
    // The allocating request commits before SMTP, so a replay can arrive while
    // mail is in flight. Hold no database connection during the bounded wait.
    const maxWait = SMTP_DEADLINE_MS + 1000;
    const age = Math.max(0, Date.now() - row.created_at.getTime());
    const until = performance.now() + Math.max(0, maxWait - age);
    let state = row.dispatch_state;
    for (let wait = 100; state === 'sending' && performance.now() < until;) {
      await delay(Math.min(wait, until - performance.now()));
      const [latest] = await this.db.rows<Pick<Challenge, 'dispatch_state'>>(
        'SELECT dispatch_state FROM email_sign_in_challenges WHERE id=$1',
        [row.id],
      );
      state = latest?.dispatch_state ?? 'receipt';
      wait = Math.min(wait * 2, 800);
    }
    if (state === 'unavailable')
      throw new ServiceUnavailableException('Email sign-in unavailable');
    // If the sender stopped before recording an outcome, SMTP might already
    // have accepted the message. The old receipt is safe to return and reuse.
    return receipt(row);
  }
  async request(body: unknown, key: unknown) {
    const { email, browserKey } = parse(emailSignInRequestSchema, body),
      request = hash(parse(phoneOtpKeySchema, key));
    const secret = signingKey(),
      dest = digest(secret, 'address', email),
      browser = hash(browserKey);
    const allocation = await this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'email-sign-in-key:' + browser + ':' + request,
      ]);
      await lockDestination(sql, dest);
      const [prior] = await this.db.rows<Challenge>(
        'SELECT id,destination_digest,created_at,expires_at,dispatch_state FROM email_sign_in_challenges WHERE browser_digest=$1 AND request_digest=$2',
        [browser, request],
        sql,
      );
      if (prior) {
        if (prior.destination_digest !== dest)
          throw new ConflictException(
            'Idempotency key reused with another payload',
          );
        return { row: prior, code: null };
      }
      const retryAfterSeconds = await retryDelay(sql, dest);
      if (retryAfterSeconds > 0)
        throw new HttpException(
          {
            code: 'email_sign_in_rate_limited',
            message: 'Try again later',
            retryAfterSeconds,
          },
          429,
        );
      // Lock the account before writing challenges: credential updates follow
      // the same order through the trigger, including writes by older clients.
      const [user] = await this.db.rows<{ id: string }>(
        'SELECT id FROM users WHERE email=$1 FOR UPDATE',
        [email],
        sql,
      );
      const [identity] = await this.db.rows<{ allowed: boolean }>(
        `SELECT ${eligible} AS allowed FROM users u WHERE u.id=$1`,
        [user?.id ?? null],
        sql,
      );
      await sql.query(
        'UPDATE email_sign_in_challenges SET used_at=clock_timestamp() WHERE browser_digest=$1 AND destination_digest=$2 AND used_at IS NULL',
        [browser, dest],
      );
      const id = randomUUID(),
        code = randomInt(1000000).toString().padStart(6, '0');
      const [row] = await this.db.rows<Challenge>(
        `INSERT INTO email_sign_in_challenges(id,user_id,destination_digest,browser_digest,request_digest,code_digest,eligible_at_request,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,t,t+interval '1 hour' FROM (SELECT clock_timestamp() t) stamp RETURNING id,destination_digest,created_at,expires_at,dispatch_state`,
        [
          id,
          user?.id ?? null,
          dest,
          browser,
          request,
          digest(secret, 'code', id, browser, dest, code),
          identity?.allowed ?? true,
        ],
        sql,
      );
      return { row: row!, code };
    });
    if (allocation.code === null) return this.replay(allocation.row);
    try {
      await this.mail.send(email, allocation.code);
    } catch (error) {
      if (error instanceof SmtpServiceUnavailable) {
        await this.db.pool.query(
          "UPDATE email_sign_in_challenges SET dispatch_state='unavailable', used_at=coalesce(used_at,clock_timestamp()) WHERE id=$1",
          [allocation.row.id],
        );
        this.logger.warn('email_sign_in_smtp_unavailable');
        throw new ServiceUnavailableException('Email sign-in unavailable');
      }
      // A lost DATA acknowledgement can follow acceptance.
    }
    await this.db.pool.query(
      "UPDATE email_sign_in_challenges SET dispatch_state='receipt' WHERE id=$1",
      [allocation.row.id],
    );
    return receipt(allocation.row);
  }
  async confirm<T>(
    body: unknown,
    issue: (sql: Sql, userId: string) => Promise<T>,
  ): Promise<T> {
    const {
      email,
      browserKey,
      challengeId,
      code,
      registrationRole,
      existingOnly,
    } = parse(emailSignInConfirmSchema, body);
    const secret = signingKey(),
      dest = digest(secret, 'address', email),
      browser = hash(browserKey);
    const session = await this.db.transaction(async (sql) => {
      await lockDestination(sql, dest);
      const [user] = await this.db.rows<{ id: string }>(
        'SELECT id FROM users WHERE email=$1 FOR UPDATE',
        [email],
        sql,
      );
      const [challenge] = await this.db.rows<{
        code_digest: string;
        user_id: string | null;
        eligible_at_request: boolean;
      }>(
        `SELECT user_id,code_digest,eligible_at_request FROM email_sign_in_challenges
        WHERE id=$1 AND browser_digest=$2 AND destination_digest=$3 AND used_at IS NULL AND attempts<5 AND expires_at>clock_timestamp() FOR UPDATE`,
        [challengeId, browser, dest],
        sql,
      );
      if (!challenge) return null;
      const [budget] = await this.db.rows<{ ok: boolean }>(
        "SELECT count(*)<5 AS ok FROM email_sign_in_failures WHERE destination_digest=$1 AND occurred_at>clock_timestamp()-interval '1 hour'",
        [dest],
        sql,
      );
      if (!budget?.ok) return null;
      if (
        !timingSafeEqual(
          Buffer.from(challenge.code_digest, 'hex'),
          Buffer.from(
            digest(secret, 'code', challengeId, browser, dest, code),
            'hex',
          ),
        )
      ) {
        await sql.query(
          'UPDATE email_sign_in_challenges SET attempts=attempts+1 WHERE id=$1',
          [challengeId],
        );
        await sql.query(
          'INSERT INTO email_sign_in_failures(destination_digest) VALUES($1)',
          [dest],
        );
        return null;
      }
      const consumed = await sql.query(
        'UPDATE email_sign_in_challenges SET used_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp() AND used_at IS NULL',
        [challengeId],
      );
      if (!consumed.rowCount || !challenge.eligible_at_request) return null;
      if (challenge.user_id) {
        if (user?.id !== challenge.user_id) return null;
        const current = await sql.query(
          `SELECT 1 FROM users u WHERE u.id=$1 AND ${eligible}`,
          [user.id],
        );
        return current.rowCount ? issue(sql, user.id) : null;
      }
      if (existingOnly || user) return null;
      // Generate an inaccessible random password; the owner can later choose
      // their password via the independent, verified email reset flow.
      const {
        rows: [created],
      } = await sql.query<{ id: string }>(
        `INSERT INTO users(email,display_name,password_hash,role,email_verified_at,registration_approval_state)
        VALUES($1,'Пользователь',$2,$3,clock_timestamp(),'pending') ON CONFLICT(email) DO NOTHING RETURNING id`,
        [email, await passwordHash(token()), registrationRole ?? 'buyer'],
      );
      if (!created) return null;
      await sql.query(
        'INSERT INTO registration_approval_requests(user_id) VALUES($1)',
        [created.id],
      );
      await this.audit.record(
        sql,
        created.id,
        'auth.registered',
        'user',
        created.id,
      );
      return issue(sql, created.id);
    });
    if (!session) throw new UnauthorizedException('Invalid or expired code');
    return session;
  }
}
