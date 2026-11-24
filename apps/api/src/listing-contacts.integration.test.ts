import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { migrate } from './modules/database/migrate';
type Settings = {
  canEdit: boolean;
  mode: string;
  phones: { id: string; phone: string }[];
  selectedPhoneIds: string[];
};

test('listing selection, visibility, and inquiries follow the seller contact preferences', async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/v1';
    async function account(role: string, phone: string) {
      const id = randomUUID(),
        secret = token();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,phone,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Test',$3,$4,now(),now())",
        [id, id + '@example.test', role, phone],
      );
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [id, hash(secret), hash(token())],
      );
      return { id, secret };
    }
    const seller = await account('agent', '+79990000001'),
      coworker = await account('agent', '+79990000002'),
      buyer = await account('buyer', '+79990000003');
    const call = (
      path: string,
      secret?: string,
      method = 'GET',
      body?: unknown,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          ...(secret ? { Authorization: 'Bearer ' + secret } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const listing = randomUUID(),
      org = randomUUID(),
      prop = randomUUID(),
      addr = randomUUID(),
      src = randomUUID();
    await pool.query(
      "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Test','agency',$2)",
      [org, seller.id],
    );
    await pool.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')",
      [org, seller.id, coworker.id],
    );
    await pool.query(
      "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Test','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
      [addr],
    );
    await pool.query(
      `INSERT INTO properties(id,created_by,organization_id,category_code,address_id,attributes) VALUES($1,$2,$3,'apartment',$4,'{"area":55,"kitchen_area":10}')`,
      [prop, seller.id, org, addr],
    );
    await pool.query(
      "INSERT INTO listing_sources(id,kind,organization_id) VALUES($1,'agency',$2)",
      [src, org],
    );
    await pool.query(
      "INSERT INTO listings(id,property_id,source_id,seller_id,organization_id,deal_type,title,price,status,description) VALUES($1,$2,$3,$4,$5,'sale','Test property',100000,'published','Valid listing description')",
      [listing, prop, src, seller.id, org],
    );
    const path = '/listings/' + listing,
      settings = path + '/contact-settings';
    const asPublic = async () => {
      const r = await call(path + '/public/contact');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      return r.json();
    };
    assert.deepEqual(await asPublic(), { messagesAllowed: true, phones: [] });
    const get = async (secret: string) => {
      const r = await call(settings, secret);
      assert.equal(r.status, 200);
      return (await r.json()) as Settings;
    };
    const ownLogin = (await get(seller.secret)).phones[0]!;
    const {
      rows: [addon],
    } = await pool.query(
      "INSERT INTO seller_contact_phones(user_id,phone,slot) VALUES($1,'+79990000004',1) RETURNING id,phone",
      [seller.id],
    );
    const {
      rows: [foreign],
    } = await pool.query(
      'SELECT id FROM seller_contact_phones WHERE user_id=$1',
      [coworker.id],
    );
    const put = (secret: string, phoneIds: string[]) =>
      call(settings, secret, 'PUT', { phoneIds });
    assert.deepEqual(await get(coworker.secret), {
      canEdit: false,
      mode: 'messages',
      phones: [],
      selectedPhoneIds: [],
    });
    assert.equal((await call(settings, buyer.secret)).status, 403);
    assert.equal((await put(coworker.secret, [addon.id])).status, 403);
    assert.equal((await put(seller.secret, [foreign.id])).status, 400);
    assert.equal((await put(seller.secret, [addon.id, addon.id])).status, 400);
    const selected = [addon.id, ownLogin.id];
    assert.deepEqual(
      ((await (await put(seller.secret, selected)).json()) as Settings)
        .selectedPhoneIds,
      selected,
    );
    assert.deepEqual(await asPublic(), { messagesAllowed: true, phones: [] });
    await pool.query("UPDATE users SET contact_mode='calls' WHERE id=$1", [
      seller.id,
    ]);
    assert.deepEqual(await asPublic(), {
      messagesAllowed: false,
      phones: [addon.phone, ownLogin.phone],
    });
    const response = await call(path + '/public');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(
      ((await response.json()) as { contact: unknown }).contact,
      await asPublic(),
    );
    assert.deepEqual(await get(coworker.secret), {
      canEdit: false,
      mode: 'calls',
      phones: [addon, ownLogin],
      selectedPhoneIds: selected,
    });
    assert.equal(
      (
        await call('/account/inquiries/' + listing, buyer.secret, 'POST', {
          body: 'Интересует квартира',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await pool.query('SELECT id FROM inquiry_threads WHERE listing_id=$1', [
          listing,
        ])
      ).rowCount,
      0,
    );
    assert.equal((await put(seller.secret, [])).status, 400);
    assert.equal((await put(seller.secret, [addon.id])).status, 200);
    const lostReply = await call(settings, seller.secret, 'PUT', {
      phoneIds: [addon.id],
      expectedPhoneIds: selected,
    });
    assert.equal(lostReply.status, 200);
    const stale = await call(settings, seller.secret, 'PUT', {
      phoneIds: [ownLogin.id],
      expectedPhoneIds: selected,
    });
    assert.equal(stale.status, 409);
    assert.equal(
      ((await stale.json()) as { code: string }).code,
      'LISTING_CONTACT_SELECTION_CHANGED',
    );
    assert.deepEqual(await asPublic(), {
      messagesAllowed: false,
      phones: [addon.phone],
    });
    assert.equal((await get(seller.secret)).phones.length, 2);
    await pool.query("UPDATE users SET contact_mode='both' WHERE id=$1", [
      seller.id,
    ]);
    const inquire = () =>
      call('/account/inquiries/' + listing, buyer.secret, 'POST', {
        body: 'Интересует квартира',
      });
    const opened = await inquire();
    assert.equal(opened.status, 201);
    const { threadId } = (await opened.json()) as { threadId: string };
    await pool.query("UPDATE users SET contact_mode='calls' WHERE id=$1", [
      seller.id,
    ]);
    assert.equal((await inquire()).status, 403);
    assert.equal(
      (
        await call(
          '/account/threads/' + threadId + '/messages',
          buyer.secret,
          'POST',
          {
            body: 'Спасибо за ответ',
          },
        )
      ).status,
      201,
    );
    assert.equal(
      (await put(seller.secret, [ownLogin.id, addon.id])).status,
      200,
    );
    await pool.query(
      "UPDATE users SET phone='+79990000009',phone_verified_at=now(),contact_mode='both' WHERE id=$1",
      [seller.id],
    );
    assert.deepEqual(await asPublic(), {
      messagesAllowed: true,
      phones: [addon.phone],
    });
    assert.equal((await put(seller.secret, [ownLogin.id])).status, 400);
    await pool.query("UPDATE listings SET status='processing' WHERE id=$1", [
      listing,
    ]);
    assert.equal((await call(path + '/public/contact')).status, 404);
    assert.equal((await call(path + '/public')).status, 404);
    assert.deepEqual(await get(coworker.secret), {
      canEdit: false,
      mode: 'both',
      phones: [],
      selectedPhoneIds: [],
    });
    assert.equal((await put(seller.secret, [])).status, 200);
    const {
      rows: [cur],
    } = await pool.query('SELECT version FROM listings WHERE id=$1', [listing]);
    const blocked = await call(path + '/transitions', seller.secret, 'POST', {
      version: cur.version,
      status: 'moderation',
    });
    assert.equal(blocked.status, 400);
    assert.match(
      ((await blocked.json()) as { message: string }).message,
      /номер/,
    );
    const admin = await account('admin', '+79990000005');
    const caseId = randomUUID();
    await pool.query("UPDATE listings SET status='moderation' WHERE id=$1", [
      listing,
    ]);
    await pool.query(
      'INSERT INTO moderation_cases(id,listing_id,listing_version) VALUES($1,$2,$3)',
      [caseId, listing, cur.version],
    );
    const decision = await call(
      '/admin/moderation/' + caseId + '/decision',
      admin.secret,
      'POST',
      { decision: 'approve', reason: 'Contact selection check' },
    );
    assert.equal(decision.status, 400);
    assert.equal(
      ((await decision.json()) as { code: string }).code,
      'LISTING_CONTACT_PHONE_REQUIRED',
    );
    const log = await pool.query(
      "SELECT data FROM audit_events WHERE entity_id=$1 AND action='listing.contacts.changed'",
      [listing],
    );
    assert.ok(log.rowCount);
    for (const row of log.rows)
      assert.deepEqual(Object.keys(row.data), ['phoneCount']);
  } finally {
    await app.close();
    await pool.end();
  }
});
