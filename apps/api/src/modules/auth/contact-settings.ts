import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { loadConfig, phoneOtpCapability } from '../../config';
import { requireLivePhone } from './contact-guards';
import { Audit } from '../audit/audit';
import { Database, Sql } from '../database/database';
import {
  lockPhoneOtpActor,
  phoneOtpDigest,
  reservePhoneOtpSend,
} from './phone-otp';
import { PhoneOtpDelivery, PhoneOtpDispatch } from './phone-otp-delivery';

export const contactModeSchema = z.enum(['messages', 'calls', 'both']);
export const contactSettingsPatchSchema = z
  .object({ mode: contactModeSchema })
  .strict();
const contactPhoneInput = z.string().min(8).max(64);
const canonicalPhone = z
  .string()
  .regex(/^\+[1-9][0-9]{7,14}$/, 'Введите номер в международном формате.');
export const contactPhoneRequestSchema = z
  .object({ phone: contactPhoneInput })
  .strict();
export const contactPhoneVerifySchema = z
  .object({ phone: contactPhoneInput, code: z.string().regex(/^[0-9]{6}$/) })
  .strict();
export const contactSettingsSchema = z.object({
  mode: contactModeSchema,
  phones: z.array(
    z.object({ id: uuid, phone: canonicalPhone, primary: z.boolean() }),
  ),
});
export const contactPhoneRequestResultSchema = z.object({
  expiresAt: z.iso.datetime(),
  resendAfter: z.iso.datetime(),
  delivery: z.enum(['accepted', 'unknown']),
});
type Settings = z.infer<typeof contactSettingsSchema>;
type RequestResult = z.infer<typeof contactPhoneRequestResultSchema>;
type Challenge = {
  id: string;
  created_at: Date;
  expires_at: Date;
  delivery: PhoneOtpDispatch;
};

function normalizePhone(input: string) {
  const compact = input.replace(/[\s()-]/g, '');
  return parse(
    canonicalPhone,
    /^8\d{10}$/.test(compact) ? '+7' + compact.slice(1) : compact,
  );
}
function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'phone_otp_unavailable',
    message: 'Подтверждение номера по СМС временно недоступно.',
  });
}
function otpPepper() {
  const config = loadConfig();
  if (!phoneOtpCapability(config).available) unavailable();
  return Buffer.from(config.PHONE_OTP_PEPPER!, 'base64url');
}
function phoneLimit(): never {
  throw new ConflictException({
    code: 'contact_phone_limit',
    message: 'Уже добавлены два дополнительных номера.',
  });
}
function result(row: Challenge): RequestResult {
  if (row.delivery === 'unavailable') unavailable();
  return {
    expiresAt: row.expires_at.toISOString(),
    resendAfter: new Date(row.created_at.getTime() + 60000).toISOString(),
    delivery: row.delivery,
  };
}

@Injectable()
export class ContactSettingsService {
  constructor(
    private readonly db: Database,
    private readonly gateway: PhoneOtpDelivery,
    private readonly audit: Audit,
  ) {}

  private async lockSeller(sql: Sql, actor: Actor) {
    await lockPhoneOtpActor(sql, actor);
    const {
      rows: [user],
    } = await sql.query<Actor>(
      'SELECT role,email_verified_at,phone_verified_at,registration_approval_state FROM users WHERE id=$1',
      [actor.id],
    );
    if (!user || user.registration_approval_state !== 'approved')
      throw new ForbiddenException();
    seller(user);
  }
  private async settings(sql: Sql, userId: string): Promise<Settings> {
    const {
      rows: [settings],
    } = await sql.query<Settings>(
      `SELECT u.contact_mode AS mode, COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'phone',p.phone,'primary',p.slot=0) ORDER BY p.slot)
        FROM seller_contact_phones p WHERE p.user_id=u.id),'[]'::jsonb) AS phones
       FROM users u WHERE u.id=$1`,
      [userId],
    );
    if (!settings) throw new NotFoundException();
    return settings;
  }
  get(actor: Actor) {
    seller(actor);
    return this.settings(this.db.pool, actor.id);
  }
  change(actor: Actor, body: unknown) {
    const { mode } = parse(contactSettingsPatchSchema, body);
    return this.db.transaction(async (sql) => {
      await this.lockSeller(sql, actor);
      if (mode === 'calls') await requireLivePhone(sql, actor.id, null);
      const changed = await sql.query(
        'UPDATE users SET contact_mode=$2 WHERE id=$1 AND contact_mode<>$2',
        [actor.id, mode],
      );
      if (changed.rowCount)
        await this.audit.record(
          sql,
          actor.id,
          'account.contact_mode.changed',
          'user',
          actor.id,
          { mode },
        );
      return this.settings(sql, actor.id);
    });
  }
  private async freeSlot(sql: Sql, userId: string, phone: string) {
    const { rows } = await sql.query<{ slot: number; phone: string }>(
      'SELECT slot,phone FROM seller_contact_phones WHERE user_id=$1',
      [userId],
    );
    if (rows.some((row) => row.phone === phone))
      throw new ConflictException({
        code: 'contact_phone_exists',
        message: 'Этот номер уже подтверждён в вашем профиле.',
      });
    const slot = [1, 2].find((slot) => !rows.some((row) => row.slot === slot));
    if (!slot) phoneLimit();
    return slot;
  }
  async request(actor: Actor, body: unknown): Promise<RequestResult> {
    seller(actor);
    const phone = normalizePhone(parse(contactPhoneRequestSchema, body).phone);
    const pepper = otpPepper();
    const allocation = await this.db.transaction(async (sql) => {
      await this.lockSeller(sql, actor);
      await this.freeSlot(sql, actor.id, phone);
      await sql.query(
        'DELETE FROM seller_contact_phone_challenges WHERE user_id=$1 AND expires_at<=clock_timestamp()',
        [actor.id],
      );
      const {
        rows: [recent],
      } = await sql.query<Challenge>(
        `SELECT id,created_at,expires_at,delivery FROM seller_contact_phone_challenges
         WHERE user_id=$1 AND phone=$2 AND attempts<5 AND created_at>clock_timestamp()-interval '60 seconds'`,
        [actor.id, phone],
      );
      if (recent) return { row: recent };
      await reservePhoneOtpSend(sql, actor.id, phone);
      const id = randomUUID();
      const code = randomInt(1000000).toString().padStart(6, '0');
      const digest = phoneOtpDigest(
        pepper,
        id,
        'seller-contact:' + actor.id,
        phone,
        code,
      );
      const {
        rows: [row],
      } = await sql.query<Challenge>(
        `INSERT INTO seller_contact_phone_challenges(id,user_id,phone,code_digest,created_at,expires_at)
         SELECT $1,$2,$3,$4,t,t+interval '5 minutes' FROM (SELECT clock_timestamp() t) stamp
         ON CONFLICT(user_id,phone) DO UPDATE SET id=excluded.id,code_digest=excluded.code_digest,
          attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at,delivery='unknown'
         RETURNING id,created_at,expires_at,delivery`,
        [id, actor.id, phone, digest],
      );
      await this.audit.record(
        sql,
        actor.id,
        'account.contact_phone.requested',
        'contact_phone_challenge',
        id,
      );
      return { row: row!, code };
    });
    if (!allocation.code) return result(allocation.row);
    const { row, code } = allocation;
    let delivery: PhoneOtpDispatch = 'unknown';
    try {
      delivery = await this.gateway.send({
        version: 1,
        challengeId: row.id,
        destination: phone,
        code,
        expiresAt: row.expires_at.toISOString(),
      });
    } catch {
      // A lost acknowledgement is ambiguous. Retrying immediately could duplicate the SMS.
    }
    await this.db.pool.query(
      'UPDATE seller_contact_phone_challenges SET delivery=$2 WHERE id=$1',
      [row.id, delivery],
    );
    return result({ ...row, delivery });
  }
  async verify(actor: Actor, body: unknown) {
    seller(actor);
    const input = parse(contactPhoneVerifySchema, body);
    const phone = normalizePhone(input.phone);
    const pepper = otpPepper();
    const settings = await this.db.transaction(async (sql) => {
      await this.lockSeller(sql, actor);
      const {
        rows: [row],
      } = await sql.query<{ id: string; code_digest: string }>(
        `SELECT id,code_digest FROM seller_contact_phone_challenges WHERE user_id=$1 AND phone=$2
         AND attempts<5 AND expires_at>clock_timestamp() AND delivery<>'unavailable' FOR UPDATE`,
        [actor.id, phone],
      );
      if (!row) return;
      const expected = Buffer.from(
        phoneOtpDigest(
          pepper,
          row.id,
          'seller-contact:' + actor.id,
          phone,
          input.code,
        ),
        'hex',
      );
      if (!timingSafeEqual(expected, Buffer.from(row.code_digest, 'hex'))) {
        await sql.query(
          'UPDATE seller_contact_phone_challenges SET attempts=attempts+1 WHERE id=$1',
          [row.id],
        );
        return;
      }
      const slot = await this.freeSlot(sql, actor.id, phone);
      const {
        rows: [added],
      } = await sql.query<{ id: string }>(
        'INSERT INTO seller_contact_phones(user_id,phone,slot) VALUES ($1,$2,$3) RETURNING id',
        [actor.id, phone, slot],
      );
      await sql.query(
        'DELETE FROM seller_contact_phone_challenges WHERE id=$1',
        [row.id],
      );
      await this.audit.record(
        sql,
        actor.id,
        'account.contact_phone.confirmed',
        'seller_contact_phone',
        added!.id,
      );
      return this.settings(sql, actor.id);
    });
    if (!settings)
      throw new BadRequestException({
        code: 'contact_phone_invalid_code',
        message: 'Код неверен или срок его действия истёк.',
      });
    return settings;
  }
  remove(actor: Actor, id: string) {
    return this.db.transaction(async (sql) => {
      await this.lockSeller(sql, actor);
      const current = await this.settings(sql, actor.id);
      const phone = current.phones.find((phone) => phone.id === id);
      if (!phone) throw new NotFoundException();
      if (phone.primary)
        throw new ConflictException({
          code: 'contact_phone_primary',
          message: 'Основной номер меняется в настройках входа.',
        });
      if (current.mode === 'calls') await requireLivePhone(sql, actor.id, id);
      await sql.query(
        'DELETE FROM seller_contact_phones WHERE user_id=$1 AND id=$2',
        [actor.id, id],
      );
      await this.audit.record(
        sql,
        actor.id,
        'account.contact_phone.removed',
        'seller_contact_phone',
        id,
      );
      return this.settings(sql, actor.id);
    });
  }
}

@Controller('v1/account')
export class ContactSettingsController {
  constructor(private readonly service: ContactSettingsService) {}
  @Get('contact-settings')
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentActor() actor: Actor) {
    return this.service.get(actor);
  }
  @Patch('contact-settings')
  @Header('Cache-Control', 'private, no-store')
  change(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.service.change(actor, body);
  }
  @Post('contact-phones/request')
  @Header('Cache-Control', 'private, no-store')
  request(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.service.request(actor, body);
  }
  @Post('contact-phones/verify')
  @Header('Cache-Control', 'private, no-store')
  verify(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.service.verify(actor, body);
  }
  @Delete('contact-phones/:id')
  @Header('Cache-Control', 'private, no-store')
  remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.service.remove(actor, parse(uuid, id).toLowerCase());
  }
}
