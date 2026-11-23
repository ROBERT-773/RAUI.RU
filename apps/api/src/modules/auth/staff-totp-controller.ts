import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  type Actor,
  CurrentActor,
  parse,
  verified,
} from '../../common/security';
import { loadConfig } from '../../config';
import { Database } from '../database/database';
import { beginStaffTotp, confirmStaffTotp } from './staff-assurance';

export const staffTotpEnrollmentInput = z
  .object({
    password: z.string().min(12).max(128),
  })
  .strict();
export const staffTotpCodeInput = z
  .object({
    code: z
      .string()
      .length(6)
      .regex(/^\d{6}$/),
  })
  .strict();

@Controller('v1/auth/staff-totp')
export class StaffTotpController {
  constructor(private readonly db: Database) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(@CurrentActor() actor: Actor) {
    verified(actor);
    const [state] = await this.db.rows<{
      enrolled: boolean;
      assuredUntil: Date | null;
    }>(
      `SELECT f.activated_at IS NOT NULL AS enrolled,
              CASE WHEN f.activated_at IS NOT NULL AND f.id=s.staff_totp_factor_id
                AND s.staff_assured_until>clock_timestamp()
                THEN s.staff_assured_until END AS "assuredUntil"
         FROM users u JOIN sessions s ON s.user_id=u.id
         LEFT JOIN staff_totp_factors f ON f.user_id=u.id
        WHERE u.id=$1 AND s.id=$2 AND u.active AND s.revoked_at IS NULL
          AND s.expires_at>clock_timestamp()
          AND (u.role='admin' OR EXISTS (
            SELECT 1 FROM staff_permission_grants g WHERE g.user_id=u.id
          ))`,
      [actor.id, actor.session_id],
    );
    if (!state) throw new ForbiddenException('Staff permissions required');
    const config = loadConfig();
    return {
      enrolled: state.enrolled,
      assuredUntil: state.assuredUntil?.toISOString() ?? null,
      available: Boolean(config.STAFF_TOTP_ENCRYPTION_KEY),
      required: config.STAFF_TOTP_REQUIRED === 'true',
    };
  }

  private async attempt(actor: Actor) {
    verified(actor);
    const key = loadConfig().STAFF_TOTP_ENCRYPTION_KEY;
    if (!key)
      throw new ServiceUnavailableException('Staff verification unavailable');
    const [limit] = await this.db.rows<{ count: number }>(
      `INSERT INTO rate_limits(key,count,reset_at)
       VALUES($1,1,now()+interval '1 minute')
       ON CONFLICT(key) DO UPDATE SET
         count=CASE WHEN rate_limits.reset_at<=now() THEN 1 ELSE least(rate_limits.count,6)+1 END,
         reset_at=CASE WHEN rate_limits.reset_at<=now() THEN now()+interval '1 minute' ELSE rate_limits.reset_at END
       RETURNING count`,
      ['staff-totp:' + actor.id],
    );
    if (!limit || limit.count > 5)
      throw new HttpException('Rate limit exceeded', 429);
    return Buffer.from(key, 'hex');
  }

  @Post('enroll')
  @Header('Cache-Control', 'no-store')
  async enroll(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const { password } = parse(staffTotpEnrollmentInput, body);
    const key = await this.attempt(actor);
    try {
      return await beginStaffTotp(this.db, actor, password, key);
    } finally {
      key.fill(0);
    }
  }

  @Post('activate')
  @HttpCode(204)
  activate(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.confirm(actor, body, true);
  }

  @Post('confirm')
  @HttpCode(204)
  verify(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.confirm(actor, body, false);
  }

  private async confirm(actor: Actor, body: unknown, enrollment: boolean) {
    const { code } = parse(staffTotpCodeInput, body);
    const key = await this.attempt(actor);
    try {
      await confirmStaffTotp(this.db, actor, code, key, enrollment);
    } finally {
      key.fill(0);
    }
  }
}
