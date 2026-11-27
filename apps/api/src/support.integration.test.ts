import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { z } from 'zod';
const reference = z.object({ id: z.uuid() });
const queue = z.object({ items: z.array(reference) });
const ticket = z
  .object({
    listingId: z.uuid().nullable(),
    reply: z.string().nullable(),
    repliedAt: z.string().nullable(),
  })
  .passthrough();
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { migrate } from './modules/database/migrate';

test('a guest can retrieve an answer with their receipt while staff handle the open queue', async (t) => {
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
  const base = (await app.getUrl()) + '/v1/';
  const staff = randomUUID(),
    session = token();
  await pool.query(
    "INSERT INTO users(id,email,display_name,role,password_hash,email_verified_at,phone_verified_at,registration_approval_state) VALUES($1,$2,'Support','admin','fixture',now(),now(),'approved')",
    [staff, staff + '@example.test'],
  );
  await pool.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [staff, hash(session), hash(token())],
  );
  const call = (path: string, body?: unknown, admin = false) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(admin ? { Authorization: 'Bearer ' + session } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const payload = {
    receipt: randomUUID(),
    topic: 'complaint',
    listingId: randomUUID(),
    message: 'Адрес в карточке расходится с описанием.',
  };
  assert.equal(
    (await call('support/tickets', { ...payload, message: ' ' })).status,
    400,
  );
  const submit = await call('support/tickets', payload);
  assert.equal(submit.status, 201);
  const { id } = reference.parse(await submit.json());
  assert.deepEqual(await (await call('support/tickets', payload)).json(), {
    id,
  });
  assert.equal(
    (await call('support/tickets', { ...payload, message: 'Другое обращение' }))
      .status,
    409,
  );
  const status = 'support/tickets/status';
  assert.equal((await call(status, { receipt: randomUUID() })).status, 404);
  const statusResponse = await call(status, { receipt: payload.receipt });
  assert.match(statusResponse.headers.get('cache-control') ?? '', /no-store/);
  const row = ticket.parse(await statusResponse.json());
  assert.equal(row.listingId, payload.listingId);
  assert.equal(row.reply, null);
  assert.ok(!('receipt_hash' in row));
  assert.equal((await call('admin/support')).status, 401);
  const question = {
    receipt: randomUUID(),
    topic: 'xml',
    message: 'Почему источник ещё на проверке?',
  };
  const other = reference.parse(
    await (await call('support/tickets', question)).json(),
  );
  assert.deepEqual(
    queue
      .parse(
        await (await call('admin/support?topic=xml', undefined, true)).json(),
      )
      .items.map((r: { id: string }) => r.id),
    [other.id],
  );
  const reply = { reply: 'Адрес передан на проверку модератору.' };
  const answer = 'admin/support/' + id + '/reply';
  assert.equal((await call(answer, reply)).status, 401);
  assert.equal((await call(answer, reply, true)).status, 201);
  assert.equal((await call(answer, reply, true)).status, 201);
  assert.equal(
    (await call(answer, { reply: 'Изменённый ответ' }, true)).status,
    409,
  );
  const answered = ticket.parse(
    await (await call(status, { receipt: payload.receipt })).json(),
  );
  assert.equal(answered.reply, reply.reply);
  assert.ok(answered.repliedAt);
  assert.equal(
    queue.parse(
      await (
        await call('admin/support?topic=complaint', undefined, true)
      ).json(),
    ).items.length,
    0,
  );
  assert.equal(
    ticket.parse(
      await (await call(status, { receipt: question.receipt })).json(),
    ).reply,
    null,
  );
  const stored = await pool.query(
    'SELECT receipt_hash,replied_by FROM support_tickets WHERE id=$1',
    [id],
  );
  assert.equal(stored.rows[0].receipt_hash, hash(payload.receipt));
  assert.equal(stored.rows[0].replied_by, staff);
});
