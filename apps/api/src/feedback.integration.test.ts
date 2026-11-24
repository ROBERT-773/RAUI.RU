import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { migrate } from './modules/database/migrate';

interface Item {
  id: string;
  authorId: string;
  message: string;
  createdAt: string;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

test('authenticated suggestions are idempotent and only administrators can page through them', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  t.after(() => pool.end());
  await migrate(pool);
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
  const base = (await app.getUrl()) + '/v1';
  async function user(
    role: 'admin' | 'buyer',
    state: 'approved' | 'pending' = 'approved',
  ) {
    const id = randomUUID(),
      secret = token();
    const {
      rows: [row],
    } = await pool.query<{ public_id: string }>(
      `INSERT INTO users(id,email,password_hash,display_name,role,registration_approval_state,email_verified_at,phone_verified_at)
      VALUES($1,$2,'fixture','Test',$3,$4,CASE WHEN $3='admin' THEN now() END, CASE WHEN $3='admin' THEN now() END) RETURNING public_id::text`,
      [id, id + '@example.test', role, state],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [id, hash(secret), hash(token())],
    );
    return { id, secret, publicId: row!.public_id };
  }
  const buyer = await user('buyer'),
    staff = await user('buyer'),
    admin = await user('admin'),
    pending = await user('buyer', 'pending');
  await pool.query(
    "INSERT INTO staff_permission_grants(user_id,permission,granted_by) VALUES ($1,'moderation.read',$2)",
    [staff.id, admin.id],
  );
  function call(path: string, actor?: typeof buyer, body?: unknown) {
    return fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(actor ? { Authorization: 'Bearer ' + actor.secret } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const form = '/account/feedback',
    inbox = '/admin/feedback',
    requestId = randomUUID();
  const body = { requestId, message: '  Покажите школы на карте.  ' };
  assert.equal((await call(form, undefined, body)).status, 401);
  assert.equal((await call(inbox)).status, 401);
  assert.equal((await call(inbox, buyer)).status, 403);
  assert.equal((await call(inbox, staff)).status, 403);
  assert.deepEqual(await (await call(inbox, admin)).json(), {
    items: [],
    nextCursor: null,
  });
  for (const bad of [
    { ...body, message: ' \n ' },
    { ...body, message: 'x'.repeat(2001) },
    { ...body, message: 'nul\0' },
    { ...body, requestId: 'bad' },
    { ...body, authorId: admin.id },
  ]) {
    assert.equal((await call(form, buyer, bad)).status, 400);
  }
  const repeated = await Promise.all([1, 2].map(() => call(form, buyer, body)));
  for (const result of repeated) assert.equal(result.status, 201);
  const [one, two] = await Promise.all(
    repeated.map(async (r) => (await r.json()) as { id: string }),
  );
  assert.ok(one && two);
  assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one), ['id']);
  assert.deepEqual(
    await (
      await call(form, buyer, { ...body, message: body.message.trim() })
    ).json(),
    one,
  );
  assert.equal(
    (await call(form, buyer, { ...body, message: 'Другое предложение' }))
      .status,
    409,
  );
  assert.equal(
    (
      await call(form, staff, {
        ...body,
        message: 'Предложение другого автора',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call(form, pending, {
        requestId: randomUUID(),
        message: 'Пожелание из аккаунта на проверке',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(form, buyer, {
        requestId: randomUUID(),
        message: 'Ещё одно предложение',
      })
    ).status,
    201,
  );
  const page = async (query = '') =>
    (await (await call(inbox + query, admin)).json()) as Page;
  const all = await page();
  assert.equal(all.items.length, 3);
  assert.equal(all.nextCursor, null);
  assert.equal(
    all.items.find((row) => row.id === one.id)?.message,
    body.message.trim(),
  );
  assert.equal(
    all.items.find((row) => row.id === one.id)?.authorId,
    buyer.publicId,
  );
  assert.deepEqual(Object.keys(all.items[0]!).sort(), [
    'authorId',
    'createdAt',
    'id',
    'message',
  ]);
  assert.ok(
    all.items.every((row) => Number.isFinite(Date.parse(row.createdAt))),
  );
  // Identical timestamps exercise the secondary key. A new suggestion between
  // pages must appear on a refresh without shifting the older page.
  await pool.query(
    "UPDATE portal_feedback SET created_at='2026-01-01T12:00:00.123456Z'",
  );
  const original = (await page()).items.map((row) => row.id);
  const first = await page('?limit=2');
  assert.deepEqual(
    first.items.map((row) => row.id),
    original.slice(0, 2),
  );
  assert.ok(first.nextCursor);
  assert.equal(
    (
      await call(form, buyer, {
        requestId: randomUUID(),
        message: 'x'.repeat(2000),
      })
    ).status,
    201,
  );
  await pool.query('DELETE FROM portal_feedback WHERE id=$1', [
    first.items[1]!.id,
  ]);
  const second = await page(
    '?limit=2&cursor=' + encodeURIComponent(first.nextCursor),
  );
  assert.deepEqual(
    second.items.map((row) => row.id),
    original.slice(2),
  );
  assert.equal(second.nextCursor, null);
  for (const query of ['?cursor=wrong', '?limit=0', '?limit=101'])
    assert.equal((await call(inbox + query, admin)).status, 400);
});
