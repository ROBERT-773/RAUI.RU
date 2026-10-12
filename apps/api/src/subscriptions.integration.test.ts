import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { hash, token } from './common/security';
import { Database } from './modules/database/database';
import { Audit } from './modules/audit/audit';
import {
  NotificationAdapter,
  NotificationWorker,
  type DeliveryEnvelope,
} from './modules/professional/notifications';

class LocalTransport extends NotificationAdapter {
  calls: DeliveryEnvelope[] = [];
  started: (() => void) | undefined;
  wait: Promise<void> | undefined;
  get configured() {
    return true;
  }
  async send(envelope: DeliveryEnvelope) {
    this.calls.push(envelope);
    this.started?.();
    await this.wait;
  }
}

test(
  'subscription authoritative events, transport and consent concurrency on PostgreSQL',
  { timeout: 90000 },
  async (t) => {
    assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await migrate(pool);
    const transport = new LocalTransport();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(NotificationAdapter)
      .useValue(transport)
      .compile();
    const app = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });
    configure(app);
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database),
      audit = app.get(Audit),
      worker = app.get(NotificationWorker),
      base = await app.getUrl();
    const seller = randomUUID(),
      subscriber = randomUUID(),
      outsider = randomUUID(),
      listing = randomUUID();
    const secrets = new Map<string, string>();
    try {
      for (const id of [seller, subscriber, outsider]) {
        const secret = token();
        secrets.set(id, secret);
        await pool.query(
          "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Subscriber fixture','agent',now(),now())",
          [id, id + '@example.test'],
        );
        await pool.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
          [id, hash(secret), hash(token())],
        );
        await pool.query(
          'INSERT INTO notification_preferences(user_id,email) VALUES($1,true)',
          [id],
        );
      }
      const address = randomUUID(),
        property = randomUUID(),
        source = randomUUID();
      await pool.query(
        "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Subscription fixture','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
        [address],
      );
      await pool.query(
        "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,'{\"area\":55}')",
        [property, seller, address],
      );
      await pool.query(
        "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
        [source],
      );
      await pool.query(
        "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,title,price,status) VALUES($1,$2,$3,$4,'sale','Subscription fixture',100,'published')",
        [listing, property, source, seller],
      );
      const path = '/v1/account/listing-subscriptions/' + listing;
      const request = (
        url: string,
        method = 'GET',
        body?: unknown,
        user = subscriber,
      ) =>
        fetch(base + url, {
          method,
          headers: {
            Authorization: 'Bearer ' + secrets.get(user),
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const preferences = {
        events: ['price_drop', 'availability'],
        channels: ['email'],
        frequency: 'immediate',
        consent: true,
      };
      async function save(version: number) {
        return request(path, 'POST', { ...preferences, version });
      }
      async function changed(price: string, rollback = false) {
        await db.transaction(async (sql) => {
          const before = (
            await sql.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [
              listing,
            ])
          ).rows[0];
          const after = (
            await sql.query(
              'UPDATE listings SET price=$2,version=version+1 WHERE id=$1 RETURNING *',
              [listing, price],
            )
          ).rows[0];
          await audit.history(
            sql,
            seller,
            listing,
            'listing.updated',
            before,
            after,
          );
          if (rollback) throw new Error('rollback-fixture');
        });
      }
      await t.test(
        'only supported modes; version zero creates once and ownership is isolated',
        async () => {
          assert.equal(
            (
              await request(path, 'POST', {
                ...preferences,
                version: 0,
                frequency: 'daily',
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(path, 'POST', {
                ...preferences,
                version: 0,
                channels: ['in_app'],
              })
            ).status,
            400,
          );
          const results = await Promise.all([save(0), save(0)]);
          assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
          assert.equal(
            ((await (await request(path)).json()) as { version: number })
              .version,
            1,
          );
          assert.equal(
            (
              (await (
                await request(path, 'GET', undefined, outsider)
              ).json()) as { version: number }
            ).version,
            0,
          );
          assert.equal(
            (await request(path + '/disable', 'POST', { version: 1 }, outsider))
              .status,
            404,
          );
        },
      );
      await t.test(
        'rollback removes history and deliveries; genuine committed change enqueues and sends',
        async () => {
          await assert.rejects(changed('90', true), /rollback-fixture/);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM notification_deliveries',
              )
            ).rows[0].n,
            0,
          );
          await changed('90');
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM notification_deliveries',
              )
            ).rows[0].n,
            1,
          );
          await worker.once();
          assert.equal(transport.calls.length, 1);
          assert.equal(
            transport.calls[0]!.kind,
            'subscription.listing.price_drop',
          );
        },
      );
      await t.test(
        'completed unsubscribe blocks stale update and queued delivery',
        async () => {
          await changed('80');
          assert.equal(
            (await request(path + '/disable', 'POST', { version: 1 })).status,
            201,
          );
          assert.equal((await save(1)).status, 409);
          await worker.once();
          assert.equal(transport.calls.length, 1);
          assert.equal((await save(2)).status, 201);
        },
      );
      await t.test(
        'private listing, inactive seller and obsolete consent are suppressed',
        async () => {
          for (const cause of ['private', 'seller', 'consent']) {
            await changed(
              cause === 'private' ? '70' : cause === 'seller' ? '60' : '50',
            );
            if (cause === 'private')
              await pool.query(
                "UPDATE listings SET status='paused' WHERE id=$1",
                [listing],
              );
            if (cause === 'seller')
              await pool.query('UPDATE users SET active=false WHERE id=$1', [
                seller,
              ]);
            if (cause === 'consent')
              await pool.query(
                "UPDATE listing_subscriptions SET consent_version='obsolete' WHERE user_id=$1",
                [subscriber],
              );
            await worker.once();
            assert.equal(transport.calls.length, 1);
            await pool.query(
              "UPDATE listings SET status='published' WHERE id=$1",
              [listing],
            );
            await pool.query('UPDATE users SET active=true WHERE id=$1', [
              seller,
            ]);
            await pool.query(
              "UPDATE listing_subscriptions SET consent_version='listing-updates-v1' WHERE user_id=$1",
              [subscriber],
            );
          }
        },
      );
      await t.test(
        'HTTP withdrawal and moderation publication create authoritative availability events',
        async () => {
          const version = (
            await pool.query('SELECT version FROM listings WHERE id=$1', [
              listing,
            ])
          ).rows[0].version;
          assert.equal(
            (
              await request(
                '/v1/listings/' + listing + '/transitions',
                'POST',
                { version, status: 'paused' },
                seller,
              )
            ).status,
            201,
          );
          await worker.once();
          assert.equal(transport.calls.length, 2);
          assert.deepEqual(
            (transport.calls[1]!.payload as { event: unknown }).event,
            { kind: 'availability', available: false },
          );
          await pool.query(
            "INSERT INTO media(listing_id,uploaded_by,kind,original_key,mime,state) VALUES($1,$2,'photo','subscription-fixture.jpg','image/jpeg','ready')",
            [listing, seller],
          );
          for (const status of ['processing', 'moderation']) {
            const current = (
              await pool.query('SELECT version FROM listings WHERE id=$1', [
                listing,
              ])
            ).rows[0];
            assert.equal(
              (
                await request(
                  '/v1/listings/' + listing + '/transitions',
                  'POST',
                  { version: current.version, status },
                  seller,
                )
              ).status,
              201,
            );
          }
          const pending = (
            await pool.query(
              "SELECT id FROM moderation_cases WHERE listing_id=$1 AND state='pending'",
              [listing],
            )
          ).rows[0];
          await pool.query("UPDATE users SET role='admin' WHERE id=$1", [
            outsider,
          ]);
          assert.equal(
            (
              await request(
                '/v1/admin/moderation/' + pending.id + '/decision',
                'POST',
                {
                  decision: 'approve',
                  reason: 'Subscription lifecycle acceptance',
                },
                outsider,
              )
            ).status,
            201,
          );
          await worker.once();
          assert.equal(transport.calls.length, 3);
          assert.deepEqual(
            (transport.calls[2]!.payload as { event: unknown }).event,
            { kind: 'availability', available: true },
          );
        },
      );
      await t.test(
        'unsubscribe during send waits for transport completion; no later send starts',
        async () => {
          await changed('40');
          let release!: () => void;
          transport.wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = new Promise<void>((resolve) => {
            transport.started = resolve;
          });
          const sending = worker.once();
          await Promise.race([
            started,
            sending.then(() => {
              throw new Error('worker finished without starting transport');
            }),
          ]);
          let finished = false;
          const disabling = request(path + '/disable', 'POST', {
            version: 3,
          }).then((r) => {
            finished = true;
            return r;
          });
          // Prove PostgreSQL is actually waiting on the advisory lock, not a timed guess.
          for (let i = 0; i < 100; i++) {
            const waiting = await pool.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
            );
            if (waiting.rows[0].n > 0) break;
            if (i === 99) throw new Error('unsubscribe never reached lock');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(finished, false);
          release();
          await sending;
          assert.equal((await disabling).status, 201);
          transport.wait = undefined;
          transport.started = undefined;
          await changed('30');
          await worker.once();
          assert.equal(transport.calls.length, 4);
        },
      );
      await t.test(
        'global opt-out and recipient deactivation serialize with transport',
        async () => {
          assert.equal((await save(4)).status, 201);
          for (const cause of ['preference', 'recipient', 'listing']) {
            await changed(
              cause === 'preference'
                ? '20'
                : cause === 'recipient'
                  ? '15'
                  : '10',
            );
            let release!: () => void;
            transport.wait = new Promise<void>((resolve) => {
              release = resolve;
            });
            const started = new Promise<void>((resolve) => {
              transport.started = resolve;
            });
            const sending = worker.once();
            await Promise.race([
              started,
              sending.then(() => {
                throw new Error('transport did not start');
              }),
            ]);
            let completed = false;
            const update = (
              cause === 'preference'
                ? pool.query(
                    'UPDATE notification_preferences SET email=false WHERE user_id=$1',
                    [subscriber],
                  )
                : cause === 'recipient'
                  ? pool.query('UPDATE users SET active=false WHERE id=$1', [
                      subscriber,
                    ])
                  : pool.query(
                      "UPDATE listings SET status='paused' WHERE id=$1",
                      [listing],
                    )
            ).then(() => {
              completed = true;
            });
            try {
              for (let i = 0; i < 100; i++) {
                const result = await pool.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
                );
                if (result.rows[0].n > 0) break;
                if (i === 99)
                  throw new Error('eligibility mutation never waited');
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(completed, false);
            } finally {
              release();
            }
            await sending;
            await update;
            transport.wait = undefined;
            transport.started = undefined;
            const count = transport.calls.length;
            await changed(
              cause === 'preference'
                ? '19'
                : cause === 'recipient'
                  ? '14'
                  : '9',
            );
            await worker.once();
            assert.equal(transport.calls.length, count);
            await pool.query(
              'UPDATE notification_preferences SET email=true WHERE user_id=$1',
              [subscriber],
            );
            await pool.query('UPDATE users SET active=true WHERE id=$1', [
              subscriber,
            ]);
            await pool.query(
              "UPDATE listings SET status='published' WHERE id=$1",
              [listing],
            );
          }
        },
      );
      await t.test(
        'finalization succeeds with only one free connection in the ten-client pool',
        async () => {
          await changed('5');
          const held = await Promise.all(
            Array.from({ length: 9 }, () => db.pool.connect()),
          );
          try {
            const count = transport.calls.length;
            await worker.once();
            assert.equal(transport.calls.length, count + 1);
            const job = (
              await pool.query(
                'SELECT status FROM notification_deliveries WHERE id=$1',
                [
                  transport.calls
                    .at(-1)!
                    .idempotencyKey.replace('notification:', ''),
                ],
              )
            ).rows[0];
            assert.equal(job.status, 'sent');
          } finally {
            for (const client of held) client.release();
          }
        },
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
