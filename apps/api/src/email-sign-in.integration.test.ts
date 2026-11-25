import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { EmailSignInDelivery } from './modules/auth/email-sign-in-delivery';
import { SmtpServiceUnavailable } from './modules/auth/reset-smtp';

test('email verification creates one ordinary session and guards account and credential changes', async (t) => {
  assert.match(
    new URL(process.env.TEST_DATABASE_URL!).pathname,
    /^\/raui_test_[a-f0-9]+$/,
  );
  assert.equal(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  t.after(() => db.end());
  await migrate(db);
  Object.assign(process.env, {
    WEB_ORIGIN: 'https://example.test',
    RESET_SMTP_ENABLED: 'true',
    RESET_SMTP_PASSWORD: 'fixture',
    EMAIL_SIGN_IN_ENABLED: 'true',
    EMAIL_SIGN_IN_PEPPER: randomBytes(32).toString('base64url'),
  });
  const sent = new Map<string, string>();
  let deliveries = 0;
  let notifyDeliveryStarted!: () => void;
  let finishDelivery!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => {
    notifyDeliveryStarted = resolve;
  });
  const deliveryCanFinish = new Promise<void>((resolve) => {
    finishDelivery = resolve;
  });
  const m = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailSignInDelivery)
    .useValue({
      async send(to: string, code: string) {
        assert.match(code, /^\d{6}$/);
        sent.set(to, code);
        deliveries++;
        if (to === 'global-failure@example.test') {
          notifyDeliveryStarted();
          await deliveryCanFinish;
          throw new SmtpServiceUnavailable();
        }
        if (to === 'uncertain@example.test')
          throw new Error('synthetic lost response');
      },
    })
    .compile();
  const app = m.createNestApplication({ logger: false, bodyParser: false });
  t.after(() => app.close());
  configure(app);
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()) + '/v1/auth/email-sign-in';
  await t.test(
    'recovery options follow configured delivery independently of account identity',
    async () => {
      const previous = process.env;
      process.env = { ...previous, PHONE_SIGN_IN_ENABLED: 'false' };
      const check = async (
        emailAvailable: boolean,
        resetLinkAvailable: boolean,
      ) => {
        const response = await fetch(
          new URL('password-reset/capabilities', url),
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), {
          smsAvailable: false,
          emailAvailable,
          resetLinkAvailable,
        });
      };
      try {
        delete process.env.VERIFICATION_GATEWAY_URL;
        delete process.env.VERIFICATION_GATEWAY_TOKEN;
        await check(true, true);
        process.env.EMAIL_SIGN_IN_ENABLED = 'false';
        await check(false, true);
        process.env.RESET_SMTP_ENABLED = 'false';
        await check(false, false);
        process.env.VERIFICATION_GATEWAY_URL =
          'https://verification.example.test';
        process.env.VERIFICATION_GATEWAY_TOKEN = 'test-gateway-token';
        await check(false, true);
      } finally {
        process.env = previous;
      }
    },
  );
  const browserKey = randomBytes(32).toString('base64url');
  const post = (
    suffix: string,
    data: unknown,
    key = randomUUID(),
    origin = 'https://example.test',
  ) =>
    fetch(url + suffix, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(data),
    });
  async function begin(
    email: string,
    key = randomUUID(),
    browser = browserKey,
  ) {
    const resp = await post('', { email, browserKey: browser }, key);
    assert.equal(resp.status, 201);
    const value = (await resp.json()) as {
      challengeId: string;
      expiresAt: string;
      resendAfter: string;
    };
    assert.deepEqual(Object.keys(value).sort(), [
      'challengeId',
      'expiresAt',
      'resendAfter',
    ]);
    return value;
  }
  const confirm = (
    email: string,
    id: string,
    extra: Record<string, unknown> = {},
  ) =>
    post('/confirm', {
      email,
      browserKey,
      challengeId: id,
      code: sent.get(email),
      ...extra,
    });
  const savedUser = async (email: string, role = 'buyer', verified = true) => {
    const {
      rows: [r],
    } = await db.query<{ id: string }>(
      `INSERT INTO users(email,display_name,role,password_hash,email_verified_at,registration_approval_state)
      VALUES($1,'Fixture',$2,'fixture',CASE WHEN $3::boolean THEN now() END,'approved') RETURNING id`,
      [email, role, verified],
    );
    return r!.id;
  };
  const noFlood = () =>
    db.query("DELETE FROM rate_limits WHERE key LIKE 'auth:%'");
  const email = 'first@example.test',
    key = randomUUID();
  process.env.EMAIL_SIGN_IN_ENABLED = 'false';
  const disabled = await fetch(url + '/capabilities');
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { available: false });
  assert.equal((await post('', { email, browserKey })).status, 503);
  process.env.EMAIL_SIGN_IN_ENABLED = 'true';
  assert.deepEqual(await (await fetch(url + '/capabilities')).json(), {
    available: true,
  });
  assert.equal(
    (await post('', { email, browserKey }, key, 'https://other.example'))
      .status,
    403,
  );
  assert.equal(
    (await post('', { email: 'not-an-address', browserKey })).status,
    400,
  );
  const challenge = await begin(email.toUpperCase(), key);
  assert.deepEqual(await begin(email, key), challenge);
  assert.equal(deliveries, 1);
  assert.equal(
    Date.parse(challenge.expiresAt) - Date.parse(challenge.resendAfter),
    59 * 60_000,
  );
  const cooldown = await post('', { email, browserKey });
  assert.equal(cooldown.status, 429);
  assert.ok(Number(cooldown.headers.get('Retry-After')) > 0);
  assert.equal(
    (
      await confirm(email, challenge.challengeId, {
        browserKey: randomBytes(32).toString('base64url'),
      })
    ).status,
    401,
  );
  assert.equal(
    (await confirm(email, challenge.challengeId, { registrationRole: 'admin' }))
      .status,
    400,
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM users WHERE email=$1', [
        email,
      ])
    ).rows[0].n,
    0,
  );
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      confirm(email, challenge.challengeId, { registrationRole: 'agent' }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 401]);
  const success = concurrent.find((r) => r.ok)!;
  assert.ok(success.headers.get('set-cookie')?.includes('HttpOnly'));
  const session = (await success.json()) as {
    csrfToken: string;
    user: {
      id: string;
      email: string;
      email_verified_at: string;
      role: string;
      display_name: string;
      registration_approval_state: string;
    };
  };
  assert.ok(session.csrfToken && session.user.email_verified_at);
  assert.equal(session.user.role, 'agent');
  assert.equal(session.user.registration_approval_state, 'pending');
  assert.notEqual(session.user.display_name, email);
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [
        session.user.id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM registration_approval_requests WHERE user_id=$1',
        [session.user.id],
      )
    ).rows[0].n,
    1,
  );
  const existing = 'existing@example.test';
  await savedUser(existing, 'owner');
  const ordinary = await begin(existing);
  const existingSession = await confirm(existing, ordinary.challengeId, {
    registrationRole: 'developer',
  });
  assert.equal(existingSession.status, 201);
  assert.equal(
    ((await existingSession.json()) as { user: { role: string } }).user.role,
    'owner',
  );
  const missing = 'mistyped@example.test',
    recovery = await begin(missing);
  assert.equal(
    (
      await confirm(missing, recovery.challengeId, {
        existingOnly: true,
        registrationRole: 'agent',
      })
    ).status,
    401,
  );
  assert.equal((await confirm(missing, recovery.challengeId)).status, 401);
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM users WHERE email=$1', [
        missing,
      ])
    ).rows[0].n,
    0,
  );
  const admin = await savedUser('admin@example.test', 'admin');
  for (const type of [
    'admin',
    'moderator',
    'unverified',
    'inactive',
    'rejected',
    'password',
    'email',
    'guess',
    'expired',
    'conflict',
  ]) {
    await noFlood();
    const address = type + '@example.test';
    const id =
      type === 'admin'
        ? admin
        : type === 'conflict'
          ? null
          : await savedUser(address, 'buyer', type !== 'unverified');
    if (type === 'moderator')
      await db.query(
        "INSERT INTO staff_permission_grants(user_id,permission,granted_by) VALUES($1,'moderation.read',$2)",
        [id, admin],
      );
    if (type === 'inactive')
      await db.query('UPDATE users SET active=false WHERE id=$1', [id]);
    if (type === 'rejected')
      await db.query(
        "UPDATE users SET registration_approval_state='rejected' WHERE id=$1",
        [id],
      );
    const { challengeId } = await begin(address);
    if (type === 'password')
      await db.query("UPDATE users SET password_hash='changed' WHERE id=$1", [
        id,
      ]);
    if (type === 'email') {
      await db.query(
        "UPDATE users SET email='changed@example.test' WHERE id=$1",
        [id],
      );
      await db.query('UPDATE users SET email=$2 WHERE id=$1', [id, address]);
    }
    if (type === 'guess')
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await confirm(address, challengeId, {
              code: sent.get(address) === '000000' ? '111111' : '000000',
            })
          ).status,
          401,
        );
    if (type === 'expired')
      await db.query(
        "UPDATE email_sign_in_challenges SET created_at=now()-interval '10 minutes', expires_at=now()-interval '1 minute' WHERE id=$1",
        [challengeId],
      );
    if (type === 'conflict') await savedUser(address);
    assert.equal((await confirm(address, challengeId)).status, 401, type);
  }
  await noFlood();
  const address = 'rotations@example.test',
    oldKey = randomUUID(),
    otherBrowser = randomBytes(32).toString('base64url');
  await savedUser(address);
  const cool = async (id: string) =>
    db.query(
      "UPDATE email_sign_in_challenges SET created_at=created_at-interval '61 seconds' WHERE id=$1",
      [id],
    );
  const first = await begin(address, oldKey),
    firstCode = sent.get(address);
  await cool(first.challengeId);
  const other = await begin(address, randomUUID(), otherBrowser),
    otherCode = sent.get(address);
  await cool(other.challengeId);
  const latest = await begin(address),
    latestCode = sent.get(address),
    count = deliveries;
  assert.equal((await begin(address, oldKey)).challengeId, first.challengeId);
  assert.equal(deliveries, count);
  assert.equal(
    (await confirm(address, first.challengeId, { code: firstCode })).status,
    401,
  );
  assert.equal(
    (
      await confirm(address, other.challengeId, {
        code: otherCode,
        browserKey: otherBrowser,
        existingOnly: true,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await confirm(address, latest.challengeId, {
        code: latestCode,
        existingOnly: true,
      })
    ).status,
    201,
  );
  await noFlood();
  const guesses = 'guesses@example.test',
    firstGuesses = await begin(guesses);
  let right = sent.get(guesses);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await confirm(guesses, firstGuesses.challengeId, {
          code: right === '000000' ? '111111' : '000000',
        })
      ).status,
      401,
    );
  await cool(firstGuesses.challengeId);
  const secondGuesses = await begin(guesses, randomUUID(), otherBrowser);
  right = sent.get(guesses);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await confirm(guesses, secondGuesses.challengeId, {
          browserKey: otherBrowser,
          code: right === '000000' ? '111111' : '000000',
        })
      ).status,
      401,
    );
  await cool(secondGuesses.challengeId);
  assert.equal(
    (
      await confirm(guesses, secondGuesses.challengeId, {
        browserKey: otherBrowser,
      })
    ).status,
    401,
  );
  const beforeDenied = deliveries;
  const denied = await post('', { email: guesses, browserKey });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 3500);
  assert.equal(beforeDenied, deliveries);
  const quota = 'quota@example.test';
  for (let i = 0; i < 5; i++)
    await cool(
      (await begin(quota, randomUUID(), randomBytes(32).toString('base64url')))
        .challengeId,
    );
  assert.equal((await post('', { email: quota, browserKey })).status, 429);
  await noFlood();
  const outage = 'global-failure@example.test',
    attempt = randomUUID(),
    countBefore = deliveries;
  const initialRequest = post('', { email: outage, browserKey }, attempt);
  await Promise.race([
    deliveryStarted,
    initialRequest.then((response) => {
      throw new Error(
        'Initial request returned before SMTP delivery started: ' +
          response.status,
      );
    }),
  ]);
  const overlap = post('', { email: outage, browserKey }, attempt);
  const release = setTimeout(finishDelivery, 300);
  try {
    const statuses = (await Promise.all([initialRequest, overlap])).map(
      (response) => response.status,
    );
    assert.deepEqual(statuses, [503, 503]);
  } finally {
    clearTimeout(release);
    finishDelivery();
  }
  assert.equal(
    (await post('', { email: outage, browserKey }, attempt)).status,
    503,
  );
  assert.equal(deliveries, countBefore + 1);
  const uncertain = 'uncertain@example.test',
    uncertainKey = randomUUID();
  const possiblyDelivered = await begin(uncertain, uncertainKey);
  assert.deepEqual(await begin(uncertain, uncertainKey), possiblyDelivered);
  assert.equal(deliveries, countBefore + 2);
  assert.equal(
    (await confirm(uncertain, possiblyDelivered.challengeId)).status,
    201,
  );

  // A new buyer chooses a password inside the cabinet after proving their email.
  await noFlood();
  const buyer = 'choose-password@example.test';
  const loginReceipt = await begin(buyer);
  const signedIn = await confirm(buyer, loginReceipt.challengeId);
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
  type CabinetSession = {
    csrfToken: string;
    user: { id: string; public_id: string };
  };
  const initial = (await signedIn.json()) as CabinetSession;
  const authUrl = url.slice(0, -'/email-sign-in'.length);
  const me = (c: string) => fetch(authUrl + '/me', { headers: { cookie: c } });
  const change = (c: string, csrf: string, fields: Record<string, string>) =>
    fetch(authUrl + '/password', {
      method: 'POST',
      headers: {
        Cookie: c,
        Origin: 'https://example.test',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify(fields),
    });
  const mode = async (c: string) =>
    ((await (await me(c)).json()) as { passwordChangeMode: string })
      .passwordChangeMode;
  assert.equal(await mode(cookie), 'recent-code');
  const password = 'First-test-password-1!';
  assert.equal((await change(cookie, '', { password })).status, 403);
  const changed = await change(cookie, initial.csrfToken, { password });
  assert.equal(changed.status, 201);
  const rotated = changed.headers.getSetCookie()[0]!.split(';')[0]!;
  const result = (await changed.json()) as CabinetSession;
  assert.equal(result.user.id, initial.user.id);
  assert.equal((await me(cookie)).status, 401);
  assert.equal(await mode(rotated), 'current-password');
  assert.equal(
    (
      await change(rotated, result.csrfToken, {
        password: 'Another-password-42!',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await change(rotated, result.csrfToken, {
        currentPassword: 'wrong',
        password: 'Another-password-42!',
      })
    ).status,
    403,
  );
  const again = await change(rotated, result.csrfToken, {
    currentPassword: password,
    password: 'Another-password-42!',
  });
  assert.equal(again.status, 201);
  const credentials = (value: string) =>
    fetch(authUrl + '/login', {
      method: 'POST',
      headers: {
        Origin: 'https://example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: buyer, password: value }),
    });
  assert.equal((await credentials(password)).status, 401);
  const last = await credentials('Another-password-42!');
  assert.equal(last.status, 201);
  assert.equal(
    ((await last.json()) as CabinetSession).user.public_id,
    initial.user.public_id,
  );
  for (const reason of ['expired', 'contact-changed'] as const) {
    await noFlood();
    const address = reason + '-password@example.test';
    const challenge = await begin(address);
    const login = await confirm(address, challenge.challengeId);
    const verified = (await login.json()) as CabinetSession;
    const current = login.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal(await mode(current), 'recent-code');
    if (reason === 'expired') {
      await db.query(
        "UPDATE sessions SET password_change_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",
        [verified.user.id],
      );
    } else {
      await db.query('UPDATE users SET email=$2 WHERE id=$1', [
        verified.user.id,
        'renamed-' + address,
      ]);
    }
    assert.equal(await mode(current), 'current-password');
    assert.equal(
      (await change(current, verified.csrfToken, { password })).status,
      403,
    );
  }
});
