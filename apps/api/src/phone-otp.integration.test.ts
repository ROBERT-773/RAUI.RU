import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { PhoneOtpService, phoneOtpDigest } from './modules/auth/phone-otp';
import { migrate } from './modules/database/migrate';
import { hash, token } from './common/security';
import {
  PhoneOtpDelivery,
  type PhoneOtpMessage,
  type PhoneOtpDispatch,
} from './modules/auth/phone-otp-delivery';
import {
  VerificationDelivery,
  type VerificationMessage,
} from './modules/auth/delivery';

interface Actor {
  id: string;
  secret: string;
  csrf: string;
}
interface Challenge {
  challengeId: string;
  expiresAt: string;
  resendAfter: string;
  delivery: PhoneOtpDispatch;
}

test('numeric phone OTP preserves committed security boundaries over real HTTP and PostgreSQL', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  process.env.PHONE_OTP_ENABLED = 'true';
  process.env.PHONE_OTP_PEPPER = randomBytes(32).toString('base64url');
  process.env.PHONE_OTP_GATEWAY_URL = 'https://otp.example.test/dispatch';
  process.env.PHONE_OTP_GATEWAY_TOKEN = 'integration-test-only-token';
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const beforeDirectory = resolve(process.env.LOCAL_PRIVATE_DIR!, 'before-otp');
  await mkdir(beforeDirectory, { recursive: true });
  for (const name of (await readdir('migrations')).filter(
    (name) => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 16,
  ))
    await writeFile(
      resolve(beforeDirectory, name),
      await readFile('migrations/' + name),
    );
  await migrate(pool, beforeDirectory);
  const preservedUser = randomUUID(),
    preservedChallenge = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,display_name,role,phone,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Preserved owner','owner','+79990000001',now(),now())",
    [preservedUser, preservedUser + '@example.test'],
  );
  await pool.query(
    "INSERT INTO auth_challenges(id,user_id,purpose,token_hash,destination,expires_at,attempts) VALUES($1,$2,'phone',$3,'+79990000002',now()+interval '1 hour',2)",
    [preservedChallenge, preservedUser, hash(token())],
  );
  const preservedBefore = (
    await pool.query('SELECT to_jsonb(u) data FROM users u WHERE id=$1', [
      preservedUser,
    ])
  ).rows[0].data;
  const challengeBefore = (
    await pool.query(
      'SELECT to_jsonb(c) data FROM auth_challenges c WHERE id=$1',
      [preservedChallenge],
    )
  ).rows[0].data;
  const ledgerBefore = (
    await pool.query('SELECT * FROM schema_migrations ORDER BY name')
  ).rows;
  await migrate(pool);
  await migrate(pool);
  assert.deepEqual(
    (
      await pool.query('SELECT to_jsonb(u) data FROM users u WHERE id=$1', [
        preservedUser,
      ])
    ).rows[0].data,
    preservedBefore,
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(c) data FROM auth_challenges c WHERE id=$1',
        [preservedChallenge],
      )
    ).rows[0].data,
    challengeBefore,
  );
  assert.deepEqual(
    (
      await pool.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows.slice(0, 16),
    ledgerBefore,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM phone_otp_challenges'))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM phone_otp_send_events'))
      .rows[0].n,
    0,
  );
  const messages: PhoneOtpMessage[] = [];
  const legacy: VerificationMessage[] = [];
  let dispatch: PhoneOtpDispatch = 'accepted';
  let gate: (() => Promise<void>) | undefined;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PhoneOtpDelivery)
    .useValue({
      send: async (message: PhoneOtpMessage) => {
        messages.push(message);
        await gate?.();
        return dispatch;
      },
    })
    .overrideProvider(VerificationDelivery)
    .useValue({
      send: async (message: VerificationMessage) => {
        legacy.push(message);
      },
    })
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  let phoneCounter = 1000000;
  const phone = () => '+7999' + String(phoneCounter++);
  async function actor(state = 'pending'): Promise<Actor> {
    const id = randomUUID(),
      secret = token(),
      csrf = token();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,registration_approval_state) VALUES($1,$2,'fixture','OTP fixture','owner',$3)",
      [id, id + '@example.test', state],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [id, hash(secret), hash(csrf)],
    );
    return { id, secret, csrf };
  }
  async function call(
    path: string,
    user?: Actor,
    body?: unknown,
    key: string = randomUUID(),
    cookie = false,
    csrf = true,
  ) {
    // Ingress limits have independent coverage; never clear OTP events or counters.
    await pool.query('DELETE FROM rate_limits');
    return fetch(base + '/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(user
          ? cookie
            ? {
                Cookie: 'raui_session=' + user.secret,
                Origin: process.env.WEB_ORIGIN!,
                ...(csrf ? { 'X-CSRF-Token': user.csrf } : {}),
              }
            : { Authorization: 'Bearer ' + user.secret }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function request(
    user: Actor,
    destination = phone(),
    key: string = randomUUID(),
  ): Promise<Challenge> {
    const response = await call(
      '/auth/verification/phone/otp',
      user,
      { phone: destination },
      key,
    );
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as Challenge;
  }
  const confirm = (user: Actor, challenge: Challenge, code: string) =>
    call('/auth/verification/phone/otp/confirm', user, {
      challengeId: challenge.challengeId,
      code,
    });
  async function age(user: Actor, interval = '61 seconds') {
    await pool.query(
      'UPDATE phone_otp_send_events SET created_at=clock_timestamp()-$2::interval WHERE user_id=$1',
      [user.id, interval],
    );
    await pool.query(
      'UPDATE phone_otp_challenges SET created_at=clock_timestamp()-$2::interval WHERE user_id=$1',
      [user.id, interval],
    );
  }
  const row = async (id: string) =>
    (await pool.query('SELECT * FROM phone_otp_challenges WHERE id=$1', [id]))
      .rows[0];
  const code = (challenge: Challenge) =>
    messages.find((m) => m.challengeId === challenge.challengeId)!.code;
  try {
    await t.test(
      'pending capabilities are private; unauthenticated, rejected, inactive and cookie CSRF mutations are denied',
      async () => {
        const user = await actor();
        const response = await call(
          '/auth/verification/phone/capabilities',
          user,
        );
        assert.equal(response.status, 200);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        assert.deepEqual(await response.json(), {
          numericOtp: { available: true, reason: 'available' },
          legacyToken: { available: true },
        });
        assert.equal(
          (await call('/auth/verification/phone/capabilities')).status,
          401,
        );
        assert.equal(
          (
            await call(
              '/auth/verification/phone/capabilities',
              await actor('rejected'),
            )
          ).status,
          403,
        );
        await pool.query('UPDATE users SET active=false WHERE id=$1', [
          user.id,
        ]);
        assert.equal(
          (await call('/auth/verification/phone/capabilities', user)).status,
          401,
        );
        const cookieUser = await actor();
        assert.equal(
          (
            await call(
              '/auth/verification/phone/otp',
              cookieUser,
              { phone: phone() },
              randomUUID(),
              true,
              false,
            )
          ).status,
          403,
        );
        const accepted = await call(
          '/auth/verification/phone/otp',
          cookieUser,
          { phone: phone() },
          randomUUID(),
          true,
        );
        assert.equal(accepted.status, 201);
        assert.equal((await call('/auth/me', cookieUser)).status, 200);
        assert.equal(
          (await call('/account/publication-quota', cookieUser)).status,
          403,
        );
      },
    );
    await t.test(
      'strict phone/code/idempotency validation creates no challenge on invalid input',
      async () => {
        const user = await actor();
        for (const body of [{ phone: '123' }, { phone: phone(), extra: true }])
          assert.equal(
            (await call('/auth/verification/phone/otp', user, body)).status,
            400,
          );
        assert.equal(
          (
            await call(
              '/auth/verification/phone/otp',
              user,
              { phone: phone() },
              'short',
            )
          ).status,
          400,
        );
        for (const key of ['x'.repeat(101), 'invalid.key', 'invalid:key'])
          assert.equal(
            (
              await call(
                '/auth/verification/phone/otp',
                user,
                { phone: phone() },
                key,
              )
            ).status,
            400,
          );
        for (const wrong of ['12345', '1234567', 'abcdef', 123456])
          assert.equal(
            (
              await call('/auth/verification/phone/otp/confirm', user, {
                challengeId: randomUUID(),
                code: wrong,
              })
            ).status,
            400,
          );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM phone_otp_challenges WHERE user_id=$1',
              [user.id],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'five incorrect attempts commit, fifth invalidates and correct sixth cannot succeed',
      async () => {
        const user = await actor(),
          challenge = await request(user);
        const wrong = code(challenge) === '000000' ? '000001' : '000000';
        for (let attempt = 1; attempt <= 5; attempt++) {
          const response = await confirm(user, challenge, wrong);
          assert.equal(response.status, 400);
          assert.equal((await row(challenge.challengeId)).attempts, attempt);
          assert.ok(!(await response.text()).includes('remaining'));
        }
        assert.ok((await row(challenge.challengeId)).invalidated_at);
        assert.equal(
          (await confirm(user, challenge, code(challenge))).status,
          400,
        );
        assert.equal(
          (await pool.query('SELECT phone FROM users WHERE id=$1', [user.id]))
            .rows[0].phone,
          null,
        );
      },
    );
    await t.test(
      'wrong actor cannot burn guesses; successful confirmation preserves approval and is single-use',
      async () => {
        const user = await actor(),
          other = await actor(),
          challenge = await request(user);
        assert.equal(
          (await confirm(other, challenge, code(challenge))).status,
          400,
        );
        assert.equal((await row(challenge.challengeId)).attempts, 0);
        const responses = await Promise.all([
          confirm(user, challenge, code(challenge)),
          confirm(user, challenge, code(challenge)),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [201, 400]);
        const stored = (
          await pool.query(
            'SELECT phone,phone_verified_at,registration_approval_state,active,role FROM users WHERE id=$1',
            [user.id],
          )
        ).rows[0];
        assert.equal(
          stored.phone,
          messages.find((m) => m.challengeId === challenge.challengeId)!
            .destination,
        );
        assert.ok(stored.phone_verified_at);
        assert.equal(stored.registration_approval_state, 'pending');
        assert.equal(stored.role, 'owner');
        assert.equal(stored.active, true);
        assert.ok((await row(challenge.challengeId)).used_at);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action LIKE '%confirm%'",
              [challenge.challengeId],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test('expiry uses wall time after user-row lock wait', async () => {
      const user = await actor(),
        challenge = await request(user);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        user.id,
      ]);
      await blocker.query(
        "UPDATE phone_otp_challenges SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",
        [challenge.challengeId],
      );
      const pending = confirm(user, challenge, code(challenge));
      await new Promise((resolve) => setTimeout(resolve, 450));
      await blocker.query('COMMIT');
      blocker.release();
      assert.equal((await pending).status, 400);
      assert.equal((await row(challenge.challengeId)).used_at, null);
    });
    await t.test(
      'same key concurrent allocation dispatches once, changed body conflicts, revoked replay is denied',
      async () => {
        const user = await actor(),
          destination = phone(),
          key: string = randomUUID(),
          before = messages.length;
        const responses = await Promise.all(
          Array.from({ length: 4 }, () =>
            call(
              '/auth/verification/phone/otp',
              user,
              { phone: destination },
              key,
            ),
          ),
        );
        for (const response of responses) assert.equal(response.status, 201);
        const results = await Promise.all(
          responses.map((r) => r.json() as Promise<Challenge>),
        );
        assert.equal(new Set(results.map((r) => r.challengeId)).size, 1);
        assert.equal(messages.length - before, 1);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM phone_otp_send_events WHERE user_id=$1',
              [user.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await call(
              '/auth/verification/phone/otp',
              user,
              { phone: phone() },
              key,
            )
          ).status,
          409,
        );
        const replay = await call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        assert.equal(replay.status, 201);
        assert.equal(((await replay.json()) as Challenge).delivery, 'accepted');
        await pool.query(
          'UPDATE sessions SET revoked_at=now() WHERE user_id=$1',
          [user.id],
        );
        assert.equal(
          (
            await call(
              '/auth/verification/phone/otp',
              user,
              { phone: destination },
              key,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      'cooldown and account rolling quota count unknown/unavailable allocations and legacy sends',
      async () => {
        const user = await actor();
        dispatch = 'unavailable';
        const first = await request(user);
        assert.equal(first.delivery, 'unavailable');
        const denied = await call('/auth/verification/phone/otp', user, {
          phone: phone(),
        });
        assert.equal(denied.status, 429);
        assert.ok(Number(denied.headers.get('retry-after')) > 0);
        for (let i = 1; i < 5; i++) {
          await age(user);
          dispatch = 'unknown';
          const next = await request(user);
          assert.equal(next.delivery, 'unknown');
        }
        await age(user);
        assert.equal(
          (await call('/auth/verification/phone/otp', user, { phone: phone() }))
            .status,
          429,
        );
        assert.equal(
          (await call('/auth/verification/phone', user, { phone: phone() }))
            .status,
          429,
        );
        await age(user, '1 hour 1 second');
        dispatch = 'accepted';
        assert.equal((await request(user)).delivery, 'accepted');
      },
    );
    await t.test(
      'destination quota is shared across accounts including concurrent sixth send',
      async () => {
        const destination = phone();
        for (let i = 0; i < 4; i++) await request(await actor(), destination);
        const a = await actor(),
          b = await actor();
        const results = await Promise.all([
          call('/auth/verification/phone/otp', a, { phone: destination }),
          call('/auth/verification/phone/otp', b, { phone: destination }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 429]);
      },
    );
    await t.test(
      'legacy and OTP challenges cross-invalidate; old messages cannot revert a contact',
      async () => {
        const user = await actor(),
          first = await request(user);
        await age(user);
        const legacyPhone = phone();
        assert.equal(
          (await call('/auth/verification/phone', user, { phone: legacyPhone }))
            .status,
          201,
        );
        const legacyCode = legacy.find(
          (m) => m.destination === legacyPhone,
        )!.token;
        assert.equal((await confirm(user, first, code(first))).status, 400);
        await age(user);
        const second = await request(user);
        assert.equal(
          (
            await call('/auth/verification/phone/confirm', user, {
              token: legacyCode,
            })
          ).status,
          400,
        );
        assert.equal((await confirm(user, second, code(second))).status, 201);
      },
    );
    await t.test(
      'unique contact conflict commits invalidation and preserves both users',
      async () => {
        const holder = await actor(),
          user = await actor(),
          destination = phone();
        await pool.query(
          'UPDATE users SET phone=$2,phone_verified_at=now() WHERE id=$1',
          [holder.id, destination],
        );
        const challenge = await request(user, destination);
        assert.equal(
          (await confirm(user, challenge, code(challenge))).status,
          409,
        );
        assert.ok((await row(challenge.challengeId)).invalidated_at);
        assert.equal(
          (await pool.query('SELECT phone FROM users WHERE id=$1', [user.id]))
            .rows[0].phone,
          null,
        );
        assert.equal(
          (await pool.query('SELECT phone FROM users WHERE id=$1', [holder.id]))
            .rows[0].phone,
          destination,
        );
        assert.equal(
          (await confirm(user, challenge, code(challenge))).status,
          400,
        );
      },
    );
    await t.test(
      'in-flight replay never sends twice and finalization races safely with replay',
      async () => {
        const user = await actor(),
          destination = phone(),
          key = randomUUID();
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((r) => (entered = r)),
          wait = new Promise<void>((r) => (release = r));
        gate = async () => {
          entered();
          await wait;
        };
        const original = call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        await reached;
        const replay = await call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        assert.equal(replay.status, 201);
        assert.equal(((await replay.json()) as Challenge).delivery, 'unknown');
        release();
        const race = call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        assert.equal((await original).status, 201);
        assert.equal((await race).status, 201);
        gate = undefined;
        assert.equal(
          messages.filter((m) => m.destination === destination).length,
          1,
        );
        const settled = await call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        assert.equal(
          ((await settled.json()) as Challenge).delivery,
          'accepted',
        );
      },
    );
    await t.test(
      'leading zeros survive HTTP confirmation without staff approval',
      async () => {
        const user = await actor(),
          challenge = await request(user),
          destination = messages.find(
            (m) => m.challengeId === challenge.challengeId,
          )!.destination;
        // Synthetic PG fixture isolates leading-zero validation from random generation.
        const digest = phoneOtpDigest(
          Buffer.from(process.env.PHONE_OTP_PEPPER!, 'base64url'),
          challenge.challengeId,
          user.id,
          destination,
          '000123',
        );
        await pool.query(
          'UPDATE phone_otp_challenges SET code_digest=$2 WHERE id=$1',
          [challenge.challengeId, digest],
        );
        assert.equal((await confirm(user, challenge, '000123')).status, 201);
        assert.equal(
          (
            await pool.query(
              'SELECT registration_approval_state FROM users WHERE id=$1',
              [user.id],
            )
          ).rows[0].registration_approval_state,
          'pending',
        );
      },
    );
    await t.test(
      'crash-marker pending replay has no plaintext recovery and does not dispatch',
      async () => {
        const user = await actor(),
          destination = phone(),
          key = randomUUID(),
          challenge = await request(user, destination, key),
          before = messages.length;
        await pool.query(
          "UPDATE phone_otp_challenges SET dispatch_state='pending' WHERE id=$1",
          [challenge.challengeId],
        );
        await pool.query(
          "UPDATE idempotency_records SET response=jsonb_set(response,'{delivery}','\"unknown\"'::jsonb) WHERE actor_id=$1 AND scope='phone-otp-request' AND key=$2",
          [user.id, key],
        );
        const replay = await call(
          '/auth/verification/phone/otp',
          user,
          { phone: destination },
          key,
        );
        assert.equal(replay.status, 201);
        assert.equal(((await replay.json()) as Challenge).delivery, 'unknown');
        assert.equal(messages.length, before);
        assert.equal(
          (await row(challenge.challengeId)).dispatch_state,
          'pending',
        );
      },
    );
    await t.test(
      'shared destination budget includes a successful legacy allocation',
      async () => {
        const destination = phone(),
          legacyUser = await actor();
        assert.equal(
          (
            await call('/auth/verification/phone', legacyUser, {
              phone: destination,
            })
          ).status,
          201,
        );
        for (let i = 0; i < 4; i++) await request(await actor(), destination);
        assert.equal(
          (
            await call('/auth/verification/phone/otp', await actor(), {
              phone: destination,
            })
          ).status,
          429,
        );
      },
    );
    await t.test(
      'disabled and unconfigured numeric delivery never allocates challenges or send events',
      async () => {
        const user = await actor(),
          before = messages.length;
        process.env.PHONE_OTP_ENABLED = 'false';
        const disabled = await call(
          '/auth/verification/phone/capabilities',
          user,
        );
        assert.deepEqual(await disabled.json(), {
          numericOtp: { available: false, reason: 'disabled' },
          legacyToken: { available: true },
        });
        assert.equal(
          (await call('/auth/verification/phone/otp', user, { phone: phone() }))
            .status,
          503,
        );
        process.env.PHONE_OTP_ENABLED = 'true';
        const gatewayToken = process.env.PHONE_OTP_GATEWAY_TOKEN;
        delete process.env.PHONE_OTP_GATEWAY_TOKEN;
        try {
          const unconfigured = await call(
            '/auth/verification/phone/capabilities',
            user,
          );
          assert.deepEqual(await unconfigured.json(), {
            numericOtp: { available: false, reason: 'unconfigured' },
            legacyToken: { available: true },
          });
          assert.equal(
            (
              await call('/auth/verification/phone/otp', user, {
                phone: phone(),
              })
            ).status,
            503,
          );
        } finally {
          process.env.PHONE_OTP_GATEWAY_TOKEN = gatewayToken;
        }
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM phone_otp_challenges WHERE user_id=$1',
              [user.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM phone_otp_send_events WHERE user_id=$1',
              [user.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(messages.length, before);
      },
    );
    await t.test(
      'wrong-user legacy token is rejected without locking the victim account',
      async () => {
        const victim = await actor(),
          other = await actor(),
          destination = phone();
        assert.equal(
          (
            await call('/auth/verification/phone', victim, {
              phone: destination,
            })
          ).status,
          201,
        );
        const legacyCode = legacy.find(
          (m) => m.destination === destination,
        )!.token;
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          victim.id,
        ]);
        try {
          const response = await Promise.race([
            call('/auth/verification/phone/confirm', other, {
              token: legacyCode,
            }),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Wrong user waited for victim lock')),
                1000,
              );
              timer.unref();
            }),
          ]);
          assert.equal(response.status, 400);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        assert.equal(
          (
            await call('/auth/verification/phone/confirm', victim, {
              token: legacyCode,
            })
          ).status,
          201,
        );
      },
    );
    await t.test(
      'concurrent logout audit FK does not deadlock OTP user/session authorization',
      async () => {
        const user = await actor(),
          destination = phone(),
          before = messages.length;
        const session = (
          await pool.query('SELECT id FROM sessions WHERE user_id=$1', [
            user.id,
          ])
        ).rows[0].id as string;
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query("SET LOCAL lock_timeout='1s'");
        await blocker.query(
          'UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',
          [session],
        );
        const attempt = module
          .get(PhoneOtpService)
          .request(
            {
              id: user.id,
              role: 'owner',
              email_verified_at: null,
              phone_verified_at: null,
              session_id: session,
              registration_approval_state: 'pending',
            },
            { phone: destination },
            randomUUID(),
          )
          .then(
            () => ({ status: 201 }),
            (error) => ({
              status:
                typeof (error as { getStatus?: unknown }).getStatus ===
                'function'
                  ? (error as { getStatus(): number }).getStatus()
                  : 500,
            }),
          );
        try {
          // Observe the actual service wait instead of relying on a scheduler sleep.
          const deadline = Date.now() + 2000;
          let waiting = false;
          while (Date.now() < deadline) {
            waiting = (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM sessions WHERE id=%') waiting",
              )
            ).rows[0].waiting as boolean;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            waiting,
            true,
            'OTP reached its session lock after locking its user',
          );
          // Logout appends an actor-FK audit while still holding that session row.
          // FOR UPDATE on users would conflict with this FK KEY SHARE and deadlock.
          await blocker.query(
            "INSERT INTO audit_events(actor_id,action,entity_type,entity_id,data) VALUES($1,'auth.logout.fixture','session',$2,'{}')",
            [user.id, session],
          );
          await blocker.query('COMMIT');
          assert.equal((await attempt).status, 401);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM phone_otp_challenges WHERE user_id=$1',
                [user.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM phone_otp_send_events WHERE user_id=$1',
                [user.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(messages.length, before);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await attempt;
        }
      },
    );
    await t.test(
      'session expiry is rechecked after a session-only lock wait without tuple change',
      async () => {
        const user = await actor(),
          destination = phone(),
          before = messages.length;
        const session = (
          await pool.query('SELECT id FROM sessions WHERE user_id=$1', [
            user.id,
          ])
        ).rows[0].id as string;
        await pool.query(
          "UPDATE sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",
          [session],
        );
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
          session,
        ]);
        const attempt = module
          .get(PhoneOtpService)
          .request(
            {
              id: user.id,
              role: 'owner',
              email_verified_at: null,
              phone_verified_at: null,
              session_id: session,
              registration_approval_state: 'pending',
            },
            { phone: destination },
            randomUUID(),
          )
          .then(
            () => 201,
            (error) =>
              typeof (error as { getStatus?: unknown }).getStatus === 'function'
                ? (error as { getStatus(): number }).getStatus()
                : 500,
          );
        try {
          const deadline = Date.now() + 2000;
          let waiting = false;
          while (Date.now() < deadline) {
            waiting = (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM sessions WHERE id=%') waiting",
              )
            ).rows[0].waiting as boolean;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true);
          await new Promise((resolve) => setTimeout(resolve, 450));
          await blocker.query('COMMIT');
          assert.equal(await attempt, 401);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM phone_otp_challenges WHERE user_id=$1',
                [user.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM phone_otp_send_events WHERE user_id=$1',
                [user.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(messages.length, before);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await attempt;
        }
      },
    );
    await t.test(
      'database responses and audits contain no generated codes or OTP pepper',
      async () => {
        const ledgers = (
          await pool.query(
            "SELECT response FROM idempotency_records WHERE scope='phone-otp-request'",
          )
        ).rows;
        assert.ok(ledgers.length > 0);
        for (const { response } of ledgers) {
          assert.deepEqual(Object.keys(response).sort(), [
            'challengeId',
            'delivery',
            'expiresAt',
            'resendAfter',
          ]);
          assert.ok(
            !JSON.stringify(response).includes(process.env.PHONE_OTP_PEPPER!),
          );
        }
        const events = (
          await pool.query(
            "SELECT data FROM audit_events WHERE action LIKE '%otp%'",
          )
        ).rows;
        for (const { data } of events) {
          assert.ok(!('code' in data));
          assert.ok(!('destination' in data));
          assert.ok(!('code_digest' in data));
        }
        for (const message of messages) {
          assert.match(message.code, /^[0-9]{6}$/);
          const stored = await row(message.challengeId);
          assert.notEqual(stored.code_digest, message.code);
          assert.equal(stored.code_digest.length, 64);
        }
      },
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
