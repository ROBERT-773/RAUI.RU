import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Actor } from '../../common/security';
import { passwordMatches, verified } from '../../common/security';
import type { Database } from '../database/database';
import {
  matchingTotpStep,
  openStaffTotpSecret,
  sealStaffTotpSecret,
} from './staff-totp';

function base32(secret: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export async function beginStaffTotp(
  db: Database,
  actor: Actor,
  password: string,
  encryptionKey: Buffer,
): Promise<{ secret: string; expiresAt: string }> {
  verified(actor);
  const [user] = await db.rows<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id=$1 AND active',
    [actor.id],
  );
  if (!user || !(await passwordMatches(password, user.password_hash)))
    throw new ForbiddenException('Staff credentials invalid');
  const secret = randomBytes(20);
  try {
    const [enrollment] = await db.rows<{ expires_at: Date }>(
      `INSERT INTO staff_totp_factors(user_id,encrypted_secret,enrollment_session_id,enrollment_expires_at)
       SELECT u.id,$3,s.id,clock_timestamp()+interval '10 minutes'
         FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=$1 AND s.id=$2 AND u.active AND u.password_hash=$4
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND (u.role='admin' OR EXISTS (
            SELECT 1 FROM staff_permission_grants g WHERE g.user_id=u.id
          ))
       ON CONFLICT (user_id) DO UPDATE SET
          encrypted_secret=EXCLUDED.encrypted_secret,
          id=EXCLUDED.id,
          enrollment_session_id=EXCLUDED.enrollment_session_id,
          enrollment_expires_at=EXCLUDED.enrollment_expires_at
        WHERE staff_totp_factors.activated_at IS NULL
       RETURNING enrollment_expires_at AS expires_at`,
      [
        actor.id,
        actor.session_id,
        sealStaffTotpSecret(secret, encryptionKey, actor.id),
        user.password_hash,
      ],
    );
    if (!enrollment)
      throw new ConflictException('Staff enrollment unavailable');
    return {
      secret: base32(secret),
      expiresAt: enrollment.expires_at.toISOString(),
    };
  } finally {
    secret.fill(0);
  }
}

export async function confirmStaffTotp(
  db: Database,
  actor: Actor,
  code: string,
  encryptionKey: Buffer,
  enrollment = false,
): Promise<void> {
  await db.transaction(async (sql) => {
    const [factor] = await db.rows<{
      id: string;
      encrypted_secret: string;
      last_verified_step: string | null;
      unix_seconds: string;
    }>(
      `SELECT f.id, f.encrypted_secret, f.last_verified_step,
              floor(extract(epoch from clock_timestamp()))::bigint AS unix_seconds
         FROM staff_totp_factors f JOIN users u ON u.id=f.user_id
        WHERE f.user_id=$1 AND u.active
          AND (CASE WHEN $2 THEN f.activated_at IS NULL
                 AND f.enrollment_session_id=$3
                 AND f.enrollment_expires_at>clock_timestamp()
               ELSE f.activated_at IS NOT NULL END)
          AND (u.role='admin' OR EXISTS (
            SELECT 1 FROM staff_permission_grants g WHERE g.user_id=u.id
          ))
        FOR UPDATE OF f`,
      [actor.id, enrollment, actor.session_id],
      sql,
    );
    if (!factor) throw new ForbiddenException('Staff factor unavailable');

    const secret = openStaffTotpSecret(
      factor.encrypted_secret,
      encryptionKey,
      actor.id,
    );
    let step: number | null;
    try {
      step = matchingTotpStep(secret, code, Number(factor.unix_seconds));
    } finally {
      secret.fill(0);
    }
    if (
      step === null ||
      (factor.last_verified_step !== null &&
        step <= Number(factor.last_verified_step))
    )
      throw new ForbiddenException('Invalid staff verification code');

    const session = await sql.query(
      `UPDATE sessions
          SET staff_totp_factor_id=$3,
              staff_assured_until=least(expires_at, clock_timestamp() + interval '15 minutes')
        WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [actor.session_id, actor.id, factor.id],
    );
    if (session.rowCount !== 1)
      throw new ForbiddenException('Staff session unavailable');

    await sql.query(
      `UPDATE staff_totp_factors
          SET last_verified_step=$2, activated_at=coalesce(activated_at, clock_timestamp()),
              enrollment_session_id=NULL
        WHERE id=$1`,
      [factor.id, step],
    );
  });
}
