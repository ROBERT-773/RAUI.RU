import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { migrate } from './modules/database/migrate';
import {
  PhoneOtpDelivery,
  type PhoneOtpMessage,
} from './modules/auth/phone-otp-delivery';

interface VerifiedPhone {
  id: string;
  phone: string;
  primary: boolean;
}
interface Settings {
  mode: string;
  phones: VerifiedPhone[];
}

test('seller contact channels preserve login identity, ownership and private/public phone selection', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const before = resolve(
    process.env.LOCAL_PRIVATE_DIR!,
    'before-contact-settings',
  );
  await mkdir(before, { recursive: true });
  for (const file of await readdir('migrations')) {
    if (/^\d{3}_.*\.sql$/.test(file) && Number(file.slice(0, 3)) < 40) {
      await copyFile(resolve('migrations', file), resolve(before, file));
    }
  }
  await migrate(pool, before);
  async function account(phone: string, verified = true) {
    const id = randomUUID(),
      secret = token();
    await pool.query(
      `INSERT INTO users(id,email,password_hash,display_name,role,registration_approval_state,email_verified_at,phone,phone_verified_at)
       VALUES($1,$2,'fixture','Contact fixture','agent','approved',now(),$3,CASE WHEN $4 THEN now() END)`,
      [id, id + '@example.test', phone, verified],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [id, hash(secret), hash(token())],
    );
    return { id, secret };
  }
  const user = await account('+79990000401'),
    other = await account('+79990000402'),
    pending = await account('+79990000403', false);
  await migrate(pool);
  await migrate(pool);
  process.env.PHONE_OTP_ENABLED = 'true';
  process.env.PHONE_OTP_PEPPER = randomBytes(32).toString('base64url');
  process.env.PHONE_OTP_GATEWAY_URL = 'https://otp.example.test/dispatch';
  process.env.PHONE_OTP_GATEWAY_TOKEN = randomBytes(32).toString('base64url');
  const sent: PhoneOtpMessage[] = [];
  let delivery: 'accepted' | 'unavailable' = 'accepted';
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PhoneOtpDelivery)
    .useValue({
      send: async (message: PhoneOtpMessage) => {
        sent.push(message);
        return delivery;
      },
    })
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/v1';
  function call(
    path: string,
    actor?: typeof user,
    method = 'GET',
    body?: unknown,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        ...(actor ? { Authorization: 'Bearer ' + actor.secret } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  const settings = '/account/contact-settings',
    phones = '/account/contact-phones';
  const request = (phone: string, actor = user) =>
    call(phones + '/request', actor, 'POST', { phone });
  const verify = (phone: string, code: string, actor = user) =>
    call(phones + '/verify', actor, 'POST', { phone, code });
  const codeFor = (phone: string) =>
    [...sent].reverse().find((entry) => entry.destination === phone)!.code;
  const ageBudget = () =>
    pool.query(
      "UPDATE phone_otp_send_events SET created_at=created_at-interval '61 seconds' WHERE user_id=$1",
      [user.id],
    );
  try {
    assert.equal((await call(settings)).status, 401);
    const initial = await call(settings, user);
    assert.equal(initial.status, 200);
    const previous = (await initial.json()) as Settings;
    assert.equal(previous.mode, 'messages');
    assert.deepEqual(
      previous.phones.map(({ phone, primary }) => ({ phone, primary })),
      [{ phone: '+79990000401', primary: true }],
    );
    const original = previous.phones[0]!;
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM seller_contact_phones WHERE user_id=$1',
          [pending.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await call(phones + '/' + original.id, user, 'DELETE')).status,
      409,
    );
    assert.equal(
      (await call(phones + '/' + original.id, other, 'DELETE')).status,
      404,
    );
    assert.equal((await request('invalid')).status, 400);
    const first = '+79990000411',
      second = '+79990000412',
      third = '+79990000413';
    const sentFirst = await request('8 (999) 000-04-11');
    assert.equal(sentFirst.status, 201);
    assert.deepEqual(Object.keys((await sentFirst.json()) as object).sort(), [
      'delivery',
      'expiresAt',
      'resendAfter',
    ]);
    assert.equal((await request(first)).status, 201);
    assert.equal(sent.length, 1);
    assert.equal(
      (
        await call('/auth/verification/phone/otp', user, 'POST', {
          phone: second,
        })
      ).status,
      429,
    );
    assert.equal((await verify(first, codeFor(first), other)).status, 400);
    assert.equal(
      (
        await call('/auth/verification/phone/otp/confirm', user, 'POST', {
          challengeId: sent[0]!.challengeId,
          code: codeFor(first),
        })
      ).status,
      400,
    );
    const added = await verify(first, codeFor(first));
    assert.equal(added.status, 201);
    const extra = ((await added.json()) as Settings).phones[1]!;
    assert.deepEqual(
      { phone: extra.phone, primary: extra.primary },
      { phone: first, primary: false },
    );
    assert.equal((await verify(first, codeFor(first))).status, 400);
    const invalidated = '+79990000419';
    const otherLogin = { phone: '+79990000402' };
    assert.equal((await request(invalidated, other)).status, 201);
    const badCode = codeFor(invalidated) === '111111' ? '222222' : '111111';
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal((await verify(invalidated, badCode, other)).status, 400);
    assert.equal(
      (await verify(invalidated, codeFor(invalidated), other)).status,
      400,
    );
    assert.deepEqual(
      (await pool.query('SELECT phone FROM users WHERE id=$1', [other.id]))
        .rows[0],
      otherLogin,
    );
    await pool.query(
      "UPDATE phone_otp_send_events SET created_at=created_at-interval '61 seconds' WHERE user_id=$1",
      [other.id],
    );
    delivery = 'unavailable';
    const unavailable = await request(invalidated, other);
    assert.equal(unavailable.status, 503);
    assert.equal(
      ((await unavailable.json()) as { code: string }).code,
      'phone_otp_unavailable',
    );
    assert.equal(
      (await verify(invalidated, codeFor(invalidated), other)).status,
      400,
    );
    delivery = 'accepted';
    await ageBudget();
    assert.equal((await request(second)).status, 201);
    await ageBudget();
    assert.equal((await request(third)).status, 201);
    const raced = await Promise.all(
      [second, third].map((p) => verify(p, codeFor(p))),
    );
    assert.deepEqual(raced.map((v) => v.status).sort(), [201, 409]);
    assert.equal(
      (await pool.query('SELECT phone FROM users WHERE id=$1', [user.id]))
        .rows[0].phone,
      original.phone,
    );
    const prop = await call('/properties', user, 'POST', {
      category: 'apartment',
      address: {
        formatted: 'Тестовый адрес',
        locality: 'Москва',
        longitude: 37.62,
        latitude: 55.76,
      },
      attributes: { area: 42 },
    });
    assert.equal(prop.status, 201);
    const listing = await call('/listings', user, 'POST', {
      propertyId: ((await prop.json()) as { id: string }).id,
      dealType: 'sale',
      title: 'Тестовая квартира',
    });
    assert.equal(listing.status, 201);
    const listingId = ((await listing.json()) as { id: string }).id;
    await pool.query("UPDATE listings SET status='moderation' WHERE id=$1", [
      listingId,
    ]);
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'both' })).status,
      200,
    );
    const blocked = await call(settings, user, 'PATCH', { mode: 'calls' });
    assert.equal(blocked.status, 409);
    const error = (await blocked.json()) as {
      code: string;
      total: number;
      listings: { id: string; title: string }[];
    };
    assert.equal(error.code, 'contact_phone_required');
    assert.equal(error.total, 1);
    assert.deepEqual(error.listings, [
      { id: listingId, title: 'Тестовая квартира' },
    ]);
    await pool.query(
      'INSERT INTO listing_contact_phones(listing_id,seller_id,phone_id,position) VALUES($1,$2,$3,1)',
      [listingId, user.id, extra.id],
    );
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'calls' })).status,
      200,
    );
    assert.equal(
      (await call(phones + '/' + extra.id, user, 'DELETE')).status,
      409,
    );
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'messages' })).status,
      200,
    );
    assert.equal(
      (await call(phones + '/' + extra.id, user, 'DELETE')).status,
      200,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM listing_contact_phones WHERE listing_id=$1',
          [listingId],
        )
      ).rows[0].n,
      0,
    );
    await pool.query(
      'INSERT INTO listing_contact_phones(listing_id,seller_id,phone_id,position) VALUES($1,$2,$3,1)',
      [listingId, user.id, original.id],
    );
    const newLoginPhone = '+79990000409';
    const legacyToken = token();
    await ageBudget();
    const newLoginOtp = await call(
      '/auth/verification/phone/otp',
      user,
      'POST',
      { phone: newLoginPhone },
    );
    assert.equal(newLoginOtp.status, 201);
    const { challengeId } = (await newLoginOtp.json()) as {
      challengeId: string;
    };
    const otpBody = { challengeId, code: codeFor(newLoginPhone) };
    await pool.query(
      "INSERT INTO auth_challenges(user_id,purpose,token_hash,destination,expires_at) VALUES ($1,'phone',$2,$3,now()+interval '5 minutes')",
      [user.id, hash(legacyToken), newLoginPhone],
    );
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'calls' })).status,
      200,
    );
    for (const [path, body] of [
      ['/auth/verification/phone', { phone: newLoginPhone }],
      ['/auth/verification/phone/otp', { phone: newLoginPhone }],
      ['/auth/verification/phone/confirm', { token: legacyToken }],
      ['/auth/verification/phone/otp/confirm', otpBody],
    ] as const) {
      const guarded = await call(path, user, 'POST', body);
      assert.equal(guarded.status, 409);
      const details = (await guarded.json()) as {
        code: string;
        listings: { id: string }[];
      };
      assert.equal(details.code, 'contact_phone_required');
      assert.equal(details.listings[0]?.id, listingId);
    }
    assert.equal(
      (await pool.query('SELECT phone FROM users WHERE id=$1', [user.id]))
        .rows[0].phone,
      original.phone,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT phone_id FROM listing_contact_phones WHERE listing_id=$1',
          [listingId],
        )
      ).rows[0].phone_id,
      original.id,
    );
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'messages' })).status,
      200,
    );
    assert.equal(
      (
        await call(
          '/auth/verification/phone/otp/confirm',
          user,
          'POST',
          otpBody,
        )
      ).status,
      201,
    );
    const changed = (await (await call(settings, user)).json()) as Settings;
    assert.equal(changed.phones[0]?.phone, '+79990000409');
    assert.notEqual(changed.phones[0]?.id, original.id);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM listing_contact_phones WHERE listing_id=$1',
          [listingId],
        )
      ).rows[0].n,
      0,
    );
    await pool.query(
      'INSERT INTO listing_contact_phones(listing_id,seller_id,phone_id,position) VALUES($1,$2,$3,1)',
      [listingId, user.id, changed.phones[0]!.id],
    );
    assert.equal(
      (await call(settings, user, 'PATCH', { mode: 'calls' })).status,
      200,
    );
    await pool.query('UPDATE users SET phone_verified_at=NULL WHERE id=$1', [
      user.id,
    ]);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM listing_contact_phones WHERE listing_id=$1',
          [listingId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT contact_mode FROM users WHERE id=$1', [
          user.id,
        ])
      ).rows[0].contact_mode,
      'calls',
    );
  } finally {
    await app.close();
  }
});
