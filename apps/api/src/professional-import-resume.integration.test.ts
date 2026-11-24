import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { type Actor } from './common/security';
import { Database, DatabaseModule } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import { Geocoder } from './modules/geo/geo';
import { FeedFetcher } from './modules/professional/feed-fetch';
import {
  ProfessionalFeeds,
  ProfessionalFeedsModule,
} from './modules/professional/feeds';
import { ProfessionalImports } from './modules/professional/imports';

function offer(id: string, price: number) {
  return `<offer internal-id="${id}"><type>продажа</type><category>квартира</category><new-flat>да</new-flat>
    <location><locality-name>Москва</locality-name><address>Москва, Тестовая улица, ${id}</address></location>
    <area><value>55</value><unit>кв. м</unit></area><price><value>${price}</value><currency>RUR</currency></price>
    <image>https://example.test/photo?token=fixture-only</image></offer>`;
}

test('a dead XML delivery resumes the same saved file without fetching or geocoding completed rows', async (t) => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.ok(
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
      /^\/raui_test_[a-f0-9]{16}$/.test(url.pathname),
  );
  const previousHosts = process.env.FEED_ALLOWED_HOSTS;
  process.env.FEED_ALLOWED_HOSTS = 'example.test';
  t.after(() => {
    if (previousHosts === undefined) delete process.env.FEED_ALLOWED_HOSTS;
    else process.env.FEED_ALLOWED_HOSTS = previousHosts;
  });
  let xml =
    '<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">' +
    offer('101', 1000000) +
    offer('101', 1000000) +
    offer('202', 2000000) +
    '</realty-feed>';
  let fetches = 0;
  const fixture: { duringFetch?: () => Promise<unknown> } = {};
  const queried: string[] = [];
  const module = await Test.createTestingModule({
    imports: [DatabaseModule, ProfessionalFeedsModule],
  })
    .overrideProvider(FeedFetcher)
    .useValue({
      fetch: async () => {
        fetches++;
        await fixture.duringFetch?.();
        return xml;
      },
    })
    .overrideProvider(Geocoder)
    .useValue({
      lookup: async (formatted: string) => {
        queried.push(formatted);
        return [
          { formatted, locality: 'Москва', longitude: 37.6, latitude: 55.7 },
        ];
      },
    })
    .compile();
  t.after(() => module.close());
  const db = module.get(Database),
    feeds = module.get(ProfessionalFeeds),
    imports = module.get(ProfessionalImports);
  await migrate(db.pool);
  const actor: Actor = {
    id: randomUUID(),
    role: 'agent',
    email_verified_at: 'verified',
    phone_verified_at: 'verified',
    session_id: randomUUID(),
  };
  await db.pool.query(
    "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'test','Agent','agent',now(),now())",
    [actor.id, actor.id + '@example.test'],
  );
  const { feed, preview } = await feeds.createFromLink(
    actor,
    null,
    { provider: 'yandex', url: 'https://example.test/xml?token=fixture-only' },
    randomUUID(),
  );
  const jobState = async () =>
    (
      await db.rows<{ state: string; payload: unknown }>(
        'SELECT state,payload FROM professional_import_jobs WHERE run_id=$1',
        [preview.runId],
      )
    )[0]!;
  const records = async () =>
    await db.rows<{
      external_reference: string;
      price: number;
      payload: unknown;
    }>(
      "SELECT external_reference,(payload->>'price')::integer AS price,payload FROM professional_import_items WHERE run_id=$1 ORDER BY external_reference",
      [preview.runId],
    );
  // Reach the last automatic attempt while the saved file is still current.
  await db.pool.query(
    'UPDATE professional_import_jobs SET attempts=4 WHERE run_id=$1',
    [preview.runId],
  );
  const processRow = imports.process.bind(imports);
  const interrupted = t.mock.method(
    imports,
    'process',
    async (...args: Parameters<typeof processRow>) => {
      if (args[4] === '202') throw new Error('Simulated worker interruption');
      return processRow(...args);
    },
  );
  assert.equal(await imports.once(), true);
  assert.equal((await jobState()).state, 'dead');
  assert.ok(Array.isArray((await jobState()).payload));
  assert.equal((await records()).length, 2);
  assert.ok(!JSON.stringify(await records()).includes('fixture-only'));
  interrupted.mock.restore();
  xml = xml.replace('2000000', '9000000').replace('202', '999');
  queried.length = 0;
  await imports.retry(actor, null, feed.id, preview.runId);
  await imports.once();
  assert.deepEqual(await jobState(), { state: 'done', payload: null });
  assert.equal(fetches, 1);
  assert.deepEqual(queried, ['Москва, Тестовая улица, 202']);
  const items = await records();
  assert.equal(items.length, 3);
  assert.equal(
    items.find((record) => record.external_reference === '202')?.price,
    2000000,
  );
  assert.ok(!JSON.stringify(items).includes('fixture-only'));
  // In older databases an already partial failed attempt may have no snapshot.
  await db.pool.query(
    "UPDATE professional_import_jobs SET state='dead' WHERE run_id=$1",
    [preview.runId],
  );
  await assert.rejects(
    imports.retry(actor, null, feed.id, preview.runId),
    ConflictException,
  );
  assert.equal(fetches, 1);
  const lost = await feeds.createFromLink(
    actor,
    null,
    { provider: 'yandex' },
    randomUUID(),
  );
  queried.length = 0;
  fixture.duringFetch = () =>
    db.pool.query(
      "UPDATE professional_import_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1",
      [lost.preview.runId],
    );
  await imports.once();
  const [expired] = await db.rows<{
    state: string;
    payload: unknown;
    items: number;
  }>(
    `SELECT j.state,j.payload,(SELECT count(*)::int FROM professional_import_items i WHERE i.run_id=j.run_id) AS items
     FROM professional_import_jobs j WHERE j.run_id=$1`,
    [lost.preview.runId],
  );
  assert.deepEqual(expired, { state: 'running', payload: null, items: 0 });
  assert.deepEqual(queried, []);
});
