import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';

interface DirectoryItem {
  id: string;
  matchedPhone?: string | null;
  publiclyVisible?: boolean;
}
interface Page {
  items: DirectoryItem[];
  nextCursor: string | null;
}

test('administrators search users and all listing states with scoped results and stable pages', async (t) => {
  assert.match(
    new URL(process.env.TEST_DATABASE_URL!).pathname,
    /^\/raui_test_[a-f0-9]+$/,
  );
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const migrationPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  try {
    await migrate(migrationPool);
  } finally {
    await migrationPool.end();
  }
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({
    logger: false,
    bodyParser: false,
  });
  t.after(() => app.close());
  configure(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database);
  const base = (await app.getUrl()) + '/v1/admin/search/';
  async function user(role: string, name: string, phone: string | null = null) {
    const secret = token(),
      id = randomUUID(),
      email = id + '@example.test';
    const [row] = await db.rows<{ publicId: string }>(
      `INSERT INTO users
      (id,email,password_hash,display_name,role,registration_approval_state,email_verified_at,phone_verified_at,phone)
      VALUES ($1,$2,'fixture',$3,$4,'approved',now(),now(),$5) RETURNING public_id::text AS "publicId"`,
      [id, email, name, role, phone],
    );
    await db.pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [id, hash(secret), hash(token())],
    );
    return { id, email, secret, publicId: row!.publicId };
  }
  const target = await user('agent', 'Раиса 100%_Дом', '+79000000031');
  const admin = await user('admin', 'Admin'),
    staff = await user('buyer', 'Moderator'),
    buyer = await user('buyer', 'Buyer');
  await db.pool.query(
    "INSERT INTO staff_permission_grants(user_id,permission,granted_by) VALUES($1,'moderation.read',$2)",
    [staff.id, admin.id],
  );
  await db.pool.query(
    "INSERT INTO seller_contact_phones(user_id,phone,slot) VALUES($1,'+79000000032',1)",
    [target.id],
  );
  const request = (kind: string, body: unknown, secret?: string) =>
    fetch(base + kind, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: 'Bearer ' + secret } : {}),
      },
      body: JSON.stringify(body),
    });
  const search = async (
    kind: string,
    query: string,
    after?: string,
  ): Promise<Page> => {
    const r = await request(
      kind,
      { query, ...(after ? { after } : {}) },
      admin.secret,
    );
    assert.equal(r.status, 200);
    return (await r.json()) as Page;
  };
  for (const kind of ['users', 'listings']) {
    assert.equal((await request(kind, { query: 'test' })).status, 401);
    assert.equal(
      (await request(kind, { query: 'test' }, buyer.secret)).status,
      403,
    );
    assert.equal(
      (await request(kind, { query: 'test' }, staff.secret)).status,
      403,
    );
    for (const bad of [
      { query: '  ' },
      { query: '%_' },
      { query: 'a\0b' },
      { query: 'x'.repeat(321) },
      { query: '1', after: 'bad' },
      { query: 'q', ownerId: target.id },
    ])
      assert.equal((await request(kind, bad, admin.secret)).status, 400);
  }
  const userRow = {
    id: target.id,
    publicId: target.publicId,
    email: target.email,
    name: 'Раиса 100%_Дом',
    active: true,
    role: 'agent',
    matchedPhone: null,
  };
  for (const query of [
    target.publicId,
    target.email.toUpperCase(),
    ' аИСа ',
    '100%_доМ',
  ])
    assert.deepEqual(await search('users', query), {
      items: [userRow],
      nextCursor: null,
    });
  for (const [query, matchedPhone] of [
    ['8 (900) 000-00-31', '+79000000031'],
    ['+7 900 000-00-31', '+79000000031'],
    ['8 (900) 000-00-32', '+79000000032'],
  ]) {
    assert.deepEqual(await search('users', query!), {
      items: [{ ...userRow, matchedPhone }],
      nextCursor: null,
    });
  }
  // Legacy users.phone rows may predate the E.164 contact-phone backfill.
  const legacy = await user('owner', 'Старый профиль', '8 (900) 000-00-41');
  for (const query of ['8 (900) 000-00-41', '+79000000041']) {
    assert.deepEqual(
      (await search('users', query)).items.map(({ id, matchedPhone }) => [
        id,
        matchedPhone,
      ]),
      [[legacy.id, '+79000000041']],
    );
  }
  for (const query of ['+7 (900) 000-00-4', '8 (900) 000-00-42']) {
    assert.deepEqual((await search('users', query)).items, []);
  }
  assert.deepEqual(
    (await search('users', legacy.email)).items.map(({ id, matchedPhone }) => [
      id,
      matchedPhone,
    ]),
    [[legacy.id, null]],
  );
  assert.deepEqual(
    (await search('users', '8 (900) 000-00-31')).items.map(({ id }) => id),
    [target.id],
  );
  for (const miss of [
    '900000003',
    '+7 (900) 000',
    'example.test',
    target.email.slice(1),
    '100x_доМ',
    '9'.repeat(300),
  ])
    assert.deepEqual(await search('users', miss), {
      items: [],
      nextCursor: null,
    });
  // Registration lookup also works before verification (there is no slot-zero row).
  await db.pool.query(
    'UPDATE users SET phone=$2,phone_verified_at=NULL WHERE id=$1',
    [buyer.id, '+79000000033'],
  );
  assert.deepEqual(
    (await search('users', '8(900)0000033')).items.map((x) => [
      x.id,
      x.matchedPhone,
    ]),
    [[buyer.id, '+79000000033']],
  );
  const { rows: ids } = await db.pool.query<{
    id: string;
  }>(`INSERT INTO users(email,password_hash,display_name,role)
    SELECT gen_random_uuid()::text||'@test.invalid','fixture','Directory user '||i,'owner' FROM generate_series(1,26)i RETURNING id`);
  const firstUsers = await search('users', 'directory USER');
  assert.equal(firstUsers.items.length, 25);
  assert.equal(firstUsers.nextCursor, firstUsers.items.at(-1)!.id);
  await db.pool.query('DELETE FROM users WHERE id=$1', [firstUsers.nextCursor]);
  const nextUsers = await search(
    'users',
    'directory USER',
    firstUsers.nextCursor!,
  );
  assert.deepEqual(
    [...firstUsers.items, ...nextUsers.items].map((x) => x.id),
    ids.map((x) => x.id).sort(),
  );
  assert.equal(nextUsers.nextCursor, null);
  const [property] = await db.rows<{ id: string }>(
    `WITH a AS (INSERT INTO addresses(formatted,locality,point) VALUES('Москва, улица 70%_Парк','Москва',ST_SetSRID(ST_MakePoint(37,55),4326)) RETURNING id)
    INSERT INTO properties(created_by,category_code,address_id) SELECT $1,'apartment',id FROM a RETURNING id`,
    [target.id],
  );
  const [source] = await db.rows<{ id: string }>(
    "INSERT INTO listing_sources(kind) VALUES ('direct') RETURNING id",
  );
  async function listing(status: string, seller: string, title: string) {
    const [l] = await db.rows<{ id: string }>(
      `INSERT INTO listings(property_id,source_id,seller_id,deal_type,price,title,status)
       VALUES($1,$2,$3,'long_rent',100,$4,$5) RETURNING id`,
      [property!.id, source!.id, seller, title, status],
    );
    return l!.id;
  }
  const published = await listing('published', target.id, 'Светлая квартира');
  for (const s of ['draft', 'moderation', 'archived', 'paused']) {
    const id = await listing(s, target.id, 'Другая квартира');
    assert.deepEqual(
      (await search('listings', id)).items.map((x) => [
        x.id,
        x.publiclyVisible,
      ]),
      [[id, false]],
    );
  }
  const hidden = await listing('published', buyer.id, 'Тоже квартира');
  const otherAgent = await user('agent', 'Другой агент');
  for (const [secret, status] of [
    [target.secret, 204],
    [otherAgent.secret, 403],
    [buyer.secret, 403],
    [undefined, 401],
  ] as const) {
    const access = await fetch(
      (await app.getUrl()) + '/v1/listings/' + published + '/manage',
      {
        headers: secret ? { Authorization: 'Bearer ' + secret } : {},
      },
    );
    assert.equal(access.status, status);
  }
  const sellerMatches = await request(
    'listings',
    { query: target.publicId, by: 'seller' },
    admin.secret,
  );
  assert.equal(sellerMatches.status, 200);
  const { items: sellerListings } = (await sellerMatches.json()) as {
    items: { id: string; status: string; sellerPublicId: string }[];
  };
  assert.deepEqual(sellerListings.map((row) => row.status).sort(), [
    'archived',
    'draft',
    'moderation',
    'paused',
    'published',
  ]);
  assert.ok(
    sellerListings.every(
      (row) => row.sellerPublicId === target.publicId && row.id !== hidden,
    ),
  );
  assert.deepEqual(
    (await search('listings', hidden)).items.map((x) => x.publiclyVisible),
    [false],
  );
  const expectedListing = {
    id: published,
    price: '100.00',
    area: null,
    floor: null,
    sellerPublicId: target.publicId,
    title: 'Светлая квартира',
    address: 'Москва, улица 70%_Парк',
    status: 'published',
    dealType: 'long_rent',
    publiclyVisible: true,
  };
  const cabinet = await fetch((await app.getUrl()) + '/v1/listings?limit=20', {
    headers: { Authorization: 'Bearer ' + target.secret },
  });
  assert.equal(cabinet.status, 200);
  const ownRows = (await cabinet.json()) as {
    id: string;
    address: string;
    floor: string | null;
  }[];
  assert.equal(
    ownRows.find((row) => row.id === published)?.address,
    expectedListing.address,
  );
  assert.equal(ownRows.find((row) => row.id === published)?.floor, null);
  assert.ok(!ownRows.some((row) => row.id === hidden));
  const filtered = await fetch(
    (await app.getUrl()) + '/v1/listings?status=archived&deal=rent&q=70%25_',
    {
      headers: { Authorization: 'Bearer ' + target.secret },
    },
  );
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    ((await filtered.json()) as { status: string }[]).map((row) => row.status),
    ['archived'],
  );
  for (const query of [published.toUpperCase(), 'ВЕТлая'])
    assert.deepEqual(await search('listings', query), {
      items: [expectedListing],
      nextCursor: null,
    });
  assert.equal((await search('listings', '70%_парК')).items.length, 6);
  assert.deepEqual((await search('listings', '70x_Парк')).items, []);
  const { rows: listingIds } = await db.pool.query<{ id: string }>(
    `INSERT INTO listings(property_id,source_id,seller_id,deal_type,title,status)
    SELECT $1,$2,$3,'sale','Directory listing '||i,'draft' FROM generate_series(1,26)i RETURNING id`,
    [property!.id, source!.id, target.id],
  );
  const firstListings = await search('listings', 'Directory listing');
  assert.equal(firstListings.items.length, 25);
  assert.equal(firstListings.nextCursor, firstListings.items.at(-1)!.id);
  const nextListings = await search(
    'listings',
    'Directory listing',
    firstListings.nextCursor!,
  );
  assert.equal(nextListings.nextCursor, null);
  assert.deepEqual(
    [...firstListings.items, ...nextListings.items].map((x) => x.id),
    listingIds.map((x) => x.id).sort(),
  );
  // The standard admin guard must also enforce session assurance when enabled.
  const previousKey = process.env.STAFF_TOTP_ENCRYPTION_KEY,
    previousFlag = process.env.STAFF_TOTP_REQUIRED;
  try {
    process.env.STAFF_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    process.env.STAFF_TOTP_REQUIRED = 'true';
    for (const kind of ['users', 'listings'])
      assert.equal(
        (await request(kind, { query: 'test' }, admin.secret)).status,
        403,
      );
  } finally {
    if (previousKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_KEY;
    else process.env.STAFF_TOTP_ENCRYPTION_KEY = previousKey;
    if (previousFlag === undefined) delete process.env.STAFF_TOTP_REQUIRED;
    else process.env.STAFF_TOTP_REQUIRED = previousFlag;
  }
});
