import type { UserRole } from '@raui/types/core';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { Database, Sql } from '../modules/database/database';
import { loadConfig } from '../config';
import { headerNames, normalizeIp, verifyIdentity } from '@raui/config/ingress';
import { isProduction } from '../config';
import { ServiceUnavailableException } from '@nestjs/common';
export type Role = UserRole;
export interface Actor {
  id: string;
  role: Role;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  session_id: string;
  registration_approval_state?: 'pending' | 'approved' | 'rejected';
}
export type AuthRequest = Request & {
  actor?: Actor;
  csrfRecoveryToken?: string;
};
export const Public = () => SetMetadata('public', true);
export const AdminOnly = () => SetMetadata('admin', true);
export const staffPermissions = [
  'moderation.read',
  'moderation.decide',
  'registration.read',
  'registration.decide',
] as const;
export type StaffPermission = (typeof staffPermissions)[number];
export const StaffPermissionOnly = (permission: StaffPermission) =>
  applyDecorators(
    SetMetadata('admin', false),
    SetMetadata('staffPermission', permission),
  );
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor =>
    context.switchToHttp().getRequest<AuthRequest>().actor!,
);
export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const sessionCsrf = (secret: string) =>
  createHmac('sha256', secret)
    .update('raui:session-csrf:v1')
    .digest('base64url');
export const uuid = z.uuid();
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException({
      message: 'Validation failed',
      fields: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  return result.data;
}
export function verified(actor: Actor) {
  if (!actor.email_verified_at || !actor.phone_verified_at)
    throw new ForbiddenException('Email and phone verification required');
}
export function seller(actor: Actor) {
  verified(actor);
  if (!['owner', 'agent', 'agency', 'developer', 'admin'].includes(actor.role))
    throw new ForbiddenException('Seller role required');
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== '32768')
    return false;
  const actual = await derive(password, parts[2]!);
  const expected = Buffer.from(parts[3]!, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (
      isPublic &&
      (req.url.startsWith('/v1/auth/') ||
        req.url.split('?')[0] === '/v1/commerce/webhook')
    )
      return true;

    const bearer = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    const cookie = req.headers.cookie?.match(
      /(?:^|;\s*)raui_session=([A-Za-z0-9_-]{43})(?:;|$)/,
    )?.[1];
    const secret = bearer ?? cookie;
    if (!secret) {
      if (isPublic) return true;
      throw new UnauthorizedException();
    }
    const [actor] = await this.db.rows<Actor & { csrf_hash: string }>(
      `SELECT u.id,u.role,u.email_verified_at,u.phone_verified_at,u.registration_approval_state,s.id AS session_id,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active`,
      [hash(secret)],
    );
    if (!actor) throw new UnauthorizedException();
    if (actor.registration_approval_state === 'rejected')
      throw new ForbiddenException('Registration rejected');
    if (actor.registration_approval_state === 'pending') {
      const path = req.url.split('?')[0];
      const onboarding = new Set([
        'GET /v1/auth/me',
        'GET /v1/auth/csrf',
        'GET /v1/auth/sessions',
        'POST /v1/auth/logout',
        'POST /v1/auth/logout-all',
        'POST /v1/auth/verification/email',
        'POST /v1/auth/verification/phone',
        'POST /v1/auth/verification/phone/confirm',
      ]);
      if (
        !onboarding.has(`${req.method} ${path}`) &&
        !(
          req.method === 'DELETE' &&
          /^\/v1\/auth\/sessions\/[0-9a-f-]{36}$/i.test(path!)
        )
      )
        throw new ForbiddenException('Registration approval pending');
    }
    if (!bearer) req.csrfRecoveryToken = sessionCsrf(secret);
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const supplied = req.headers['x-csrf-token'];
      const validToken =
        typeof supplied === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(supplied) &&
        (timingSafeEqual(
          Buffer.from(hash(supplied), 'hex'),
          Buffer.from(actor.csrf_hash, 'hex'),
        ) ||
          timingSafeEqual(
            Buffer.from(supplied),
            Buffer.from(req.csrfRecoveryToken!),
          ));
      if (req.headers.origin !== loadConfig().WEB_ORIGIN || !validToken)
        throw new ForbiddenException('CSRF validation failed');
    }
    if (
      this.reflector.getAllAndOverride<boolean>('admin', [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      if (actor.role !== 'admin') throw new ForbiddenException();
      verified(actor);
    }
    const permission = this.reflector.getAllAndOverride<StaffPermission>(
      'staffPermission',
      [context.getHandler(), context.getClass()],
    );
    if (permission) {
      verified(actor);
      if (actor.role !== 'admin') {
        const [grant] = await this.db.rows<{ user_id: string }>(
          'SELECT user_id FROM staff_permission_grants WHERE user_id=$1 AND permission=$2',
          [actor.id, permission],
        );
        if (!grant) throw new ForbiddenException('Staff permission required');
      }
    }
    req.actor = actor;
    return true;
  }
}
@Injectable()
export class RateGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.url.startsWith('/v1/')) return true;
    const recoveryRead =
      req.method === 'GET' && req.url.split('?')[0] === '/v1/auth/csrf';
    const sensitive = req.url.startsWith('/v1/auth/') && !recoveryRead;
    const cfg = loadConfig();
    const peer = normalizeIp(req.socket?.remoteAddress ?? req.ip);
    const trusted = cfg.TRUSTED_PROXY_PEERS.split(',')
      .map((value) => normalizeIp(value.trim()))
      .filter(Boolean)
      .includes(peer);
    const forwarded = headerNames.some(
      (name) => req.headers[name] !== undefined,
    );
    let client = normalizeIp(req.ip) ?? peer ?? 'unknown';
    if (forwarded) {
      const identity =
        trusted && cfg.PROXY_IDENTITY_SECRET
          ? verifyIdentity(
              req.headers,
              req.method,
              req.originalUrl ?? req.url,
              cfg.PROXY_IDENTITY_SECRET,
            )
          : null;
      if (!identity)
        throw new ForbiddenException('Forwarded identity rejected');
      client = identity;
    } else if (trusted && isProduction(cfg)) {
      throw new ServiceUnavailableException(
        'Trusted ingress identity required',
      );
    }
    const limit = sensitive ? 30 : 300;
    const consume = async (key: string, maximum: number) => {
      const [row] = await this.db.rows<{ count: number }>(
        `INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<now() THEN 1 ELSE rate_limits.count+1 END,reset_at=CASE WHEN rate_limits.reset_at<now() THEN now()+interval '1 minute' ELSE rate_limits.reset_at END RETURNING count`,
        [key],
      );
      if (row!.count > maximum) {
        const { HttpException } = await import('@nestjs/common');
        throw new HttpException('Rate limit exceeded', 429);
      }
    };
    if (forwarded)
      await consume(
        `proxy:${sensitive ? 'auth' : 'api'}:${peer}`,
        sensitive ? 300 : 3000,
      );
    await consume(`${sensitive ? 'auth' : 'api'}:${client}`, limit);
    // Public credential endpoints reject cross-origin browser submissions too.
    if (
      sensitive &&
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== cfg.WEB_ORIGIN
    )
      throw new ForbiddenException('Origin rejected');
    return true;
  }
}
@Injectable()
export class Idempotency {
  constructor(private readonly db: Database) {}
  async run<T>(
    actor: Actor,
    scope: string,
    key: unknown,
    body: unknown,
    work: (sql: Sql) => Promise<T>,
    authorize?: (sql: Sql) => Promise<unknown>,
  ): Promise<T> {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key (8..100 characters) required',
      );
    const requestHash = hash(JSON.stringify(body));
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${actor.id}:${scope}:${key}`,
      ]);
      await authorize?.(sql);
      const [record] = await this.db.rows<{
        request_hash: string;
        response: T;
      }>(
        'SELECT request_hash,response FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND key=$3',
        [actor.id, scope, key],
        sql,
      );
      if (record) {
        if (record.request_hash !== requestHash)
          throw new ConflictException(
            'Idempotency key reused with another payload',
          );
        return record.response;
      }
      const response = await work(sql);
      await sql.query(
        'INSERT INTO idempotency_records(actor_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)',
        [actor.id, scope, key, requestHash, JSON.stringify(response)],
      );
      return response;
    });
  }
}
