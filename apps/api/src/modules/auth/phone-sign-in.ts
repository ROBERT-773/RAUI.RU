import {
  ConflictException,
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
import { hash, parse, token } from '../../common/security';
import { loadConfig, phoneOtpCapability } from '../../config';
import { Database, type Sql } from '../database/database';
import {
  phoneOtpConfirmSchema,
  phoneOtpDestinationDigest,
  phoneOtpKeySchema,
  phoneOtpRequestSchema,
  reservePhoneOtpSend,
  type PhoneOtpRequestResult,
} from './phone-otp';
import { PhoneOtpDelivery, type PhoneOtpDispatch } from './phone-otp-delivery';

const browserKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const phoneSignInRequestSchema = phoneOtpRequestSchema.extend({
  browserKey,
});
export const phoneSignInConfirmSchema = phoneOtpConfirmSchema.extend(
  phoneSignInRequestSchema.shape,
);
export const phoneSignInSignupProofSchema = phoneSignInRequestSchema.extend({
  signupToken: browserKey,
});

export function phoneSignInAvailable(config = loadConfig()) {
  return (
    config.PHONE_SIGN_IN_ENABLED === 'true' &&
    phoneOtpCapability(config).available
  );
}

interface Challenge {
  id: string;
  destination_digest: string;
  created_at: Date;
  expires_at: Date;
  dispatch_state: 'pending' | PhoneOtpDispatch;
}

function requestResult(row: Challenge): PhoneOtpRequestResult {
  return {
    challengeId: row.id,
    expiresAt: row.expires_at.toISOString(),
    resendAfter: new Date(row.created_at.getTime() + 60_000).toISOString(),
    delivery: row.dispatch_state === 'pending' ? 'unknown' : row.dispatch_state,
  };
}

function codeDigest(
  pepper: Buffer,
  id: string,
  browser: string,
  destination: string,
  code: string,
) {
  return createHmac('sha256', pepper)
    .update(
      JSON.stringify(['raui.phone-sign-in.v1', id, browser, destination, code]),
    )
    .digest('hex');
}

@Injectable()
export class PhoneSignInService {
  constructor(
    private readonly db: Database,
    private readonly delivery: PhoneOtpDelivery,
  ) {}

  async request(body: unknown, key: unknown): Promise<PhoneOtpRequestResult> {
    const input = parse(phoneSignInRequestSchema, body);
    const requestKey = hash(parse(phoneOtpKeySchema, key));
    const config = loadConfig();
    if (!phoneSignInAvailable(config))
      throw new ServiceUnavailableException('SMS sign-in unavailable');
    const pepper = Buffer.from(config.PHONE_OTP_PEPPER!, 'base64url');
    const destination = phoneOtpDestinationDigest(pepper, input.phone);
    const browser = hash(input.browserKey);
    const allocation = await this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'phone-sign-in:' + browser + ':' + requestKey,
      ]);
      const prior = (
        await sql.query<Challenge>(
          'SELECT id,destination_digest,created_at,expires_at,dispatch_state FROM phone_sign_in_challenges WHERE browser_digest=$1 AND request_key_digest=$2',
          [browser, requestKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.destination_digest !== destination)
          throw new ConflictException(
            'Idempotency key reused with another payload',
          );
        return { row: prior, code: null };
      }

      // Allocate against the same destination budget as authenticated verification.
      await reservePhoneOtpSend(sql, null, input.phone);
      const id = randomUUID();
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const digest = codeDigest(pepper, id, browser, destination, code);
      const row = (
        await sql.query<Challenge>(
          `INSERT INTO phone_sign_in_challenges(
             id,user_id,destination_digest,browser_digest,request_key_digest,
             code_digest,created_at,expires_at,dispatch_state
           )
           SELECT $1,(SELECT id FROM users WHERE phone=$2),$3,$4,$5,$6,t,t+interval '5 minutes','unknown'
           FROM (SELECT clock_timestamp() t) moment
           RETURNING id,destination_digest,created_at,expires_at,dispatch_state`,
          [id, input.phone, destination, browser, requestKey, digest],
        )
      ).rows[0]!;
      return { row, code };
    });
    const result = requestResult(allocation.row);
    if (allocation.code === null) return result;

    // Only the original transaction returns the code. A retry never sends again.
    let delivery: PhoneOtpDispatch = 'unknown';
    try {
      delivery = await this.delivery.send({
        version: 1,
        challengeId: result.challengeId,
        destination: input.phone,
        code: allocation.code,
        expiresAt: result.expiresAt,
      });
    } catch {
      // A lost response may still represent a delivered message.
    }
    await this.db.pool.query(
      'UPDATE phone_sign_in_challenges SET dispatch_state=$2 WHERE id=$1',
      [result.challengeId, delivery],
    );
    return { ...result, delivery };
  }

  async confirm<T>(
    body: unknown,
    issueSession: (sql: Sql, userId: string) => Promise<T>,
    enrollmentUserId?: string,
  ) {
    const { challengeId, browserKey, code, phone } = parse(
      phoneSignInConfirmSchema,
      body,
    );
    const config = loadConfig();
    if (!phoneSignInAvailable(config))
      throw new ServiceUnavailableException('SMS sign-in unavailable');
    const pepper = Buffer.from(config.PHONE_OTP_PEPPER!, 'base64url');
    const browser = hash(browserKey);
    const destination = phoneOtpDestinationDigest(pepper, phone);
    const result = await this.db.transaction(async (sql) => {
      const binding = (
        await sql.query<{ user_id: string | null }>(
          'SELECT user_id FROM phone_sign_in_challenges WHERE id=$1 AND browser_digest=$2 AND destination_digest=$3',
          [challengeId, browser, destination],
        )
      ).rows[0];
      if (!binding) return null;
      if (enrollmentUserId && binding.user_id !== enrollmentUserId) return null;
      // Same order as account deletion, which cascades to challenges.
      if (binding.user_id)
        await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          binding.user_id,
        ]);
      const challenge = (
        await sql.query<{ code_digest: string; user_id: string | null }>(
          `SELECT code_digest,user_id FROM phone_sign_in_challenges
           WHERE id=$1 AND browser_digest=$2 AND destination_digest=$3
             AND used_at IS NULL AND attempts<5 AND expires_at>clock_timestamp()
             AND dispatch_state IN ('accepted','unknown')
           FOR UPDATE`,
          [challengeId, browser, destination],
        )
      ).rows[0];
      if (!challenge) return null;
      const expected = codeDigest(
        pepper,
        challengeId,
        browser,
        destination,
        code,
      );
      if (
        !timingSafeEqual(
          Buffer.from(expected, 'hex'),
          Buffer.from(challenge.code_digest, 'hex'),
        )
      ) {
        await sql.query(
          'UPDATE phone_sign_in_challenges SET attempts=attempts+1 WHERE id=$1 AND expires_at>clock_timestamp()',
          [challengeId],
        );
        return null;
      }
      const consumed = await sql.query(
        'UPDATE phone_sign_in_challenges SET used_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp()',
        [challengeId],
      );
      if (!consumed.rowCount) return null;
      if (challenge.user_id) {
        const eligible = await sql.query(
          `SELECT 1 FROM users u WHERE u.id=$1 AND u.phone=$2 AND u.phone_verified_at IS NOT NULL
             AND u.active AND u.registration_approval_state IN ('pending','approved') AND u.role<>'admin'
             AND (u.phone_sign_in_enrolled_at IS NOT NULL OR u.id=$3)
             AND NOT EXISTS (SELECT 1 FROM staff_permission_grants g WHERE g.user_id=u.id)`,
          [challenge.user_id, phone, enrollmentUserId ?? null],
        );
        if (!eligible.rowCount) return null;
        return {
          kind: 'session' as const,
          session: await issueSession(sql, challenge.user_id),
        };
      }
      if (
        (await sql.query('SELECT 1 FROM users WHERE phone=$1', [phone]))
          .rowCount
      )
        return null;
      const signupToken = token();
      await sql.query(
        "UPDATE phone_sign_in_challenges SET signup_digest=$2,signup_expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1",
        [challengeId, hash(signupToken)],
      );
      return { kind: 'signup' as const, signupToken };
    });
    if (!result) throw new UnauthorizedException('Invalid or expired SMS code');
    return result;
  }

  private signupBinding(proof: z.infer<typeof phoneSignInSignupProofSchema>) {
    const config = loadConfig();
    if (!phoneSignInAvailable(config))
      throw new ServiceUnavailableException('SMS sign-in unavailable');
    const destination = phoneOtpDestinationDigest(
      Buffer.from(config.PHONE_OTP_PEPPER!, 'base64url'),
      proof.phone,
    );
    return [hash(proof.signupToken), hash(proof.browserKey), destination];
  }

  async checkSignup(proof: z.infer<typeof phoneSignInSignupProofSchema>) {
    const available = await this.db.pool.query(
      `SELECT 1 FROM phone_sign_in_challenges
       WHERE signup_digest=$1 AND browser_digest=$2 AND destination_digest=$3
         AND signup_used_at IS NULL AND signup_expires_at>clock_timestamp()`,
      this.signupBinding(proof),
    );
    if (!available.rowCount)
      throw new UnauthorizedException('Invalid or expired SMS registration');
  }

  async consumeSignup(
    sql: Sql,
    proof: z.infer<typeof phoneSignInSignupProofSchema>,
  ) {
    const binding = this.signupBinding(proof);
    await sql.query(
      'SELECT id FROM phone_sign_in_challenges WHERE signup_digest=$1 AND browser_digest=$2 AND destination_digest=$3 FOR UPDATE',
      binding,
    );
    const consumed = await sql.query(
      `UPDATE phone_sign_in_challenges SET signup_used_at=clock_timestamp()
       WHERE signup_digest=$1 AND browser_digest=$2 AND destination_digest=$3
         AND signup_used_at IS NULL AND signup_expires_at>clock_timestamp()
       RETURNING id`,
      binding,
    );
    if (!consumed.rowCount)
      throw new UnauthorizedException('Invalid or expired SMS registration');
  }
}
