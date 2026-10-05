import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { Database } from './modules/database/database';
import { Actor, hash, token } from './common/security';
import { ProfessionalFeeds } from './modules/professional/feeds';
import { ProfessionalImports } from './modules/professional/imports';
import { ProfessionalPlatform } from './modules/professional/platform';
import { Structures } from './modules/properties/structures';
import { Properties } from './modules/properties/properties';
import { FeedFetcher } from './modules/professional/feed-fetch';
import {
  NotificationAdapter,
  NotificationWorker,
  DeliveryEnvelope,
} from './modules/professional/notifications';
class TestAdapter extends NotificationAdapter {
  fail = false;
  enabled = true;
  calls: DeliveryEnvelope[] = [];
  delivered = new Set<string>();
  get configured() {
    return this.enabled;
  }
  async send(e: DeliveryEnvelope) {
    this.calls.push(e);
    if (this.fail) throw new Error('provider-secret');
    this.delivered.add(e.idempotencyKey);
  }
}
class TestFetcher extends FeedFetcher {
  rows: unknown[] = [];
  fail = false;
  async fetch() {
    if (this.fail) throw new Error('private-credentials');
    return JSON.stringify(this.rows);
  }
}
test('Phase 4B real PostgreSQL and HTTP acceptance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  await migrate(pool);
  const adapter = new TestAdapter(),
    fetcher = new TestFetcher();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NotificationAdapter)
    .useValue(adapter)
    .overrideProvider(FeedFetcher)
    .useValue(fetcher)
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    feeds = app.get(ProfessionalFeeds),
    imports = app.get(ProfessionalImports),
    platform = app.get(ProfessionalPlatform),
    delivery = app.get(NotificationWorker),
    structures = app.get(Structures),
    base = await app.getUrl();
  const actors: Actor[] = [],
    secrets: string[] = [];
  const org = randomUUID(),
    otherOrg = randomUUID();
  let feedId = '',
    listingId = '',
    propertyId = '',
    sourceId = '',
    clientId = '',
    clientSecret = '';
  const row = {
    externalReference: 'flat-1',
    title: 'Imported apartment',
    price: 15000000,
    dealType: 'sale',
    categoryCode: 'apartment',
    description: 'Test',
    attributes: { area: 50 },
    address: {
      formatted: 'Test address Moscow',
      locality: 'Москва',
      longitude: 37.6,
      latitude: 55.7,
    },
  };
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    index = 0,
    key?: string,
    partner?: string,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(partner
          ? { 'x-partner-token': partner }
          : { authorization: `Bearer ${secrets[index]}` }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function run(
    items: unknown[],
    mode: 'apply' | 'dry_run' = 'apply',
    feed = feedId,
  ) {
    const result = await imports.apply(
      actors[0]!,
      org,
      feed,
      { items },
      token(),
      mode,
    );
    await imports.once();
    return result.runId;
  }
  try {
    for (const role of ['agency', 'agency', 'admin', 'developer'] as const) {
      const id = randomUUID(),
        session = randomUUID(),
        secret = token();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'test','Professional',$3,now(),now())",
        [id, id + '@example.test', role],
      );
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
        [session, id, hash(secret), hash(token())],
      );
      actors.push({
        id,
        role,
        email_verified_at: 'verified',
        phone_verified_at: 'verified',
        session_id: session,
      });
      secrets.push(secret);
    }
    await pool.query(
      "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Agency','agency',$2),($3,'Other','agency',$4)",
      [org, actors[0]!.id, otherOrg, actors[1]!.id],
    );
    await pool.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
      [org, actors[0]!.id, otherOrg, actors[1]!.id],
    );
    await t.test(
      'Migrations repeat safely and preferences retain existing default opt-out',
      async () => {
        assert.equal(
          (
            await db.rows<{ count: string }>(
              'SELECT count(*) FROM schema_migrations',
            )
          )[0]!.count,
          '8',
        );
        const p = await platform.preferences(actors[0]!);
        assert.equal(p!.email, false);
        const res = await call(
          `/v1/organizations/${org}/feeds`,
          'POST',
          {
            name: 'Agency feed',
            format: 'json',
            transport: { kind: 'manual' },
          },
          0,
          token(),
        );
        assert.equal(res.status, 201);
        feedId = ((await res.json()) as { id: string }).id;
        assert.equal(
          (await call(`/v1/organizations/${org}/feeds`, 'GET', undefined, 1))
            .status,
          403,
        );
      },
    );
    await t.test(
      'Dry-run shares apply validation, quarantines duplicates and creates no domain objects',
      async () => {
        const id = await run(
          [
            row,
            row,
            { ...row, externalReference: 'bad', attributes: { unknown: true } },
          ],
          'dry_run',
        );
        const items = await imports.items(actors[0]!, org, feedId, id, {});
        assert.equal(items.filter((x) => x.status === 'valid').length, 1);
        assert.equal(items.filter((x) => x.status === 'invalid').length, 2);
        assert.equal(
          (
            await db.rows<{ count: string }>('SELECT count(*) FROM listings')
          )[0]!.count,
          '0',
        );
      },
    );
    await t.test(
      'Apply creates separate physical object, offer and feed source with traceable replay',
      async () => {
        await run([row]);
        const [record] = await db.rows<{
          listing_id: string;
          property_id: string;
          source_id: string;
        }>('SELECT * FROM professional_feed_records');
        listingId = record!.listing_id;
        propertyId = record!.property_id;
        sourceId = record!.source_id;
        assert.equal(
          (
            await db.rows('SELECT status FROM listings WHERE id=$1', [
              listingId,
            ])
          )[0]!.status,
          'draft',
        );
        const [source] = await db.rows(
          'SELECT kind,metadata FROM listing_sources WHERE id=$1',
          [sourceId],
        );
        assert.equal(source!.kind, 'feed');
        assert.equal(
          (source!.metadata as { externalReference: string }).externalReference,
          row.externalReference,
        );
        const [before] = await db.rows(
          'SELECT version FROM listings WHERE id=$1',
          [listingId],
        );
        await run([row]);
        assert.equal(
          (
            await db.rows('SELECT version FROM listings WHERE id=$1', [
              listingId,
            ])
          )[0]!.version,
          before!.version,
        );
        assert.equal(
          (
            await db.rows<{ count: string }>('SELECT count(*) FROM properties')
          )[0]!.count,
          '1',
        );
      },
    );
    await t.test(
      'Same external reference in another feed cannot overwrite this feed source',
      async () => {
        const second = await feeds.create(
          actors[0]!,
          org,
          {
            name: 'Second feed',
            format: 'json',
            transport: { kind: 'manual' },
          },
          token(),
        );
        await run([row], 'apply', second.id);
        assert.equal(
          (
            await db.rows<{ count: string }>(
              'SELECT count(*) FROM professional_feed_records',
            )
          )[0]!.count,
          '2',
        );
        assert.equal(
          new Set(
            (
              await db.rows<{ source_id: string }>(
                'SELECT source_id FROM professional_feed_records',
              )
            ).map((x) => x.source_id),
          ).size,
          2,
        );
      },
    );
    await t.test(
      'Upserts retain identity, reject physical changes and protect active listings',
      async () => {
        await run([{ ...row, price: 16000000 }]);
        assert.equal(
          (
            await db.rows('SELECT price FROM listings WHERE id=$1', [listingId])
          )[0]!.price,
          '16000000.00',
        );
        const id = await run([
          { ...row, address: { ...row.address, latitude: 50 } },
        ]);
        assert.equal(
          (await imports.items(actors[0]!, org, feedId, id, {}))[0]!.status,
          'quarantined',
        );
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          listingId,
        ]);
        const active = await run([{ ...row, price: 17000000 }]);
        assert.equal(
          (await imports.items(actors[0]!, org, feedId, active, {}))[0]!.status,
          'quarantined',
        );
        await pool.query("UPDATE listings SET status='draft' WHERE id=$1", [
          listingId,
        ]);
        assert.equal(
          (
            await db.rows('SELECT property_id FROM listings WHERE id=$1', [
              listingId,
            ])
          )[0]!.property_id,
          propertyId,
        );
      },
    );
    await t.test(
      'Concurrent apply key replays one queued run and rejects altered payload',
      async () => {
        const key = token();
        const results = await Promise.all([
          imports.apply(actors[0]!, org, feedId, { items: [row] }, key),
          imports.apply(actors[0]!, org, feedId, { items: [row] }, key),
        ]);
        assert.equal(results[0]!.runId, results[1]!.runId);
        await assert.rejects(
          imports.apply(
            actors[0]!,
            org,
            feedId,
            { items: [{ ...row, price: 123 }] },
            key,
          ),
        );
        await imports.once();
      },
    );
    await t.test(
      'Feed jobs process FIFO and a leased older import blocks newer snapshots',
      async () => {
        const first = await imports.apply(
          actors[0]!,
          org,
          feedId,
          { items: [{ ...row, price: 18000000 }] },
          token(),
        );
        const second = await imports.apply(
          actors[0]!,
          org,
          feedId,
          { items: [{ ...row, price: 19000000 }] },
          token(),
        );
        await pool.query(
          "UPDATE professional_import_jobs SET state='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE run_id=$1",
          [first.runId, randomUUID()],
        );
        assert.equal(await imports.once(), false);
        assert.equal(
          (
            await db.rows(
              'SELECT state FROM professional_import_jobs WHERE run_id=$1',
              [second.runId],
            )
          )[0]!.state,
          'pending',
        );
        await pool.query(
          "UPDATE professional_import_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1",
          [first.runId],
        );
        await imports.once();
        assert.equal(
          (
            await db.rows('SELECT price FROM listings WHERE id=$1', [listingId])
          )[0]!.price,
          '18000000.00',
        );
        await imports.once();
        assert.equal(
          (
            await db.rows('SELECT price FROM listings WHERE id=$1', [listingId])
          )[0]!.price,
          '19000000.00',
        );
      },
    );
    await t.test(
      'Portfolio and bulk writes are context-authorized, atomic and idempotent',
      async () => {
        const p = await platform.createPortfolio(
          actors[0]!,
          org,
          { name: 'Sales' },
          token(),
        );
        await platform.addPortfolioListings(
          actors[0]!,
          org,
          p.id,
          { listingIds: [listingId] },
          token(),
        );
        assert.equal(
          (await platform.portfolioListings(actors[0]!, org, p.id)).length,
          1,
        );
        await assert.rejects(
          platform.addPortfolioListings(
            actors[1]!,
            otherOrg,
            p.id,
            { listingIds: [listingId] },
            token(),
          ),
        );
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          listingId,
        ]);
        const key = token(),
          input = { listingIds: [listingId] };
        assert.equal(
          (await platform.bulkPause(actors[0]!, org, input, key)).paused,
          1,
        );
        assert.equal(
          (await platform.bulkPause(actors[0]!, org, input, key)).paused,
          1,
        );
        await assert.rejects(
          platform.bulkPause(actors[1]!, org, input, token()),
        );
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          listingId,
        ]);
        await assert.rejects(
          platform.bulkPause(
            actors[0]!,
            org,
            { listingIds: [listingId, randomUUID()] },
            token(),
          ),
        );
        assert.equal(
          (
            await db.rows('SELECT status FROM listings WHERE id=$1', [
              listingId,
            ])
          )[0]!.status,
          'published',
        );
        await pool.query("UPDATE listings SET status='draft' WHERE id=$1", [
          listingId,
        ]);
      },
    );
    await t.test(
      'Developer hierarchy reuses StructuresModule through every physical level',
      async () => {
        const developer = randomUUID();
        await pool.query(
          "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Developer','developer',$2)",
          [developer, actors[3]!.id],
        );
        await pool.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
          [developer, actors[3]!.id],
        );
        const complex = await structures.create(
          actors[3]!,
          'complex',
          { organizationId: developer, name: 'Complex', address: row.address },
          token(),
        );
        const building = await structures.create(
          actors[3]!,
          'building',
          {
            organizationId: developer,
            complexId: complex.id,
            name: 'Building',
            address: row.address,
          },
          token(),
        );
        const section = await structures.create(
          actors[3]!,
          'section',
          { buildingId: building.id, name: 'A' },
          token(),
        );
        const floor = await structures.create(
          actors[3]!,
          'floor',
          { sectionId: section.id, number: 5 },
          token(),
        );
        await app.get(Properties).create(
          actors[3]!,
          {
            organizationId: developer,
            category: 'new_build',
            address: row.address,
            buildingId: building.id,
            floorId: floor.id,
            unitNumber: '501',
            attributes: { area: 50 },
          },
          token(),
        );
        const hierarchy = await structures.hierarchy(actors[3]!, developer);
        assert.equal(hierarchy.units.length, 1);
        assert.equal(hierarchy.units[0]!.floor_id, floor.id);
        assert.equal(hierarchy.buildings[0]!.complex_id, complex.id);
        assert.equal(
          (
            await call(
              `/v1/organizations/${developer}/professional/hierarchy`,
              'GET',
              undefined,
              3,
            )
          ).status,
          200,
        );
        await assert.rejects(structures.hierarchy(actors[0]!, org));
      },
    );
    await t.test(
      'Ordinary organization members can read portfolios but cannot run bulk changes/imports',
      async () => {
        await pool.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
          [org, actors[1]!.id],
        );
        assert.equal((await platform.portfolios(actors[1]!, org)).length, 1);
        await assert.rejects(
          platform.bulkPause(
            actors[1]!,
            org,
            { listingIds: [listingId] },
            token(),
          ),
        );
        await assert.rejects(
          imports.apply(actors[1]!, org, feedId, { items: [row] }, token()),
        );
      },
    );
    await t.test(
      'Partner key creation replays metadata without retaining or returning the plaintext token',
      async () => {
        const key = token(),
          body = { name: 'Single reveal', scopes: ['listings:read'] };
        const first = await platform.createPartnerClient(
          actors[0]!,
          org,
          body,
          key,
        );
        const replay = await platform.createPartnerClient(
          actors[0]!,
          org,
          body,
          key,
        );
        assert.equal(replay.id, first.id);
        assert.equal(replay.token, null);
        assert.ok(first.token);
        const records = await db.rows(
          'SELECT response FROM idempotency_records WHERE scope=$1',
          [`professional.partner.create:${org}`],
        );
        assert.ok(!JSON.stringify(records).includes(first.token));
      },
    );
    await t.test(
      'Partner token hash, scopes, per-key rate limit, membership and expiry are enforced',
      async () => {
        const client = await platform.createPartnerClient(
          actors[0]!,
          org,
          {
            name: 'Read client',
            scopes: ['listings:read'],
            requestsPerMinute: 2,
          },
          token(),
        );
        clientId = client.id;
        clientSecret = client.token!;
        assert.equal(
          (
            await db.rows<{ token_digest: string }>(
              'SELECT token_digest FROM partner_clients WHERE id=$1',
              [clientId],
            )
          )[0]!.token_digest,
          hash(clientSecret),
        );
        assert.equal(
          (
            await call(
              '/v1/partner/listings',
              'GET',
              undefined,
              0,
              undefined,
              clientSecret,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              '/v1/partner/listings/bulk-pause',
              'POST',
              { listingIds: [listingId] },
              0,
              token(),
              clientSecret,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/v1/partner/listings',
              'GET',
              undefined,
              0,
              undefined,
              clientSecret,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              '/v1/partner/listings',
              'GET',
              undefined,
              0,
              undefined,
              clientSecret,
            )
          ).status,
          429,
        );
        await pool.query(
          "UPDATE partner_clients SET expires_at=now()-interval '1 second' WHERE id=$1",
          [clientId],
        );
        assert.equal(
          (
            await call(
              '/v1/partner/listings',
              'GET',
              undefined,
              0,
              undefined,
              clientSecret,
            )
          ).status,
          403,
        );
        await pool.query(
          "UPDATE partner_clients SET expires_at=now()+interval '1 day' WHERE id=$1",
          [clientId],
        );
        await pool.query(
          'UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2',
          [org, actors[0]!.id],
        );
        await assert.rejects(platform.partner(clientSecret, 'listings:read'));
        await pool.query(
          'UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2',
          [org, actors[0]!.id],
        );
      },
    );
    await t.test(
      'Partner feeds:write cannot escape its organization and revocation is audited',
      async () => {
        await pool.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",
          [otherOrg, actors[0]!.id],
        );
        const other = await feeds.create(
          actors[0]!,
          otherOrg,
          {
            name: 'Other organization',
            format: 'json',
            transport: { kind: 'manual' },
          },
          token(),
        );
        const client = await platform.createPartnerClient(
          actors[0]!,
          org,
          {
            name: 'Importer',
            scopes: ['feeds:write'],
          },
          token(),
        );
        assert.equal(
          (
            await call(
              `/v1/partner/feeds/${other.id}/apply`,
              'POST',
              { items: [row] },
              0,
              token(),
              client.token!,
            )
          ).status,
          404,
        );
        await platform.revoke(actors[2]!, client.id, true);
        await assert.rejects(platform.partner(client.token!, 'feeds:write'));
      },
    );
    await t.test(
      'Scheduled imports use persisted snapshots, retries, DLQ and audited resume',
      async () => {
        await pool.query(
          "UPDATE professional_feed_definitions SET schedule_cron='*/15 * * * *',transport=$2,next_run_at=now() WHERE id=$1",
          [
            feedId,
            JSON.stringify({
              kind: 'https',
              url: 'https://feeds.example/listings',
            }),
          ],
        );
        fetcher.fail = true;
        await imports.once();
        const [job] = await db.rows<{
          run_id: string;
          attempts: number;
          last_error: string;
        }>(
          'SELECT j.* FROM professional_import_jobs j JOIN professional_import_runs r ON r.id=j.run_id WHERE r.feed_id=$1 ORDER BY r.created_at DESC LIMIT 1',
          [feedId],
        );
        assert.equal(job!.attempts, 1);
        assert.equal(job!.last_error, 'import_failed');
        for (let n = 0; n < 4; n++) {
          await pool.query(
            'UPDATE professional_import_jobs SET available_at=now() WHERE run_id=$1',
            [job!.run_id],
          );
          await imports.once();
        }
        assert.equal(
          (
            await db.rows(
              'SELECT state FROM professional_import_jobs WHERE run_id=$1',
              [job!.run_id],
            )
          )[0]!.state,
          'dead',
        );
        await imports.retry(actors[2]!, org, feedId, job!.run_id, true);
        fetcher.fail = false;
        fetcher.rows = [row];
        await imports.once();
        assert.equal(
          (
            await db.rows(
              'SELECT state FROM professional_import_jobs WHERE run_id=$1',
              [job!.run_id],
            )
          )[0]!.state,
          'done',
        );
        await pool.query(
          'UPDATE professional_feed_definitions SET schedule_cron=NULL WHERE id=$1',
          [feedId],
        );
      },
    );
    let jobId = '';
    await t.test(
      'Expired import leases cannot write domain rows or audit',
      async () => {
        const queued = await imports.apply(
          actors[0]!,
          org,
          feedId,
          { items: [{ ...row, externalReference: 'fenced' }] },
          token(),
        );
        const lease = randomUUID();
        await pool.query(
          "UPDATE professional_import_jobs SET state='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE run_id=$1",
          [queued.runId, lease],
        );
        const [feed] = await db.rows<
          Parameters<ProfessionalImports['process']>[2]
        >('SELECT * FROM professional_feed_definitions WHERE id=$1', [feedId]);
        await assert.rejects(
          imports.process(
            {
              run_id: queued.runId,
              feed_id: feedId,
              organization_id: org,
              requested_by: actors[0]!.id,
              mode: 'apply',
              payload: null,
              lease_token: lease,
              attempts: 1,
            },
            actors[0]!,
            feed!,
            { ...row, externalReference: 'fenced' },
            'fenced',
            false,
          ),
        );
        assert.equal(
          (
            await db.rows<{ count: string }>(
              "SELECT count(*) FROM professional_feed_records WHERE external_reference='fenced'",
            )
          )[0]!.count,
          '0',
        );
        await imports.once();
      },
    );
    await t.test(
      'Product outbox bridges once, delivery retries with stable provider deduplication',
      async () => {
        const [thread] = await db.rows<{ id: string }>(
          'INSERT INTO inquiry_threads(listing_id,buyer_id,seller_id) VALUES($1,$2,$3) RETURNING id',
          [listingId, actors[1]!.id, actors[0]!.id],
        );
        const [n] = await db.rows<{ id: string }>(
          "INSERT INTO notifications(user_id,thread_id,kind) VALUES($1,$2,'message') RETURNING id",
          [actors[0]!.id, thread!.id],
        );
        await pool.query(
          'UPDATE notification_preferences SET email=true WHERE user_id=$1',
          [actors[0]!.id],
        );
        await pool.query(
          "INSERT INTO notification_outbox(notification_id,channel) VALUES($1,'email')",
          [n!.id],
        );
        adapter.fail = true;
        await delivery.once();
        const [job] = await db.rows<{ id: string }>(
          'SELECT id FROM notification_deliveries',
        );
        jobId = job!.id;
        assert.equal(
          (
            await db.rows(
              'SELECT last_error FROM notification_deliveries WHERE id=$1',
              [jobId],
            )
          )[0]!.last_error,
          'delivery_failed',
        );
        adapter.fail = false;
        await pool.query(
          'UPDATE notification_deliveries SET available_at=now() WHERE id=$1',
          [jobId],
        );
        await Promise.all([delivery.once(), delivery.once()]);
        assert.equal(adapter.calls.length, 2);
        assert.equal(
          adapter.calls[0]!.idempotencyKey,
          adapter.calls[1]!.idempotencyKey,
        );
        assert.equal(adapter.delivered.size, 1);
        await delivery.bridge();
        assert.equal(
          (
            await db.rows<{ count: string }>(
              'SELECT count(*) FROM notification_deliveries',
            )
          )[0]!.count,
          '1',
        );
        assert.equal(
          (await db.rows('SELECT state FROM notification_outbox'))[0]!.state,
          'delivered',
        );
      },
    );
    await t.test(
      'Preferences and verified destinations suppress delivery; missing adapter defers without exhaustion',
      async () => {
        await pool.query(
          'UPDATE notification_preferences SET email=false WHERE user_id=$1',
          [actors[0]!.id],
        );
        const [j] = await db.rows<{ id: string }>(
          "INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key) VALUES($1,'email','transactional.payment','disabled') RETURNING id",
          [actors[0]!.id],
        );
        await delivery.once();
        assert.equal(
          (
            await db.rows(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [j!.id],
            )
          )[0]!.status,
          'skipped',
        );
        await pool.query(
          'UPDATE notification_preferences SET email=true WHERE user_id=$1',
          [actors[0]!.id],
        );
        await pool.query(
          "UPDATE notification_deliveries SET status='pending',available_at=now(),attempts=0 WHERE id=$1",
          [jobId],
        );
        adapter.enabled = false;
        await delivery.once();
        assert.equal(
          (
            await db.rows(
              'SELECT attempts FROM notification_deliveries WHERE id=$1',
              [jobId],
            )
          )[0]!.attempts,
          0,
        );
        adapter.enabled = true;
      },
    );
    await t.test(
      'Delivery dead-letter retry is admin-only and stale leases cannot finalize a job',
      async () => {
        await pool.query(
          'UPDATE notification_deliveries SET attempts=4,available_at=now() WHERE id=$1',
          [jobId],
        );
        adapter.fail = true;
        await delivery.once();
        assert.equal(
          (
            await db.rows(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [jobId],
            )
          )[0]!.status,
          'dead',
        );
        await assert.rejects(delivery.retry(actors[0]!, jobId));
        await delivery.retry(actors[2]!, jobId);
        adapter.fail = false;
        await delivery.finish(
          {
            id: jobId,
            user_id: actors[0]!.id,
            channel: 'email',
            kind: 'message',
            payload: {},
            dedupe_key: 'test',
            attempts: 1,
            lease_token: randomUUID(),
          },
          'sent',
        );
        assert.equal(
          (
            await db.rows(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [jobId],
            )
          )[0]!.status,
          'pending',
        );
        await delivery.once();
        assert.equal(
          (
            await db.rows(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [jobId],
            )
          )[0]!.status,
          'sent',
        );
      },
    );
    await t.test(
      'Admin feed controls are protected, versioned and audit is append-only',
      async () => {
        assert.equal(
          (await call('/v1/admin/integrations/feeds', 'GET', undefined, 0))
            .status,
          403,
        );
        assert.equal(
          (await call('/v1/admin/integrations/feeds', 'GET', undefined, 2))
            .status,
          200,
        );
        await imports.configure(
          actors[2]!,
          org,
          feedId,
          { version: 1, active: false },
          true,
        );
        await assert.rejects(
          imports.configure(
            actors[2]!,
            org,
            feedId,
            { version: 1, active: true },
            true,
          ),
        );
        const contractResponse = await fetch(base + '/v1/openapi.json');
        const contract = (await contractResponse.json()) as {
          paths: Record<
            string,
            Record<string, { security: unknown; requestBody?: unknown }>
          >;
        };
        assert.deepEqual(
          contract.paths['/v1/partner/listings']!.get!.security,
          [{ partner: [] }],
        );
        assert.ok(
          contract.paths[
            '/v1/organizations/{organizationId}/feeds/{feedId}/apply'
          ]!.post!.requestBody,
        );
        const actions = (
          await db.rows<{ action: string }>(
            'SELECT DISTINCT action FROM audit_events',
          )
        ).map((x) => x.action);
        for (const action of [
          'professional.feed.created',
          'professional.feed.updated',
          'professional.feed.dry_run',
          'professional.feed.applied',
          'professional.feed.retry',
          'professional.feed.dead',
          'professional.feed.configured',
          'professional.portfolio.created',
          'professional.listing.bulk_paused',
          'partner.client.created',
          'partner.client.revoked',
          'notification.sent',
          'notification.skipped',
          'notification.dead',
          'notification.admin_retry',
        ])
          assert.ok(actions.includes(action), action);
        await assert.rejects(pool.query('DELETE FROM audit_events'));
      },
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
