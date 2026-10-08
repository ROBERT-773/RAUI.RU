import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { hash, token } from './common/security';
import {
  VerificationDelivery,
  type VerificationMessage,
} from './modules/auth/delivery';

interface Actor {
  id: string;
  secret: string;
  cookie?: string;
  csrf?: string;
}
interface Applicant {
  id: string;
  email: string;
  actor: Actor;
  request: string;
}
const password = 'Registration-test-password-42';

test('registration approval preserves existing users and enforces onboarding and fresh scoped decisions over HTTP', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const directory = resolve(process.env.LOCAL_PRIVATE_DIR!, 'before-approval');
  await mkdir(directory, { recursive: true });
  // Reproduce a populated deployment before the additive approval migration.
  for (const name of (await readdir('migrations')).filter(
    (name) => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 15,
  ))
    await writeFile(
      resolve(directory, name),
      await readFile('migrations/' + name),
    );
  await migrate(pool, directory);
  const legacy = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Existing owner','owner',now(),now())",
    [legacy, `${legacy}@example.test`],
  );
  const before = (
    await pool.query('SELECT to_jsonb(u) AS data FROM users u WHERE id=$1', [
      legacy,
    ])
  ).rows[0].data;
  await migrate(pool);
  await migrate(pool);
  const upgraded = (
    await pool.query('SELECT to_jsonb(u) AS data FROM users u WHERE id=$1', [
      legacy,
    ])
  ).rows[0].data;
  for (const key of Object.keys(before))
    assert.deepEqual(upgraded[key], before[key], `Preserved legacy ${key}`);
  assert.equal(upgraded.registration_approval_state, 'approved');

  const messages: VerificationMessage[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VerificationDelivery)
    .useValue({
      send: async (message: VerificationMessage) => {
        messages.push(message);
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
  async function call(
    path: string,
    actor?: Actor,
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
  ) {
    // HTTP abuse limits are tested elsewhere; isolate authorization assertions.
    await pool.query('DELETE FROM rate_limits');
    return fetch(base + '/v1' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(actor?.cookie
          ? {
              Cookie: actor.cookie,
              Origin: process.env.WEB_ORIGIN!,
              'X-CSRF-Token': actor.csrf!,
            }
          : actor
            ? { Authorization: 'Bearer ' + actor.secret }
            : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function fixture(role = 'owner', id = randomUUID()): Promise<Actor> {
    if (id !== legacy)
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Staff fixture',$3,now(),now())",
        [id, `${id}@example.test`, role],
      );
    const secret = token();
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [id, hash(secret), hash(token())],
    );
    return { id, secret };
  }
  async function login(email: string, transport = 'bearer'): Promise<Actor> {
    const response = await call('/auth/login', undefined, 'POST', {
      email,
      password,
      transport,
    });
    assert.equal(response.status, 201);
    const data = (await response.json()) as {
      user: { id: string };
      sessionToken: string;
      csrfToken: string;
    };
    return {
      id: data.user.id,
      secret: data.sessionToken,
      ...(transport === 'cookie'
        ? {
            cookie: response.headers.get('set-cookie')!.split(';')[0]!,
            csrf: data.csrfToken,
          }
        : {}),
    };
  }
  async function applicant(): Promise<Applicant> {
    const email = `${randomUUID()}@example.test`;
    const response = await call('/auth/register', undefined, 'POST', {
      email,
      password,
      displayName: 'Pending owner',
      role: 'owner',
    });
    assert.equal(response.status, 201);
    const user = (await response.json()) as {
      id: string;
      registration_approval_state: string;
    };
    assert.equal(user.registration_approval_state, 'pending');
    const actor = await login(email);
    const queue = await call('/admin/registration-approvals', admin);
    assert.equal(queue.status, 200);
    const data = (await queue.json()) as {
      items: { id: string; user_id: string }[];
    };
    const request = data.items.find((item) => item.user_id === user.id);
    assert.ok(request);
    return { id: user.id, email, actor, request: request.id };
  }
  async function contacts(user: Applicant) {
    const emailMessage = messages
      .slice()
      .reverse()
      .find(
        (message) =>
          message.purpose === 'email' && message.destination === user.email,
      )!;
    assert.equal(
      (
        await call('/auth/verification/email/confirm', undefined, 'POST', {
          token: emailMessage.token,
        })
      ).status,
      201,
    );
    const phone =
      '+7999' + String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
    assert.equal(
      (await call('/auth/verification/phone', user.actor, 'POST', { phone }))
        .status,
      201,
    );
    const phoneMessage = messages
      .slice()
      .reverse()
      .find(
        (message) =>
          message.purpose === 'phone' && message.destination === phone,
      )!;
    assert.equal(
      (
        await call('/auth/verification/phone/confirm', user.actor, 'POST', {
          token: phoneMessage.token,
        })
      ).status,
      201,
    );
  }
  const admin = await fixture('admin');
  const reader = await fixture(),
    decider = await fixture();
  const grant = (actor: Actor, permission: string, granted: boolean) =>
    call(`/admin/users/${actor.id}/permissions`, admin, 'PATCH', {
      permission,
      granted,
      reason: 'Registration review duty',
    });
  const decision = (
    user: Applicant,
    actor: Actor,
    value = 'approve',
    key = randomUUID(),
  ) =>
    call(
      `/admin/registration-approvals/${user.request}/decision`,
      actor,
      'POST',
      { decision: value, reason: 'Reviewed contact registration' },
      key,
    );
  try {
    await t.test(
      'populated approved legacy owner retains private access',
      async () => {
        assert.equal(
          (
            await call(
              '/account/collections/favorite',
              await fixture('owner', legacy),
            )
          ).status,
          200,
        );
      },
    );
    const pending = await applicant();
    await t.test(
      'pending bearer and cookie sessions only access onboarding, including logout',
      async () => {
        const cookie = await login(pending.email, 'cookie');
        for (const actor of [pending.actor, cookie]) {
          assert.equal((await call('/auth/me', actor)).status, 200);
          assert.equal((await call('/auth/sessions', actor)).status, 200);
          if (actor.cookie)
            assert.equal((await call('/auth/csrf', actor)).status, 200);
          assert.equal(
            (await call('/account/collections/favorite', actor)).status,
            403,
          );
          assert.equal(
            (
              await call('/organizations', actor, 'POST', {
                name: 'Forbidden agency',
                kind: 'agency',
              })
            ).status,
            403,
          );
          assert.equal(
            (await call('/auth/verification/email', actor, 'POST', {})).status,
            201,
          );
        }
        assert.equal(
          (await call('/auth/logout', cookie, 'POST', {})).status,
          201,
        );
      },
    );
    await t.test(
      'contact verification alone never authorizes business access',
      async () => {
        await contacts(pending);
        const response = await call('/auth/me', pending.actor);
        const me = (await response.json()) as {
          registration_approval_state: string;
          email_verified_at: string;
          phone_verified_at: string;
        };
        assert.ok(me.email_verified_at && me.phone_verified_at);
        assert.equal(me.registration_approval_state, 'pending');
        assert.equal(
          (await call('/account/collections/favorite', pending.actor)).status,
          403,
        );
      },
    );
    await t.test(
      'scoped read and decision permissions cannot cross or grant themselves',
      async () => {
        assert.equal(
          (await call('/admin/registration-approvals', reader)).status,
          403,
        );
        assert.equal(
          (await grant(reader, 'registration.read', true)).status,
          200,
        );
        assert.equal(
          (await grant(decider, 'registration.decide', true)).status,
          200,
        );
        assert.equal(
          (await call('/admin/registration-approvals', reader)).status,
          200,
        );
        assert.equal(
          (
            await call(
              `/admin/registration-approvals/${pending.request}`,
              reader,
            )
          ).status,
          200,
        );
        assert.equal((await decision(pending, reader)).status, 403);
        assert.equal(
          (await call('/admin/registration-approvals', decider)).status,
          403,
        );
        assert.equal((await call('/admin/users', reader)).status, 403);
        assert.equal(
          (
            await call(
              `/admin/users/${reader.id}/permissions`,
              reader,
              'PATCH',
              {
                permission: 'registration.decide',
                granted: true,
                reason: 'Self elevation',
              },
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      'concurrent retries commit one decision and fresh revocation defeats replay',
      async () => {
        const key = randomUUID();
        const beforeAudit = (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='admin.registration.decided'",
            [pending.id],
          )
        ).rows[0].n;
        const responses = await Promise.all([
          decision(pending, decider, 'approve', key),
          decision(pending, decider, 'approve', key),
        ]);
        for (const response of responses) assert.equal(response.status, 201);
        assert.equal(
          (await decision(pending, decider, 'approve', key)).status,
          201,
        );
        const afterAudit = (
          await pool.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='admin.registration.decided'",
            [pending.id],
          )
        ).rows[0].n;
        assert.equal(afterAudit - beforeAudit, 1);
        const event = (
          await pool.query(
            "SELECT actor_id,entity_type,entity_id,data FROM audit_events WHERE entity_id=$1 AND action='admin.registration.decided'",
            [pending.id],
          )
        ).rows[0];
        assert.equal(event.actor_id, decider.id);
        assert.equal(event.entity_type, 'user');
        assert.equal(event.entity_id, pending.id);
        assert.deepEqual(event.data, {
          requestId: pending.request,
          state: 'approved',
          reason: 'Reviewed contact registration',
        });
        assert.equal(
          (await call('/account/collections/favorite', pending.actor)).status,
          200,
        );
        assert.equal(
          (await grant(decider, 'registration.decide', false)).status,
          200,
        );
        assert.equal(
          (await decision(pending, decider, 'approve', key)).status,
          403,
        );
        assert.equal(
          (await grant(decider, 'registration.decide', true)).status,
          200,
        );
        await pool.query(
          'UPDATE users SET email_verified_at=NULL WHERE id=$1',
          [decider.id],
        );
        assert.equal(
          (await decision(pending, decider, 'approve', key)).status,
          403,
        );
        await pool.query(
          'UPDATE users SET email_verified_at=now(),active=false WHERE id=$1',
          [decider.id],
        );
        assert.equal(
          (await decision(pending, decider, 'approve', key)).status,
          401,
        );
        await pool.query('UPDATE users SET active=true WHERE id=$1', [
          decider.id,
        ]);
      },
    );
    await t.test(
      'unverified or inactive applicants, self-review and empty reasons cannot be approved',
      async () => {
        const unverified = await applicant();
        assert.equal((await decision(unverified, admin)).status, 403);
        await contacts(unverified);
        await pool.query('UPDATE users SET active=false WHERE id=$1', [
          unverified.id,
        ]);
        assert.equal((await decision(unverified, admin)).status, 409);
        await pool.query(
          "UPDATE users SET active=true,role='admin',registration_approval_state='approved' WHERE id=$1",
          [unverified.id],
        );
        assert.equal(
          (await decision(unverified, unverified.actor)).status,
          403,
        );
        await pool.query(
          "UPDATE users SET registration_approval_state='pending' WHERE id=$1",
          [unverified.id],
        );
        assert.equal(
          (
            await call(
              `/admin/registration-approvals/${unverified.request}/decision`,
              admin,
              'POST',
              { decision: 'approve', reason: ' ' },
            )
          ).status,
          400,
        );
        assert.equal(
          (await call('/account/collections/favorite', unverified.actor))
            .status,
          403,
        );
      },
    );
    await t.test(
      'rejection revokes all sessions and prevents login',
      async () => {
        const rejected = await applicant();
        await contacts(rejected);
        const cookie = await login(rejected.email, 'cookie');
        assert.equal((await decision(rejected, admin, 'reject')).status, 201);
        for (const actor of [rejected.actor, cookie])
          assert.equal((await call('/auth/me', actor)).status, 401);
        assert.equal(
          (
            await call('/auth/login', undefined, 'POST', {
              email: rejected.email,
              password,
              transport: 'bearer',
            })
          ).status,
          401,
        );
        const active = (
          await pool.query(
            'SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
            [rejected.id],
          )
        ).rows[0].n;
        assert.equal(active, 0);
      },
    );
    for (const wait of ['idempotency', 'grant'] as const) {
      for (const replay of [false, true]) {
        await t.test(
          `registration expired session after ${wait} wait denies ${replay ? 'cached replay' : 'fresh decision'}`,
          async () => {
            const reviewer = await fixture();
            assert.equal(
              (await grant(reviewer, 'registration.decide', true)).status,
              200,
            );
            const user = await applicant();
            await contacts(user);
            const key = randomUUID();
            if (replay)
              assert.equal(
                (await decision(user, reviewer, 'approve', key)).status,
                201,
              );
            async function state() {
              return (
                await pool.query(
                  `SELECT to_jsonb(u) AS applicant,to_jsonb(r) AS request,
                (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM audit_events a WHERE a.entity_id=u.id::text AND a.action='admin.registration.decided') AS audit,
                (SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb) FROM idempotency_records i WHERE i.actor_id=$2 AND i.scope=$3 AND i.key=$4) AS ledger
                FROM users u JOIN registration_approval_requests r ON r.user_id=u.id WHERE r.id=$1`,
                  [
                    user.request,
                    reviewer.id,
                    `registration:${user.request}`,
                    key,
                  ],
                )
              ).rows[0];
            }
            const before = await state();
            const holder = await pool.connect();
            let response: Promise<Response | Error> | undefined;
            try {
              await holder.query('BEGIN');
              const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
                .rows[0].pid as number;
              if (wait === 'idempotency') {
                await holder.query(
                  'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                  [`${reviewer.id}:registration:${user.request}:${key}`],
                );
              } else {
                await holder.query(
                  "SELECT user_id FROM staff_permission_grants WHERE user_id=$1 AND permission='registration.decide' FOR UPDATE",
                  [reviewer.id],
                );
                // The guard and session lookup run before expiry; the permission lock
                // then forces the final authorization to happen after wall time expires.
                await pool.query(
                  "UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=$1 AND token_hash=$2",
                  [reviewer.id, hash(reviewer.secret)],
                );
              }
              response = fetch(
                `${base}/v1/admin/registration-approvals/${user.request}/decision`,
                {
                  method: 'POST',
                  signal: AbortSignal.timeout(15000),
                  headers: {
                    Authorization: `Bearer ${reviewer.secret}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': key,
                  },
                  body: JSON.stringify({
                    decision: 'approve',
                    reason: 'Reviewed contact registration',
                  }),
                },
              ).catch((error: unknown) =>
                error instanceof Error
                  ? error
                  : new Error('Registration transport failed'),
              );
              const deadline = performance.now() + 8000;
              let waiting = false;
              while (performance.now() < deadline) {
                waiting = (
                  await pool.query(
                    'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
                    [pid],
                  )
                ).rows[0].waiting as boolean;
                if (waiting) break;
                await setImmediate();
              }
              assert.ok(
                waiting,
                `HTTP decision must reach held ${wait} lock before expiry`,
              );
              if (wait === 'idempotency') {
                const expired = await pool.query(
                  'UPDATE sessions SET expires_at=clock_timestamp() WHERE user_id=$1 AND token_hash=$2 RETURNING id',
                  [reviewer.id, hash(reviewer.secret)],
                );
                assert.equal(expired.rowCount, 1);
              }
              let expired = false;
              while (performance.now() < deadline) {
                expired = (
                  await pool.query(
                    'SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE user_id=$1 AND token_hash=$2',
                    [reviewer.id, hash(reviewer.secret)],
                  )
                ).rows[0].expired as boolean;
                if (expired) break;
                await setImmediate();
              }
              assert.ok(
                expired,
                'Persisted reviewer session must be expired before releasing the wait',
              );
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
              if (response) await response;
            }
            assert.ok(response);
            const result = await response;
            if (result instanceof Error) throw result;
            await result.arrayBuffer();
            assert.deepEqual(
              { status: result.status, state: await state() },
              { status: 403, state: before },
            );
          },
        );
      }
    }
  } finally {
    await app.close();
    await pool.end();
  }
});
