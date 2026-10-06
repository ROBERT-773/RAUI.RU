import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Operations } from './modules/operations/operations';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { Database } from './modules/database/database';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { hash } from './common/security';
import { Search, documentOf } from './modules/search/search';
import { SearchIndex } from './modules/search/index';
test('Phase 3 real PostgreSQL/PostGIS/OpenSearch HTTP acceptance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile(),
    app = module.createNestApplication({ bodyParser: false, logger: false });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(),
    search = app.get(Search),
    index = app.get(SearchIndex);
  const seller = randomUUID(),
    buyer = randomUUID(),
    stranger = randomUUID(),
    first = randomUUID(),
    second = randomUUID(),
    third = randomUUID();
  const secrets = new Map<string, string>([
    [seller, 's'.repeat(43)],
    [buyer, 'b'.repeat(43)],
    [stranger, 't'.repeat(43)],
  ]);
  async function call(
    path: string,
    method = 'POST',
    body?: unknown,
    actor?: string,
  ) {
    const response = await fetch(base + '/v1/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(actor ? { Authorization: 'Bearer ' + secrets.get(actor) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: (await response.json()) as Record<string, unknown>,
    };
  }
  try {
    for (const [id, role] of [
      [seller, 'owner'],
      [buyer, 'buyer'],
      [stranger, 'buyer'],
    ]) {
      await pool.query(
        'INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,$5,now(),now())',
        [id, id + '@example.test', 'fixture-only', 'Phase3', role],
      );
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [id, hash(secrets.get(id!)!), hash('csrf')],
      );
    }
    for (const [id, price, lon, lat, rooms] of [
      [first, 10000000, 37.61, 55.75, 2],
      [second, 20000000, 37.7, 55.8, 3],
      [third, 30000000, 38.5, 56.5, 4],
    ] as const) {
      const address = randomUUID(),
        property = randomUUID(),
        source = randomUUID();
      await pool.query(
        "INSERT INTO addresses(id,formatted,locality,district,point) VALUES($1,'Москва, Тверская','Москва','Центр',ST_SetSRID(ST_MakePoint($2,$3),4326))",
        [address, lon, lat],
      );
      await pool.query(
        "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,$4)",
        [property, seller, address, { area: 50, rooms, elevator: true }],
      );
      await pool.query(
        "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
        [source],
      );
      await pool.query(
        "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,price,title,description,status,published_at) VALUES($1,$2,$3,$4,'sale',$5,'Квартира на Тверской','Светлая квартира','published',now())",
        [id, property, source, seller, price],
      );
    }
    await index.initialize();
    while (await search.sync()) {
      /* Drain durable batch. */
    }
    await t.test(
      'search text, typo, nested filters, price per m², sort and bound cursors',
      async () => {
        const r = await call('search', 'POST', {
          q: 'квртира',
          price: { min: 9000000, max: 22000000 },
          attributes: { rooms: { min: 2 }, elevator: true },
          sort: 'price_asc',
          limit: 1,
        });
        assert.equal(r.status, 201);
        const items = r.data.items as { id: string }[];
        assert.equal(items[0]!.id, first);
        assert.equal(r.data.total, 2);
        assert.ok(r.data.cursor);
        const next = await call('search', 'POST', {
          q: 'квртира',
          price: { min: 9000000, max: 22000000 },
          attributes: { rooms: { min: 2 }, elevator: true },
          sort: 'price_asc',
          limit: 1,
          cursor: r.data.cursor,
        });
        assert.equal((next.data.items as { id: string }[])[0]!.id, second);
        assert.equal(
          (await call('search', 'POST', { cursor: r.data.cursor })).status,
          400,
        );
        assert.equal(
          (await call('search', 'POST', { pricePerM2: { max: 210000 } })).data
            .total,
          1,
        );
      },
    );
    await t.test(
      'map/list bounds, polygon and correct manual coordinates',
      async () => {
        const bounds = [37.5, 55.6, 37.8, 55.9];
        const list = await call('search', 'POST', { bounds });
        assert.equal((list.data.items as unknown[]).length, 2);
        const map = await call('search/map', 'POST', { bounds });
        assert.equal(map.data.matched, 2);
        const ids = (map.data.markers as { listingIds: string[] }[]).flatMap(
          (m) => m.listingIds,
        );
        assert.deepEqual(ids.sort(), [first, second].sort());
        const selection = await call('search/selection', 'POST', {
          ids,
          definition: { bounds },
        });
        assert.equal((selection.data.items as unknown[]).length, 2);
        const polygon = [
          [37.6, 55.7],
          [37.65, 55.7],
          [37.65, 55.78],
          [37.6, 55.78],
          [37.6, 55.7],
        ];
        assert.equal(
          (await call('search/map', 'POST', { polygon })).data.matched,
          1,
        );
        assert.equal((await call('search', 'POST', { polygon })).data.total, 1);
      },
    );
    await t.test(
      'search page database work stays batched as result count grows',
      async () => {
        const db = app.get(Database);
        let queries = 0;
        const acquire = () => {
          queries++;
        };
        db.pool.on('acquire', acquire);
        try {
          const result = await call('search', 'POST', { limit: 50 });
          assert.equal((result.data.items as unknown[]).length, 3);
          assert.ok(
            queries <= 3,
            'Rate limit + public projection + one batched media query',
          );
        } finally {
          db.pool.removeListener('acquire', acquire);
        }
      },
    );
    await t.test(
      'public detail and batched results never reveal seller identities',
      async () => {
        const detail = await call('listings/' + first + '/public', 'GET');
        assert.equal(detail.status, 200);
        assert.doesNotMatch(
          JSON.stringify(detail.data),
          new RegExp(seller + '|password_hash|email|original_key'),
        );
      },
    );
    await t.test(
      'favorites, comparison, recent, saved CRUD isolate owners',
      async () => {
        assert.equal(
          (
            await call('account/collections/favorite', 'POST', {
              listingId: first,
            })
          ).status,
          401,
        );
        for (const kind of ['favorite', 'compare', 'recent'])
          assert.equal(
            (
              await call(
                'account/collections/' + kind,
                'POST',
                { listingId: first },
                buyer,
              )
            ).status,
            201,
          );
        assert.equal(
          (
            (
              await call(
                'account/collections/favorite',
                'GET',
                undefined,
                buyer,
              )
            ).data.items as unknown[]
          ).length,
          1,
        );
        assert.equal(
          (
            (
              await call(
                'account/collections/favorite',
                'GET',
                undefined,
                stranger,
              )
            ).data.items as unknown[]
          ).length,
          0,
        );
        const saved = await call(
          'account/saved-searches',
          'POST',
          {
            name: 'Москва',
            definition: { locality: 'Москва', price: { max: 20000000 } },
          },
          buyer,
        );
        assert.equal(saved.status, 201);
        const id = saved.data.id;
        assert.equal(
          (
            await call(
              'account/saved-searches/' + id,
              'PATCH',
              { name: 'Чужой', definition: {} },
              stranger,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              'account/saved-searches/' + id,
              'DELETE',
              undefined,
              stranger,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              'account/saved-searches/' + id,
              'PATCH',
              { name: 'Мой новый поиск', definition: {} },
              buyer,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              'account/saved-searches/' + id,
              'DELETE',
              undefined,
              buyer,
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      'threads/messages/notifications have participant-only authorization',
      async () => {
        const inquiry = await call(
          'account/inquiries/' + first,
          'POST',
          { body: 'Когда можно посмотреть?' },
          buyer,
        );
        assert.equal(inquiry.status, 201);
        const id = inquiry.data.threadId as string;
        assert.equal(
          (
            await call(
              'account/threads/' + id + '/messages',
              'GET',
              undefined,
              stranger,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              'account/threads/' + id + '/messages',
              'POST',
              { body: 'Чужой' },
              stranger,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              'account/threads/' + id + '/messages',
              'POST',
              { body: 'Завтра' },
              seller,
            )
          ).status,
          201,
        );
        const notifications = await call(
          'account/notifications',
          'GET',
          undefined,
          buyer,
        );
        const n = (notifications.data.items as { id: string }[])[0]!;
        assert.ok(n);
        assert.equal(
          (
            await call(
              'account/notifications/' + n.id + '/read',
              'POST',
              {},
              stranger,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              'account/notifications/' + n.id + '/read',
              'POST',
              {},
              buyer,
            )
          ).status,
          201,
        );
        assert.equal(
          (
            await call(
              'account/preferences',
              'PATCH',
              { in_app: true, email: true, sms: false, push: false },
              buyer,
            )
          ).status,
          200,
        );
        await call(
          'account/threads/' + id + '/messages',
          'POST',
          { body: 'Ещё один ответ' },
          seller,
        );
        assert.equal(
          Number(
            (
              await pool.query(
                "SELECT count(*) FROM notification_outbox WHERE channel='email'",
              )
            ).rows[0].count,
          ),
          1,
        );
      },
    );
    await t.test(
      'stale index cannot leak revoked sellers or changed price, and reconciliation repairs it',
      async () => {
        await pool.query('UPDATE listings SET price=50000000 WHERE id=$1', [
          first,
        ]);
        const stale = await call('search', 'POST', {
          price: { max: 11000000 },
        });
        assert.equal((stale.data.items as unknown[]).length, 0);
        await pool.query('UPDATE users SET active=false WHERE id=$1', [seller]);
        assert.equal(
          ((await call('search', 'POST', {})).data.items as unknown[]).length,
          0,
        );
        assert.equal(
          (await call('listings/' + first + '/public', 'GET')).status,
          404,
        );
        while (await search.sync()) {
          /* Drain durable batch. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 0);
        assert.equal(
          (
            (
              await call('search/selection', 'POST', {
                ids: [first],
                definition: {},
              })
            ).data.items as unknown[]
          ).length,
          0,
        );
        await pool.query('UPDATE users SET active=true WHERE id=$1', [seller]);
        await search.reconcile();
        while (await search.sync()) {
          /* Drain durable batch. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 3);
      },
    );
    await t.test(
      'organization and membership revocation are enforced before index synchronization',
      async () => {
        const organization = randomUUID();
        await pool.query(
          "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Search privacy','agency',$2)",
          [organization, seller],
        );
        await pool.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
          [organization, seller],
        );
        await pool.query('UPDATE listings SET organization_id=$1 WHERE id=$2', [
          organization,
          first,
        ]);
        while (await search.sync()) {
          /* Drain. */
        }
        await pool.query(
          'UPDATE memberships SET active=false WHERE organization_id=$1',
          [organization],
        );
        assert.equal(
          (
            (
              await call('search/selection', 'POST', {
                ids: [first],
                definition: {},
              })
            ).data.items as unknown[]
          ).length,
          0,
        );
        await pool.query(
          'UPDATE memberships SET active=true WHERE organization_id=$1',
          [organization],
        );
        await pool.query('UPDATE organizations SET active=false WHERE id=$1', [
          organization,
        ]);
        assert.equal(
          (
            (
              await call('search/selection', 'POST', {
                ids: [first],
                definition: {},
              })
            ).data.items as unknown[]
          ).length,
          0,
        );
        await pool.query('UPDATE organizations SET active=true WHERE id=$1', [
          organization,
        ]);
        while (await search.sync()) {
          /* Drain. */
        }
        assert.equal(
          (
            (
              await call('search/selection', 'POST', {
                ids: [first],
                definition: {},
              })
            ).data.items as unknown[]
          ).length,
          1,
        );
      },
    );
    await t.test(
      'versioned alias reindex and orphan reconciliation',
      async () => {
        const orphan = randomUUID();
        const row = (await search.publicRows())[0]!;
        await index.write(orphan, '1', { ...documentOf(row), id: orphan });
        await index.request('/' + index.alias + '/_refresh', 'POST');
        await search.reconcile();
        while (await search.sync()) {
          /* Drain. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 3);
        const old = Object.keys(await index.request('/' + index.alias));
        const next = await search.reindex();
        assert.ok(next.includes('-v3-'));
        assert.deepEqual(Object.keys(await index.request('/' + index.alias)), [
          next,
        ]);
        assert.equal((await call('search', 'POST', {})).data.total, 3);
        assert.ok(await index.request('/' + old[0]));
      },
    );
    await t.test(
      'pause/archive/delete tombstones, job fencing and safe invalid payloads',
      async () => {
        await pool.query("UPDATE listings SET status='paused' WHERE id=$1", [
          second,
        ]);
        while (await search.sync()) {
          /* Drain durable batch. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 2);
        await pool.query("UPDATE listings SET status='archived' WHERE id=$1", [
          third,
        ]);
        while (await search.sync()) {
          /* Drain durable batch. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 1);
        await pool.query('DELETE FROM listings WHERE id=$1', [third]);
        while (await search.sync()) {
          /* Drain durable batch. */
        }
        assert.equal((await call('search', 'POST', {})).data.total, 1);
        assert.equal(
          (await call('search', 'POST', { attributes: { password: 'secret' } }))
            .status,
          400,
        );
      },
    );
    await t.test(
      'Search queue age survives repeated listing writes and reconciliation',
      async () => {
        await pool.query(
          "UPDATE listings SET title=title||' first change' WHERE id=$1",
          [first],
        );
        await pool.query(
          "UPDATE search_jobs SET updated_at=now()-interval '10 minutes' WHERE listing_id=$1",
          [first],
        );
        // Compatible backfill is tested separately; here initialize first-enqueue
        // age only if the new column exists, so old code fails on the metric itself.
        const column = await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='search_jobs' AND column_name='enqueued_at'",
        );
        if (column.rowCount)
          await pool.query(
            'UPDATE search_jobs SET enqueued_at=updated_at WHERE listing_id=$1',
            [first],
          );
        await pool.query(
          "UPDATE listings SET title=title||' later change' WHERE id=$1",
          [first],
        );
        const before = await app.get(Operations).snapshot();
        const queue = before.queues.find((q) => q.queue === 'search');
        assert.ok(Number(queue!.oldest_seconds) >= 599);
        await search.reconcile();
        const after = await app.get(Operations).snapshot();
        assert.ok(
          Number(
            after.queues.find((q) => q.queue === 'search')!.oldest_seconds,
          ) >= 599,
        );
      },
    );
    await t.test(
      'Sitemap shards cover more than fifty thousand eligible listings without truncation',
      async () => {
        await pool.query(
          `INSERT INTO listings(property_id,source_id,seller_id,deal_type,price,title,status,published_at)
         SELECT l.property_id,l.source_id,l.seller_id,'sale',10000000,'RC sitemap fixture','published',now()
         FROM listings l CROSS JOIN generate_series(1,50000) WHERE l.id=$1`,
          [first],
        );
        const firstResponse = await fetch(base + '/v1/search/sitemap');
        assert.equal(firstResponse.status, 200);
        const initial = (await firstResponse.json()) as { id: string }[];
        assert.equal(initial.length, 49999, 'Reserve one URL for the homepage');
        const response = await fetch(base + '/v1/search/sitemap/partitions');
        assert.equal(response.status, 200);
        const partitions = (await response.json()) as {
          pageSize: number;
          cursors: (string | null)[];
        };
        assert.equal(partitions.pageSize, 49999);
        assert.equal(partitions.cursors.length, 2);
        const ids: string[] = [];
        for (const cursor of partitions.cursors) {
          const page = await fetch(
            base + '/v1/search/sitemap' + (cursor ? '?after=' + cursor : ''),
          );
          assert.equal(page.status, 200);
          const rows = (await page.json()) as { id: string }[];
          assert.ok(rows.length <= 49999);
          ids.push(...rows.map((row) => row.id));
        }
        const eligible = (
          await pool.query('SELECT id FROM public_search_listings ORDER BY id')
        ).rows.map((row) => row.id);
        assert.equal(eligible.length, 50001);
        assert.equal(new Set(ids).size, ids.length);
        assert.deepEqual(ids, eligible);
        assert.equal(
          (await fetch(base + '/v1/search/sitemap?after=invalid')).status,
          400,
        );
        assert.equal(
          (await fetch(base + '/v1/search/sitemap?unexpected=true')).status,
          400,
        );
        await pool.query('UPDATE users SET active=false WHERE id=$1', [seller]);
        assert.deepEqual(
          await (await fetch(base + '/v1/search/sitemap')).json(),
          [],
        );
        assert.deepEqual(
          (
            (await (
              await fetch(base + '/v1/search/sitemap/partitions')
            ).json()) as { cursors: unknown[] }
          ).cursors,
          [null],
        );
      },
    );
  } finally {
    await index.request('/' + index.alias + '-*', 'DELETE');
    await app.close();
    await pool.end();
  }
});
