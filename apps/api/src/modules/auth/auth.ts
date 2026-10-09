import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Res,
  Req,
  Module,
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Delete,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database/database';
import { Audit } from '../audit/audit';
import {
  Actor,
  AuthRequest,
  CurrentActor,
  Public,
  hash,
  parse,
  token,
  passwordHash,
  passwordMatches,
  uuid,
} from '../../common/security';
import { isProduction, loadConfig } from '../../config';
import {
  ConfiguredDelivery,
  VerificationDelivery,
  VerificationMessage,
} from './delivery';
export const passwordSchema = z.string().min(12).max(128);
const emailSchema = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100),
    role: z
      .enum(['buyer', 'owner', 'agent', 'agency', 'developer'])
      .default('buyer'),
  })
  .strict();
export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().max(128),
    transport: z.enum(['cookie', 'bearer']).default('cookie'),
  })
  .strict();
interface User {
  id: string;
  email: string;
  display_name: string;
  role: string;
  active: boolean;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  phone: string | null;
  password_hash: string;
}
function publicUser(user: User) {
  const { password_hash: _password, ...safe } = user;
  void _password;
  return safe;
}
@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly delivery: VerificationDelivery,
  ) {}
  async challenge(
    user: User,
    purpose: VerificationMessage['purpose'],
    destination: string,
  ) {
    const secret = token();
    await this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      await sql.query(
        'UPDATE auth_challenges SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL',
        [user.id, purpose],
      );
      await sql.query(
        "INSERT INTO auth_challenges(user_id,purpose,token_hash,destination,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')",
        [user.id, purpose, hash(secret), destination],
      );
      await this.audit.record(
        sql,
        user.id,
        `auth.${purpose}.requested`,
        'user',
        user.id,
      );
    });
    await this.delivery.send({ destination, purpose, token: secret });
  }
  async register(body: unknown) {
    const input = parse(registerSchema, body);
    const encoded = await passwordHash(input.password);
    const user = await this.db.transaction(async (sql) => {
      const [created] = await this.db.rows<User>(
        'INSERT INTO users(email,password_hash,display_name,role) VALUES($1,$2,$3,$4) RETURNING *',
        [input.email, encoded, input.displayName, input.role],
        sql,
      );
      await this.audit.record(
        sql,
        created!.id,
        'auth.registered',
        'user',
        created!.id,
      );
      return created!;
    });
    await this.challenge(user, 'email', user.email);
    return publicUser(user);
  }
  async login(body: unknown, res: Response) {
    const input = parse(loginSchema, body);
    const [counter] = await this.db.rows<{ count: number }>(
      `INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<now() THEN 1 ELSE rate_limits.count+1 END, reset_at=CASE WHEN rate_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE rate_limits.reset_at END RETURNING count`,
      [`login:${hash(input.email)}`],
    );
    if (counter!.count > 15)
      throw new UnauthorizedException('Login temporarily unavailable');
    const [user] = await this.db.rows<User>(
      'SELECT * FROM users WHERE email=$1',
      [input.email],
    );
    const valid = await passwordMatches(
      input.password,
      user?.password_hash ?? `scrypt$32768$invalid$${'0'.repeat(128)}`,
    );
    if (!user || !user.active || !valid)
      throw new UnauthorizedException('Invalid credentials');
    const secret = token(),
      csrf = token();
    const days = loadConfig().SESSION_DAYS;
    await this.db.transaction(async (sql) => {
      await sql.query(
        'SELECT id FROM users WHERE id=$1 AND active FOR UPDATE',
        [user.id],
      );
      // Recheck password/activation under lock to prevent reset/login races.
      const [current] = await this.db.rows<User>(
        'SELECT * FROM users WHERE id=$1',
        [user.id],
        sql,
      );
      if (!current?.active || current.password_hash !== user.password_hash)
        throw new UnauthorizedException();
      await sql.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 day')",
        [user.id, hash(secret), hash(csrf), days],
      );
      await this.audit.record(sql, user.id, 'auth.login', 'user', user.id);
    });
    if (input.transport === 'cookie')
      res.cookie('raui_session', secret, {
        httpOnly: true,
        secure: isProduction(loadConfig()),
        sameSite: 'lax',
        path: '/',
        maxAge: days * 86400000,
      });
    res.setHeader('Cache-Control', 'no-store');
    return {
      user: publicUser(user),
      csrfToken: csrf,
      ...(input.transport === 'bearer' ? { sessionToken: secret } : {}),
    };
  }
  async me(actor: Actor) {
    const [user] = await this.db.rows<User>('SELECT * FROM users WHERE id=$1', [
      actor.id,
    ]);
    return { ...publicUser(user!), twoFactorEnabled: false };
  }
  async request(body: unknown, purpose: 'email' | 'reset', actor?: Actor) {
    if (actor) {
      const [user] = await this.db.rows<User>(
        'SELECT * FROM users WHERE id=$1',
        [actor.id],
      );
      await this.challenge(user!, purpose, user!.email);
    } else {
      const input = parse(z.object({ email: emailSchema }).strict(), body);
      const [user] = await this.db.rows<User>(
        'SELECT * FROM users WHERE email=$1 AND active',
        [input.email],
      );
      if (user) await this.challenge(user, purpose, user.email);
    }
    return { accepted: true };
  }
  async requestPhone(actor: Actor, body: unknown) {
    const input = parse(
      z.object({ phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/) }).strict(),
      body,
    );
    const [user] = await this.db.rows<User>('SELECT * FROM users WHERE id=$1', [
      actor.id,
    ]);
    await this.challenge(user!, 'phone', input.phone);
    return { accepted: true };
  }
  async confirm(
    body: unknown,
    purpose: 'email' | 'phone' | 'reset',
    actor?: Actor,
  ) {
    const input = parse(
      z
        .object({
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          ...(purpose === 'reset' ? { password: passwordSchema } : {}),
        })
        .strict(),
      body,
    );
    const newHash =
      purpose === 'reset'
        ? await passwordHash((input as { password: string }).password)
        : null;
    await this.db.transaction(async (sql) => {
      const [challenge] = await this.db.rows<{
        id: string;
        user_id: string;
        destination: string;
      }>(
        `SELECT c.* FROM auth_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.purpose=$2 AND c.used_at IS NULL AND c.expires_at>now() AND u.active FOR UPDATE OF c,u`,
        [hash(input.token), purpose],
        sql,
      );
      if (!challenge || (actor && challenge.user_id !== actor.id))
        throw new BadRequestException('Invalid or expired verification');
      await sql.query('UPDATE auth_challenges SET used_at=now() WHERE id=$1', [
        challenge.id,
      ]);
      if (purpose === 'email')
        await sql.query(
          'UPDATE users SET email_verified_at=now(),updated_at=now() WHERE id=$1',
          [challenge.user_id],
        );
      if (purpose === 'phone')
        await sql.query(
          'UPDATE users SET phone=$2,phone_verified_at=now(),updated_at=now() WHERE id=$1',
          [challenge.user_id, challenge.destination],
        );
      if (purpose === 'reset') {
        await sql.query(
          'UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1',
          [challenge.user_id, newHash],
        );
        await sql.query(
          'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [challenge.user_id],
        );
      }
      await this.audit.record(
        sql,
        challenge.user_id,
        `auth.${purpose}.confirmed`,
        'user',
        challenge.user_id,
      );
    });
    return { ok: true };
  }
  async logout(actor: Actor, all: boolean, res: Response) {
    await this.db.transaction(async (sql) => {
      await sql.query(
        all
          ? 'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL'
          : 'UPDATE sessions SET revoked_at=now() WHERE id=$1',
        [all ? actor.id : actor.session_id],
      );
      await this.audit.record(
        sql,
        actor.id,
        all ? 'auth.logout_all' : 'auth.logout',
        'user',
        actor.id,
      );
    });
    res.clearCookie('raui_session', { path: '/' });
    return { ok: true };
  }
  async sessions(actor: Actor) {
    return this.db.rows(
      'SELECT id,created_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100',
      [actor.id],
    );
  }
  async revoke(actor: Actor, id: string) {
    parse(uuid, id);
    await this.db.transaction(async (sql) => {
      const result = await sql.query(
        'UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',
        [id, actor.id],
      );
      if (!result.rowCount) throw new NotFoundException();
      await this.audit.record(
        sql,
        actor.id,
        'auth.session.revoked',
        'session',
        id,
      );
    });
    return { ok: true };
  }
}
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Post('register') register(@Body() body: unknown) {
    return this.auth.register(body);
  }
  @Public() @Post('login') login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(body, res);
  }
  @Get('me') me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }
  @Get('csrf') csrf(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.headers.origin && req.headers.origin !== loadConfig().WEB_ORIGIN)
      throw new ForbiddenException('Origin rejected');
    if (!req.csrfRecoveryToken) throw new UnauthorizedException();
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: req.csrfRecoveryToken };
  }
  @Post('logout') logout(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.logout(actor, false, res);
  }
  @Post('logout-all') logoutAll(
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.logout(actor, true, res);
  }
  @Get('sessions') sessions(@CurrentActor() actor: Actor) {
    return this.auth.sessions(actor);
  }
  @Delete('sessions/:id') revoke(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.auth.revoke(actor, id);
  }
  @Post('verification/email') email(@CurrentActor() actor: Actor) {
    return this.auth.request({}, 'email', actor);
  }
  @Public() @Post('verification/email/confirm') confirmEmail(
    @Body() body: unknown,
  ) {
    return this.auth.confirm(body, 'email');
  }
  @Post('verification/phone') phone(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.auth.requestPhone(actor, body);
  }
  @Post('verification/phone/confirm') confirmPhone(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.auth.confirm(body, 'phone', actor);
  }
  @Public() @Post('password-reset') reset(@Body() body: unknown) {
    return this.auth.request(body, 'reset');
  }
  @Public() @Post('password-reset/confirm') confirmReset(
    @Body() body: unknown,
  ) {
    return this.auth.confirm(body, 'reset');
  }
}
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: VerificationDelivery, useClass: ConfiguredDelivery },
  ],
  exports: [AuthService],
})
export class AuthModule {}
