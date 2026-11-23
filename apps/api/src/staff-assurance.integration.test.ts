import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, passwordHash, token, type Actor } from './common/security';
import { confirmStaffTotp } from './modules/auth/staff-assurance';
import {
  openStaffTotpSecret,
  sealStaffTotpSecret,
} from './modules/auth/staff-totp';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';

function currentCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest.readUInt8(digest.length - 1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}

test('concurrent code submissions assure exactly one live staff session', async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const db = new Database();
  try {
    await migrate(db.pool);
    const id = randomUUID();
    const secret = randomBytes(20);
    const key = randomBytes(32);
    await db.pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'staff@example.test','fixture','Staff','admin')",
      [id],
    );
    await db.pool.query(
      `INSERT INTO staff_totp_factors(user_id,encrypted_secret,enrollment_expires_at,activated_at,last_verified_step)
       VALUES($1,$2,now(),now(),0)`,
      [id, sealStaffTotpSecret(secret, key, id)],
    );
    const sessions = await db.rows<{ id: string }>(
      `INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)
       SELECT $1, token, 'fixture', now()+interval '1 hour'
         FROM unnest(ARRAY['one','two']) AS ids(token) RETURNING id`,
      [id],
    );
    const [time] = await db.rows<{ step: string }>(
      'SELECT floor(extract(epoch from clock_timestamp())/30)::bigint AS step',
    );
    assert.ok(time);
    const code = currentCode(secret, Number(time.step));
    const actor = (sessionId: string): Actor => ({
      id,
      role: 'admin',
      email_verified_at: null,
      phone_verified_at: null,
      session_id: sessionId,
    });
    await assert.rejects(
      confirmStaffTotp(db, actor(randomUUID()), code, key),
      /session unavailable/,
    );
    const results = await Promise.allSettled(
      sessions.map(({ id: sessionId }) =>
        confirmStaffTotp(db, actor(sessionId), code, key),
      ),
    );
    assert.equal(
      results.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    const [assured] = await db.rows<{ count: number }>(
      'SELECT count(*)::int AS count FROM sessions WHERE user_id=$1 AND staff_assured_until > now()',
      [id],
    );
    assert.equal(assured?.count, 1);
  } finally {
    await db.onModuleDestroy();
  }
});

test('protected staff routes require an active factor and current session assurance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const key = randomBytes(32);
  const previousKey = process.env.STAFF_TOTP_ENCRYPTION_KEY;
  const previousRequired = process.env.STAFF_TOTP_REQUIRED;
  process.env.STAFF_TOTP_ENCRYPTION_KEY = key.toString('hex');
  process.env.STAFF_TOTP_REQUIRED = 'true';
  t.after(() => {
    if (previousKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_KEY;
    else process.env.STAFF_TOTP_ENCRYPTION_KEY = previousKey;
    if (previousRequired === undefined) delete process.env.STAFF_TOTP_REQUIRED;
    else process.env.STAFF_TOTP_REQUIRED = previousRequired;
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  t.after(() => app.close());
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const db = app.get(Database);
  await migrate(db.pool);
  const password = 'Fixture-only-password-42!';
  const encoded = await passwordHash(password);

  async function session(userId: string) {
    const bearer = token();
    await db.pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [userId, hash(bearer), hash(token())],
    );
    return bearer;
  }
  function call(path: string, bearer: string, body?: unknown) {
    return fetch(base + '/v1/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  for (const [role, allowed] of [
    ['admin', 'admin/users'],
    ['owner', 'admin/moderation'],
  ] as const) {
    const id = randomUUID();
    await db.pool.query(
      'INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,$5,now(),now())',
      [id, id + '@example.test', encoded, 'Staff fixture', role],
    );
    if (role === 'owner') {
      await db.pool.query(
        "INSERT INTO staff_permission_grants(user_id,permission,granted_by) SELECT $1,'moderation.read',id FROM users WHERE role='admin' LIMIT 1",
        [id],
      );
    }
    const first = await session(id);
    const other = await session(id);
    assert.equal((await call(allowed, first)).status, 403);
    const enrollment = await call('auth/staff-totp/enroll', first, {
      password,
    });
    assert.equal(enrollment.status, 201);
    assert.equal(enrollment.headers.get('cache-control'), 'no-store');
    assert.match(
      ((await enrollment.json()) as { secret: string }).secret,
      /^[A-Z2-7]{32}$/,
    );
    const [factor] = await db.rows<{ encrypted_secret: string; step: string }>(
      'SELECT encrypted_secret,floor(extract(epoch from clock_timestamp())/30)::bigint AS step FROM staff_totp_factors WHERE user_id=$1',
      [id],
    );
    assert.ok(factor);
    const code = currentCode(
      openStaffTotpSecret(factor.encrypted_secret, key, id),
      Number(factor.step),
    );
    assert.equal(
      (await call('auth/staff-totp/activate', other, { code })).status,
      403,
    );
    assert.equal(
      (await call('auth/staff-totp/activate', first, { code })).status,
      204,
    );
    assert.equal((await call(allowed, first)).status, 200);
    assert.equal((await call(allowed, other)).status, 403);
    assert.equal(
      (await call('auth/staff-totp/confirm', other, { code })).status,
      403,
    );
    await db.pool.query('DELETE FROM staff_totp_factors WHERE user_id=$1', [
      id,
    ]);
    assert.equal((await call(allowed, first)).status, 403);
  }
});
