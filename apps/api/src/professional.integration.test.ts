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
import { ListingSubscriptions } from './modules/product/subscriptions';
import { enqueueImmediateListingEmails } from './modules/product/subscription-outbox';
import { listingSubscriptionConsentVersion } from './modules/product/subscription-contract';
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
  onSend?: (e: DeliveryEnvelope, signal: AbortSignal) => Promise<void>;
  async send(e: DeliveryEnvelope, signal: AbortSignal) {
    this.calls.push(e);
    await this.onSend?.(e, signal);
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
          '18',
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
        const second = await platform.createPortfolio(
          actors[0]!,
          org,
          { name: 'Second sales' },
          token(),
        );
        const sharedKey = token();
        const sharedBody = { listingIds: [listingId] };
        await platform.addPortfolioListings(
          actors[0]!,
          org,
          p.id,
          sharedBody,
          sharedKey,
        );
        const added = await platform.addPortfolioListings(
          actors[0]!,
          org,
          second.id,
          sharedBody,
          sharedKey,
        );
        assert.equal(added.portfolioId, second.id);
        assert.equal(
          (await platform.portfolioListings(actors[0]!, org, second.id)).length,
          1,
        );
        assert.deepEqual(
          await platform.addPortfolioListings(
            actors[0]!,
            org,
            second.id,
            sharedBody,
            sharedKey,
          ),
          added,
        );
        await assert.rejects(
          platform.addPortfolioListings(
            actors[0]!,
            org,
            randomUUID(),
            sharedBody,
            sharedKey,
          ),
          /Portfolio not found/,
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
        assert.equal((await platform.portfolios(actors[1]!, org)).length, 2);
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
      'Partner revocation targets clients beyond the first page and rejects cross-organization paths',
      async () => {
        const ids: string[] = [];
        for (let n = 0; n < 101; n++) {
          const id = randomUUID();
          ids.push(id);
          await pool.query(
            "INSERT INTO partner_clients(id,organization_id,name,token_digest,scopes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day')",
            [
              id,
              org,
              'Revocation pagination fixture',
              hash(token()),
              ['listings:read'],
              actors[0]!.id,
            ],
          );
        }
        const visible = new Set(
          (await platform.clients(actors[0]!, org)).map((c) => c.id),
        );
        const excluded = ids.find((id) => !visible.has(id));
        assert.ok(excluded);
        const endpoint = `/v1/organizations/${org}/professional/partner-clients/${excluded}/revoke`;
        assert.equal((await call(endpoint, 'POST', undefined, 1)).status, 403);
        assert.equal(
          (
            await call(
              `/v1/organizations/${otherOrg}/professional/partner-clients/${excluded}/revoke`,
              'POST',
              undefined,
              0,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await db.rows('SELECT active FROM partner_clients WHERE id=$1', [
              excluded,
            ])
          )[0]!.active,
          true,
        );
        assert.equal((await call(endpoint, 'POST')).status, 201);
        assert.equal((await call(endpoint, 'POST')).status, 201);
        assert.equal(
          (
            await db.rows('SELECT active FROM partner_clients WHERE id=$1', [
              excluded,
            ])
          )[0]!.active,
          false,
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
      'Concurrent partner calls serialize key usage without lock-upgrade deadlocks',
      async () => {
        const client = await platform.createPartnerClient(
          actors[0]!,
          org,
          {
            name: 'Concurrent reader',
            scopes: ['listings:read'],
            requestsPerMinute: 10,
          },
          token(),
        );
        const responses = await Promise.all(
          Array.from({ length: 4 }, () =>
            call(
              '/v1/partner/listings',
              'GET',
              undefined,
              0,
              undefined,
              client.token!,
            ),
          ),
        );
        assert.deepEqual(
          responses.map((r) => r.status),
          [200, 200, 200, 200],
        );
        const [usage] = await db.rows<{ count: number }>(
          'SELECT count FROM partner_client_usage WHERE client_id=$1',
          [client.id],
        );
        assert.equal(usage!.count, 4);
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
    await t.test(
      'Listing email enqueue and transport independently require current consent',
      async () => {
        const userId = actors[0]!.id;
        adapter.fail = false;
        adapter.enabled = true;
        await pool.query(
          'UPDATE notification_preferences SET email=true WHERE user_id=$1',
          [userId],
        );
        await pool.query(
          `INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version)
           VALUES($1,$2,ARRAY['price_drop'],ARRAY['email'],'immediate',$3)`,
          [userId, listingId, listingSubscriptionConsentVersion],
        );
        let eventVersion = 5000;
        const change = () => ({
          listingId,
          version: ++eventVersion,
          publicBefore: true,
          publicAfter: true,
          previousPrice: '100',
          price: '99',
        });
        const enqueue = async () => {
          const event = change();
          await db.transaction((sql) =>
            enqueueImmediateListingEmails(sql, event),
          );
          return `listing:${listingId}:${event.version}:price_drop`;
        };
        const count = async (key: string) =>
          Number(
            (
              await db.rows<{ count: string }>(
                'SELECT count(*) FROM notification_deliveries WHERE user_id=$1 AND dedupe_key=$2',
                [userId, key],
              )
            )[0]!.count,
          );
        const subscriptionCalls = () =>
          adapter.calls.filter(
            (call) =>
              call.kind === 'subscription.listing.price_drop' &&
              call.userId === userId,
          );
        const drain = async (id: string) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const [job] = await db.rows<{ status: string }>(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [id],
            );
            if (job!.status !== 'pending' && job!.status !== 'running')
              return job!.status;
            assert.equal(await delivery.once(), true);
          }
          throw new Error(
            'Subscription delivery did not reach a terminal state',
          );
        };
        for (const consent of [
          '',
          'listing-updates-v0',
          'listing-updates-v-next',
        ]) {
          // Unknown consent stays persisted; neither gate may silently upgrade it.
          await pool.query(
            'UPDATE listing_subscriptions SET consent_version=$3 WHERE user_id=$1 AND listing_id=$2',
            [userId, listingId, consent],
          );
          assert.equal(await count(await enqueue()), 0);
          const [job] = await db.rows<{ id: string }>(
            `INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
             VALUES($1,'email','subscription.listing.price_drop',$2,$3::jsonb) RETURNING id`,
            [
              userId,
              `consent-test:${randomUUID()}`,
              JSON.stringify({
                listingId,
                subscriptionVersion: 1,
                event: {
                  kind: 'price_drop',
                  previousPriceMinor: 10000,
                  priceMinor: 9900,
                },
              }),
            ],
          );
          const sends = subscriptionCalls().length;
          assert.equal(await drain(job!.id), 'skipped');
          assert.equal(subscriptionCalls().length, sends);
          assert.deepEqual(
            (
              await db.rows(
                'SELECT consent_version,version FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2',
                [userId, listingId],
              )
            )[0],
            { consent_version: consent, version: 1 },
          );
        }
        await pool.query(
          'UPDATE listing_subscriptions SET consent_version=$3 WHERE user_id=$1 AND listing_id=$2',
          [userId, listingId, listingSubscriptionConsentVersion],
        );
        const currentKey = await enqueue();
        assert.equal(await count(currentKey), 1);
        const [current] = await db.rows<{ id: string }>(
          'SELECT id FROM notification_deliveries WHERE user_id=$1 AND dedupe_key=$2',
          [userId, currentKey],
        );
        const sends = subscriptionCalls().length;
        assert.equal(await drain(current!.id), 'sent');
        assert.equal(subscriptionCalls().length, sends + 1);
        const queuedKey = await enqueue();
        assert.equal(await count(queuedKey), 1);
        const [queued] = await db.rows<{ id: string }>(
          'SELECT id FROM notification_deliveries WHERE user_id=$1 AND dedupe_key=$2',
          [userId, queuedKey],
        );
        // Keep subscriptionVersion unchanged: consent gate must work independently.
        await pool.query(
          "UPDATE listing_subscriptions SET consent_version='listing-updates-v0' WHERE user_id=$1 AND listing_id=$2",
          [userId, listingId],
        );
        assert.equal(await drain(queued!.id), 'skipped');
        assert.equal(subscriptionCalls().length, sends + 1);
        assert.equal(
          (
            await db.rows(
              'SELECT version FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2',
              [userId, listingId],
            )
          )[0]!.version,
          1,
        );
      },
    );
    await t.test(
      'Unsubscribe serializes final subscription gate and bounded transport',
      async () => {
        const actor = actors[0]!;
        const subscriptions = app.get(ListingSubscriptions);
        const setup = async () => {
          const [row] = await db.rows<{ version: number }>(
            `UPDATE listing_subscriptions SET disabled_at=NULL,consent_version=$3,version=version+1
           WHERE user_id=$1 AND listing_id=$2 RETURNING version`,
            [actor.id, listingId, listingSubscriptionConsentVersion],
          );
          const [job] = await db.rows<{ id: string }>(
            `INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
           VALUES($1,'email','subscription.listing.price_drop',$2,$3::jsonb) RETURNING id`,
            [
              actor.id,
              `unsubscribe-test:${randomUUID()}`,
              JSON.stringify({
                listingId,
                subscriptionVersion: row!.version,
                event: { kind: 'price_drop' },
              }),
            ],
          );
          return { id: job!.id, version: row!.version };
        };
        const status = async (id: string) =>
          (
            await db.rows<{ status: string }>(
              'SELECT status FROM notification_deliveries WHERE id=$1',
              [id],
            )
          )[0]!.status;
        const waitFor = async (check: () => boolean | Promise<boolean>) => {
          const deadline = performance.now() + 4000;
          while (performance.now() < deadline) {
            if (await check()) return;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          assert.fail('Expected race barrier was not reached');
        };
        const lockWait = async (part: string, blocker?: number) =>
          Boolean(
            (
              await pool.query(
                `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
         AND wait_event_type='Lock' AND position($1 in query)>0
         AND ($2::integer IS NULL OR $2=ANY(pg_blocking_pids(pid)))) AS waiting`,
                [part, blocker ?? null],
              )
            ).rows[0].waiting,
          );
        const sends = () =>
          adapter.calls.filter(
            (call) => call.kind === 'subscription.listing.price_drop',
          ).length;

        // A committed disable wins before the worker reaches its final consent gate.
        const before = await setup();
        await subscriptions.disable(actor, listingId, {
          version: before.version,
        });
        const beforeCalls = sends();
        await delivery.once();
        assert.equal(await status(before.id), 'skipped');
        assert.equal(sends(), beforeCalls);

        // Transport wins the lock; disable cannot acknowledge until the attempt ends.
        for (const outcome of ['ack', 'error', 'timeout'] as const) {
          const job = await setup();
          let entered = false;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let aborted = false;
          adapter.onSend = async (_envelope, signal) => {
            entered = true;
            if (outcome === 'timeout') {
              await new Promise<void>((_resolve, reject) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    reject(new Error('Test transport aborted'));
                  },
                  { once: true },
                ),
              );
            } else {
              await gate;
              if (outcome === 'error')
                throw new Error('Test transport failure');
            }
          };
          const working = delivery.once();
          let disabling: Promise<unknown> | undefined;
          let disableDone = false;
          let disableError: unknown;
          try {
            await waitFor(() => entered);
            disabling = subscriptions
              .disable(actor, listingId, { version: job.version })
              .then(() => {
                disableDone = true;
              })
              .catch((error: unknown) => {
                disableError = error;
              });
            await waitFor(() =>
              lockWait('SELECT version FROM listing_subscriptions'),
            );
            assert.equal(disableDone, false);
            release();
            await working;
            await disabling;
            assert.equal(disableError, undefined);
            assert.equal(disableDone, true);
            assert.equal(
              await status(job.id),
              outcome === 'ack' ? 'sent' : 'pending',
            );
            if (outcome === 'timeout') assert.equal(aborted, true);
            // Retry an old job after successful disable: no transport invocation.
            await pool.query(
              "UPDATE notification_deliveries SET status='pending',available_at=now() WHERE id=$1",
              [job.id],
            );
            const calls = sends();
            await delivery.once();
            assert.equal(await status(job.id), 'skipped');
            assert.equal(sends(), calls);
          } finally {
            release();
            await working;
            if (disabling) await disabling;
            delete adapter.onSend;
          }
        }

        // A lease may expire while either lock is held without that row changing.
        for (const lockedTable of [
          'listing_subscriptions',
          'notification_deliveries',
        ] as const) {
          const job = await setup();
          const holder = await pool.connect();
          let working: Promise<boolean> | undefined;
          try {
            await holder.query('BEGIN');
            const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
              .rows[0].pid as number;
            if (lockedTable === 'listing_subscriptions') {
              await holder.query(
                'SELECT 1 FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2 FOR UPDATE',
                [actor.id, listingId],
              );
              working = delivery.once();
              await waitFor(() =>
                lockWait('SELECT 1 FROM listing_subscriptions', pid),
              );
              // Claim has committed. Shorten lease before releasing consent lock.
              await pool.query(
                "UPDATE notification_deliveries SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
                [job.id],
              );
            } else {
              // Stop before the subscription gate so the claim can finish first.
              const consentHolder = await pool.connect();
              try {
                await consentHolder.query('BEGIN');
                await consentHolder.query(
                  'SELECT 1 FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2 FOR UPDATE',
                  [actor.id, listingId],
                );
                working = delivery.once();
                await waitFor(() =>
                  lockWait('SELECT 1 FROM listing_subscriptions'),
                );
                await pool.query(
                  "UPDATE notification_deliveries SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
                  [job.id],
                );
                await holder.query(
                  'SELECT id FROM notification_deliveries WHERE id=$1 FOR UPDATE',
                  [job.id],
                );
                await consentHolder.query('COMMIT');
              } finally {
                await consentHolder.query('ROLLBACK');
                consentHolder.release();
              }
              await waitFor(() =>
                lockWait('SELECT id FROM notification_deliveries', pid),
              );
            }
            // DB clock is the proof; no fixed sleep substitutes for expiry.
            await waitFor(async () =>
              Boolean(
                (
                  await holder.query(
                    'SELECT lease_until<=clock_timestamp() AS expired FROM notification_deliveries WHERE id=$1',
                    [job.id],
                  )
                ).rows[0].expired,
              ),
            );
            const calls = sends();
            await holder.query('COMMIT');
            await working;
            assert.equal(sends(), calls);
            assert.equal(await status(job.id), 'running');
            // Prevent this deliberately expired fixture from being reclaimed later.
            await pool.query(
              "UPDATE notification_deliveries SET status='skipped',lease_token=NULL,lease_until=NULL WHERE id=$1",
              [job.id],
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            if (working) await working;
          }
        }
      },
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
