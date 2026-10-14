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
import { Organizations } from './modules/organizations/organizations';
import { Actor, hash, token } from './common/security';
import { ProfessionalFeeds } from './modules/professional/feeds';
import { ProfessionalImports } from './modules/professional/imports';
import { ProfessionalPlatform } from './modules/professional/platform';
import { ListingAccess } from './modules/listings/access';
import { Product } from './modules/product/product';
import { ListingSubscriptions } from './modules/product/subscriptions';
import { enqueueImmediateListingNotifications } from './modules/product/subscription-outbox';
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
    organizations = app.get(Organizations),
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
          '20',
        );
        const p = await platform.preferences(actors[0]!);
        assert.equal(p!.email, false);
        const holder = await pool.connect();
        let updating:
          ReturnType<ProfessionalPlatform['setPreferences']> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
            [actors[0]!.id],
          );
          const blocker = (await holder.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          updating = platform.setPreferences(actors[0]!, {
            email: false,
            push: false,
            transactional: true,
          });
          const deadline = performance.now() + 4000;
          let waiting = false;
          while (performance.now() < deadline) {
            waiting = (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position('SELECT id FROM users' in query)>0 AND $1=ANY(pg_blocking_pids(pid))) AS waiting",
                [blocker],
              )
            ).rows[0].waiting;
            if (waiting) break;
            await new Promise<void>((done) => setImmediate(done));
          }
          assert.equal(waiting, true);
          await holder.query('COMMIT');
          assert.equal((await updating)!.email, false);
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          if (updating) await updating;
        }
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
        const recipient = randomUUID();
        await pool.query(
          "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Bulk notification fixture','buyer',now(),now())",
          [recipient, recipient + '@example.test'],
        );
        await pool.query(
          `INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version)
          VALUES($1,$2,ARRAY['availability'],ARRAY['email'],'immediate',$3)`,
          [recipient, listingId, listingSubscriptionConsentVersion],
        );
        assert.ok(await app.get(ListingAccess).visible(listingId));
        const bulkQueued = async () =>
          (
            await pool.query(
              "SELECT payload FROM notification_deliveries WHERE user_id=$1 AND payload->>'listingId'=$2",
              [recipient, listingId],
            )
          ).rows;
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
        const queued = await bulkQueued();
        assert.equal(queued.length, 1);
        const paused = (
          await pool.query('SELECT version FROM listings WHERE id=$1', [
            listingId,
          ])
        ).rows[0];
        assert.deepEqual(queued[0].payload, {
          listingId,
          listingVersion: paused.version,
          subscriptionVersion: 1,
          event: { kind: 'availability', available: false },
        });
        await pool.query(
          "UPDATE notification_deliveries SET status='skipped' WHERE user_id=$1 AND payload->>'listingId'=$2",
          [recipient, listingId],
        );
        // Published status alone is insufficient: unverified seller prevents disclosure.
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          listingId,
        ]);
        const seller = (
          await pool.query('SELECT seller_id FROM listings WHERE id=$1', [
            listingId,
          ])
        ).rows[0].seller_id;
        await pool.query(
          'UPDATE users SET email_verified_at=NULL WHERE id=$1',
          [seller],
        );
        try {
          assert.equal(
            await app.get(ListingAccess).visible(listingId),
            undefined,
          );
          assert.equal(
            (await platform.bulkPause(actors[0]!, org, input, token())).paused,
            1,
          );
          assert.equal((await bulkQueued()).length, 1);
        } finally {
          await pool.query(
            'UPDATE users SET email_verified_at=now() WHERE id=$1',
            [seller],
          );
        }
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
      'Partner expiry is rechecked after organization and client lock waits',
      async () => {
        for (const lock of ['organization', 'client'] as const) {
          const client = await platform.createPartnerClient(
            actors[0]!,
            org,
            {
              name: `Expiry during ${lock} wait`,
              scopes: ['listings:read'],
            },
            token(),
          );
          if (lock === 'client')
            await pool.query(
              "UPDATE partner_clients SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
              [client.id],
            );
          const holder = await pool.connect();
          let authenticating: Promise<unknown> | undefined;
          try {
            await holder.query('BEGIN');
            const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
              .rows[0].pid;
            await holder.query(
              lock === 'organization'
                ? 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE'
                : 'SELECT id FROM partner_clients WHERE id=$1 FOR UPDATE',
              [lock === 'organization' ? org : client.id],
            );
            authenticating = platform.partner(client.token!, 'listings:read');
            void authenticating.catch(() => {});
            const deadline = performance.now() + 4000;
            let blocked = false;
            while (performance.now() < deadline) {
              blocked = (
                await pool.query(
                  `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
                AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked`,
                  [pid],
                )
              ).rows[0].blocked;
              if (blocked) break;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            assert.ok(blocked, `authentication did not wait on ${lock}`);
            if (lock === 'organization')
              await pool.query(
                "UPDATE partner_clients SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                [client.id],
              );
            let expired = false;
            while (performance.now() < deadline) {
              expired = (
                await pool.query(
                  'SELECT expires_at<=clock_timestamp() AS expired FROM partner_clients WHERE id=$1',
                  [client.id],
                )
              ).rows[0].expired;
              if (expired) break;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            assert.ok(expired, 'token did not expire before releasing lock');
            await holder.query('COMMIT');
            await assert.rejects(authenticating, /Partner scope required/);
            const [state] = await db.rows<{
              last_used_at: unknown;
              count: unknown;
            }>(
              'SELECT k.last_used_at,u.count FROM partner_clients k LEFT JOIN partner_client_usage u ON u.client_id=k.id WHERE k.id=$1',
              [client.id],
            );
            assert.equal(state!.last_used_at, null);
            assert.equal(state!.count, null);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            if (authenticating) await Promise.allSettled([authenticating]);
          }
        }
      },
    );
    await t.test(
      'Membership privilege loss permanently revokes partner clients without lock-order deadlocks',
      async () => {
        await organizations.setMember(actors[0]!, org, {
          userId: actors[1]!.id,
          role: 'admin',
          active: true,
        });
        const first = await platform.createPartnerClient(
          actors[1]!,
          org,
          {
            name: 'Offboarded first client',
            scopes: ['listings:read'],
            requestsPerMinute: 10,
          },
          token(),
        );
        const second = await platform.createPartnerClient(
          actors[1]!,
          org,
          {
            name: 'Offboarded second client',
            scopes: ['listings:read'],
            requestsPerMinute: 10,
          },
          token(),
        );
        const other = await platform.createPartnerClient(
          actors[1]!,
          otherOrg,
          {
            name: 'Other organization control',
            scopes: ['listings:read'],
            requestsPerMinute: 10,
          },
          token(),
        );
        const sameOrganizationControl = await platform.createPartnerClient(
          actors[0]!,
          org,
          {
            name: 'Same organization creator control',
            scopes: ['listings:read'],
            requestsPerMinute: 10,
          },
          token(),
        );
        await platform.partner(first.token!, 'listings:read');
        const holder = await pool.connect();
        let authenticating: Promise<unknown> | undefined;
        let offboarding: Promise<unknown> | undefined;
        try {
          await holder.query('BEGIN');
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid as number;
          await holder.query(
            'SELECT client_id FROM partner_client_usage WHERE client_id=$1 FOR UPDATE',
            [first.id],
          );
          authenticating = platform.partner(first.token!, 'listings:read');
          void authenticating.catch(() => {});
          const deadline = performance.now() + 4000;
          let authPid: number | undefined;
          while (performance.now() < deadline) {
            const [waiting] = (
              await pool.query<{ pid: number }>(
                `SELECT pid FROM pg_stat_activity
                 WHERE datname=current_database() AND wait_event_type='Lock'
                   AND position($1 in query)>0
                   AND $2::integer=ANY(pg_blocking_pids(pid))`,
                ['INSERT INTO partner_client_usage', holderPid],
              )
            ).rows;
            if (waiting) {
              authPid = waiting.pid;
              break;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          assert.ok(authPid, 'partner authentication did not reach usage lock');
          offboarding = organizations.setMember(actors[0]!, org, {
            userId: actors[1]!.id,
            role: 'member',
            active: false,
          });
          void offboarding.catch(() => {});
          let offboardBlocked = false;
          while (performance.now() < deadline) {
            offboardBlocked = Boolean(
              (
                await pool.query(
                  `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                   WHERE datname=current_database() AND wait_event_type='Lock'
                     AND position($1 in query)>0
                     AND $2::integer=ANY(pg_blocking_pids(pid))) AS waiting`,
                  ['SELECT id FROM organizations WHERE id=', authPid],
                )
              ).rows[0].waiting,
            );
            if (offboardBlocked) break;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          assert.ok(
            offboardBlocked,
            'offboarding did not wait for authentication',
          );
          await holder.query('COMMIT');
          await authenticating;
          await offboarding;
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          await Promise.allSettled(
            [authenticating, offboarding].filter(
              (promise): promise is Promise<unknown> => promise !== undefined,
            ),
          );
        }
        const clients = await db.rows<{ id: string; active: boolean }>(
          'SELECT id,active FROM partner_clients WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[first.id, second.id, other.id, sameOrganizationControl.id]],
        );
        const active = new Map(
          clients.map((client) => [client.id, client.active]),
        );
        assert.equal(active.get(first.id), false);
        assert.equal(active.get(second.id), false);
        assert.equal(active.get(other.id), true);
        assert.equal(active.get(sameOrganizationControl.id), true);
        await assert.rejects(platform.partner(first.token!, 'listings:read'));
        await assert.rejects(platform.partner(second.token!, 'listings:read'));
        await platform.partner(other.token!, 'listings:read');
        await platform.partner(sameOrganizationControl.token!, 'listings:read');
        await organizations.setMember(actors[0]!, org, {
          userId: actors[1]!.id,
          role: 'member',
          active: false,
        });
        const revokedAudit = await db.rows<{
          actor_id: string;
          entity_type: string;
          entity_id: string;
          data: {
            reason: string;
            organizationId: string;
            userId: string;
          };
        }>(
          `SELECT actor_id,entity_type,entity_id,data FROM audit_events
           WHERE action='partner.client.revoked'
             AND entity_id=ANY($1::text[]) ORDER BY entity_id`,
          [[first.id, second.id]],
        );
        assert.equal(revokedAudit.length, 2);
        for (const event of revokedAudit) {
          assert.equal(event.actor_id, actors[0]!.id);
          assert.equal(event.entity_type, 'partner_client');
          assert.equal(event.data.reason, 'membership_offboarded');
          assert.equal(event.data.organizationId, org);
          assert.equal(event.data.userId, actors[1]!.id);
        }
        assert.deepEqual(
          revokedAudit.map((event) => event.entity_id),
          [first.id, second.id].sort(),
        );
        await organizations.setMember(actors[0]!, org, {
          userId: actors[1]!.id,
          role: 'admin',
          active: true,
        });
        await assert.rejects(platform.partner(first.token!, 'listings:read'));
        await assert.rejects(platform.partner(second.token!, 'listings:read'));
        const replacement = await platform.createPartnerClient(
          actors[1]!,
          org,
          {
            name: 'Replacement after reactivation',
            scopes: ['listings:read'],
          },
          token(),
        );
        await platform.partner(replacement.token!, 'listings:read');
        await organizations.setMember(actors[0]!, org, {
          userId: actors[1]!.id,
          role: 'member',
          active: true,
        });
        await assert.rejects(
          platform.partner(replacement.token!, 'listings:read'),
        );
        assert.equal(
          (
            await db.rows<{ active: boolean }>(
              'SELECT active FROM partner_clients WHERE id=$1',
              [replacement.id],
            )
          )[0]!.active,
          false,
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
          "SELECT id FROM notification_deliveries WHERE user_id=$1 AND kind='message' AND payload->>'notificationId'=$2",
          [actors[0]!.id, n!.id],
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
              "SELECT count(*) FROM notification_deliveries WHERE user_id=$1 AND kind='message' AND payload->>'notificationId'=$2",
              [actors[0]!.id, n!.id],
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
          // Eligibility/current state must be valid so consent tests are not masked.
          await pool.query(
            "UPDATE listings SET status='published',price=99,version=$2 WHERE id=$1",
            [listingId, event.version],
          );
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event),
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
                listingVersion: eventVersion,
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
                listingVersion: (
                  await db.rows<{ version: number }>(
                    'SELECT version FROM listings WHERE id=$1',
                    [listingId],
                  )
                )[0]!.version,
                event: {
                  kind: 'price_drop',
                  previousPriceMinor: 10000,
                  priceMinor: 9900,
                },
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
    await t.test(
      'Listing deliveries require latest full-public state or a neutral current unavailable event',
      async () => {
        const access = app.get(ListingAccess);
        const recipient = actors[1]!.id;
        const seller = actors[0]!.id;
        await pool.query(
          `INSERT INTO notification_preferences(user_id,email) VALUES($1,true)
        ON CONFLICT(user_id) DO UPDATE SET email=true`,
          [recipient],
        );
        const [subscription] = await db.rows<{ version: number }>(
          `INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version)
         VALUES($1,$2,ARRAY['price_drop','availability'],ARRAY['email'],'immediate',$3)
         ON CONFLICT(user_id,listing_id) DO UPDATE SET disabled_at=NULL,events=EXCLUDED.events,
           channels=EXCLUDED.channels,frequency=EXCLUDED.frequency,consent_version=EXCLUDED.consent_version
         RETURNING version`,
          [recipient, listingId, listingSubscriptionConsentVersion],
        );
        const originalSeller = (
          await pool.query(
            'SELECT role,active,email_verified_at,phone_verified_at FROM users WHERE id=$1',
            [seller],
          )
        ).rows[0];
        const restore = async () => {
          await pool.query(
            'UPDATE users SET role=$2,active=$3,email_verified_at=$4,phone_verified_at=$5 WHERE id=$1',
            [
              seller,
              originalSeller.role,
              originalSeller.active,
              originalSeller.email_verified_at,
              originalSeller.phone_verified_at,
            ],
          );
          await pool.query('UPDATE organizations SET active=true WHERE id=$1', [
            org,
          ]);
          await pool.query(
            `INSERT INTO memberships(organization_id,user_id,role,active) VALUES($1,$2,'owner',true)
          ON CONFLICT(organization_id,user_id) DO UPDATE SET active=true`,
            [org, seller],
          );
          await pool.query(
            "UPDATE listings SET status='published',price=99,version=7000 WHERE id=$1",
            [listingId],
          );
        };
        const payload = (
          event: unknown = {
            kind: 'price_drop',
            previousPriceMinor: 10000,
            priceMinor: 9900,
          },
        ) => ({
          listingId,
          listingVersion: 7000,
          subscriptionVersion: subscription!.version,
          event,
        });
        const calls = () =>
          adapter.calls.filter(
            (call) =>
              call.userId === recipient &&
              call.kind.startsWith('subscription.listing.'),
          );
        const run = async (
          body: unknown,
          expected: 'sent' | 'skipped',
          kind = 'subscription.listing.price_drop',
        ) => {
          const [job] = await db.rows<{ id: string }>(
            `INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
          VALUES($1,'email',$2,$3,$4::jsonb) RETURNING id`,
            [recipient, kind, `state:${randomUUID()}`, JSON.stringify(body)],
          );
          const before = calls().length;
          await delivery.once();
          assert.equal(
            (
              await db.rows(
                'SELECT status FROM notification_deliveries WHERE id=$1',
                [job!.id],
              )
            )[0]!.status,
            expected,
          );
          assert.equal(calls().length, before + (expected === 'sent' ? 1 : 0));
          if (expected === 'sent')
            assert.deepEqual(calls().at(-1)!.payload, body);
        };
        await restore();
        assert.equal(
          (await access.currentVisibility(listingId))!.visible,
          true,
        );
        assert.ok(await access.visible(listingId));
        await run(payload(), 'sent');
        await run(
          payload({ kind: 'availability', available: true }),
          'sent',
          'subscription.listing.availability',
        );
        // Same version with a different live price cannot deliver a stale price event.
        await pool.query('UPDATE listings SET price=98 WHERE id=$1', [
          listingId,
        ]);
        await run(payload(), 'skipped');
        await restore();
        await run({ ...payload(), listingVersion: 6999 }, 'skipped');
        for (const mutation of [
          {
            sql: "UPDATE listings SET status='paused' WHERE id=$1",
            args: [listingId],
          },
          { sql: 'UPDATE users SET active=false WHERE id=$1', args: [seller] },
          { sql: "UPDATE users SET role='buyer' WHERE id=$1", args: [seller] },
          {
            sql: 'UPDATE users SET email_verified_at=NULL WHERE id=$1',
            args: [seller],
          },
          {
            sql: 'UPDATE users SET phone_verified_at=NULL WHERE id=$1',
            args: [seller],
          },
          {
            sql: 'UPDATE organizations SET active=false WHERE id=$1',
            args: [org],
          },
          {
            sql: 'UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2',
            args: [org, seller],
          },
          {
            sql: 'DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2',
            args: [org, seller],
          },
        ]) {
          await restore();
          await pool.query(mutation.sql, mutation.args);
          assert.equal(
            (
              await db.rows('SELECT version FROM listings WHERE id=$1', [
                listingId,
              ])
            )[0]!.version,
            7000,
          );
          assert.equal(
            (await access.currentVisibility(listingId))!.visible,
            false,
          );
          assert.equal(await access.visible(listingId), undefined);
          await run(payload(), 'skipped');
          await run(
            payload({ kind: 'availability', available: true }),
            'skipped',
            'subscription.listing.availability',
          );
        }
        await restore();
        await pool.query(
          "UPDATE listings SET status='paused',title='PRIVATE TITLE',price=1 WHERE id=$1",
          [listingId],
        );
        const unavailable = payload({ kind: 'availability', available: false });
        await run(unavailable, 'sent', 'subscription.listing.availability');
        // Neutral envelope contains no current hidden title, price or cause.
        assert.deepEqual(calls().at(-1)!.payload, unavailable);
        await run(
          { ...unavailable, listingVersion: 6999 },
          'skipped',
          'subscription.listing.availability',
        );
        await restore();
        await run(unavailable, 'skipped', 'subscription.listing.availability');
        await pool.query(
          "UPDATE listings SET status='paused',version=7001 WHERE id=$1",
          [listingId],
        );
        await run(unavailable, 'skipped', 'subscription.listing.availability');
        await restore();
        const missing = payload() as Record<string, unknown>;
        delete missing.listingVersion;
        await run(missing, 'skipped');
        await run({ ...payload(), privateReason: 'hidden' }, 'skipped');
        await run(
          payload({
            kind: 'price_drop',
            previousPriceMinor: 10000,
            priceMinor: 9900,
            title: 'hidden',
          }),
          'skipped',
        );
        await run(payload(), 'skipped', 'subscription.listing.availability');
      },
    );
    await t.test(
      'Immediate subscription inbox uses current consent, safe public state and advancing raw cursors',
      async () => {
        const product = app.get(Product);
        const subscriptions = app.get(ListingSubscriptions);
        const recipient = actors[1]!;
        const originalListing = (
          await pool.query(
            'SELECT status,version,price,title FROM listings WHERE id=$1',
            [listingId],
          )
        ).rows[0];
        const originalSeller = (
          await pool.query(
            'SELECT active,role,email_verified_at,phone_verified_at FROM users WHERE id=$1',
            [actors[0]!.id],
          )
        ).rows[0];
        await pool.query(
          "UPDATE users SET active=true,role='agency',email_verified_at=now(),phone_verified_at=now() WHERE id=$1",
          [actors[0]!.id],
        );
        await pool.query(
          "UPDATE listings SET status='published',version=8000,price=99,title='Public inbox fixture' WHERE id=$1",
          [listingId],
        );
        await pool.query(
          'INSERT INTO notification_preferences(user_id,in_app,email) VALUES($1,true,true) ON CONFLICT(user_id) DO UPDATE SET in_app=true,email=true',
          [recipient.id],
        );
        const configureSubscription = async (
          patch: {
            channels?: readonly string[];
            frequency?: string;
            consent?: string;
            disabled?: boolean;
          } = {},
        ) =>
          (
            await pool.query(
              `INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version)
         VALUES($1,$2,ARRAY['price_drop','availability'],$3,$4,$5)
         ON CONFLICT(user_id,listing_id) DO UPDATE SET events=EXCLUDED.events,channels=EXCLUDED.channels,frequency=EXCLUDED.frequency,consent_version=EXCLUDED.consent_version,disabled_at=$6,version=listing_subscriptions.version+1 RETURNING version`,
              [
                recipient.id,
                listingId,
                patch.channels ?? ['email', 'in_app'],
                patch.frequency ?? 'immediate',
                patch.consent ?? listingSubscriptionConsentVersion,
                patch.disabled ? new Date() : null,
              ],
            )
          ).rows[0].version as number;
        const event = (version: number) => ({
          listingId,
          version,
          publicBefore: true,
          publicAfter: true,
          previousPrice: '100',
          price: '99',
        });
        const inbox = async (version: number) =>
          (
            await pool.query(
              'SELECT id::text,payload FROM notifications WHERE user_id=$1 AND dedupe_key=$2',
              [recipient.id, `listing:${listingId}:${version}:price_drop`],
            )
          ).rows;
        const email = async (version: number) =>
          (
            await pool.query(
              'SELECT id FROM notification_deliveries WHERE user_id=$1 AND dedupe_key=$2',
              [recipient.id, `listing:${listingId}:${version}:price_drop`],
            )
          ).rows;
        try {
          const subscriptionVersion = await configureSubscription();
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8000)),
          );
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8000)),
          );
          assert.equal((await inbox(8000)).length, 1);
          assert.equal((await email(8000)).length, 1);
          const id = (await inbox(8000))[0].id;
          // Legacy message bridge must not relabel a subscription row and bypass its consent gate.
          const forgedOutbox = (
            await pool.query(
              "INSERT INTO notification_outbox(notification_id,channel) VALUES($1,'email') RETURNING id::text",
              [id],
            )
          ).rows[0].id;
          await delivery.bridge();
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM notification_deliveries WHERE dedupe_key=$1',
                [`notification-outbox:${forgedOutbox}`],
              )
            ).rows[0].count,
            0,
          );

          const response = await call(
            '/v1/account/notifications',
            'GET',
            undefined,
            1,
          );
          assert.equal(response.status, 200);
          const row = (
            (await response.json()) as {
              items: { id: string; created_at: string }[];
            }
          ).items.find((row: { id: string }) => row.id === id);
          assert.ok(row);
          assert.deepEqual(row, {
            id,
            kind: 'subscription.listing.price_drop',
            listing_id: listingId,
            event: {
              kind: 'price_drop',
              previousPriceMinor: 10000,
              priceMinor: 9900,
            },
            read_at: null,
            created_at: row.created_at,
          });
          const wrong = await call(
            `/v1/account/notifications/${id}/read`,
            'POST',
            undefined,
            0,
          );
          assert.equal(wrong.status, 404);
          assert.equal(
            (
              await call(
                `/v1/account/notifications/${id}/read`,
                'POST',
                undefined,
                1,
              )
            ).status,
            201,
          );
          assert.equal(
            (
              await call(
                `/v1/account/notifications/${id}/read`,
                'POST',
                undefined,
                1,
              )
            ).status,
            201,
          );
          await pool.query('UPDATE listings SET price=98 WHERE id=$1', [
            listingId,
          ]);
          assert.equal(
            (await product.notifications(recipient, {})).items.some(
              (row) => row.id === id,
            ),
            false,
          );
          const originalReadAt = (
            await pool.query('SELECT read_at FROM notifications WHERE id=$1', [
              id,
            ])
          ).rows[0].read_at;
          assert.equal(
            (
              await call(
                `/v1/account/notifications/${id}/read`,
                'POST',
                undefined,
                1,
              )
            ).status,
            404,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT read_at FROM notifications WHERE id=$1',
                [id],
              )
            ).rows[0].read_at,
            originalReadAt,
          );
          await pool.query('UPDATE listings SET price=99 WHERE id=$1', [
            listingId,
          ]);
          await subscriptions.disable(recipient, listingId, {
            version: subscriptionVersion,
          });
          const filtered = await product.notifications(recipient, { limit: 1 });
          assert.deepEqual(filtered.items, []);
          assert.equal(filtered.cursor, id);
          await configureSubscription();
          assert.equal(
            (await product.notifications(recipient, {})).items.some(
              (row) => row.id === id,
            ),
            false,
          );
          for (const [
            version,
            patch,
            enabled,
            expectedInbox,
            expectedEmail,
          ] of [
            [8001, { channels: ['in_app'] }, true, 1, 0],
            [8002, { channels: ['email'] }, true, 0, 1],
            [8003, {}, false, 0, 1],
            [8004, { frequency: 'daily' }, true, 0, 0],
            [8005, { consent: 'listing-updates-v0' }, true, 0, 0],
            [8006, { disabled: true }, true, 0, 0],
          ] as const) {
            await configureSubscription({
              ...patch,
              ...('channels' in patch ? { channels: [...patch.channels] } : {}),
            });
            await pool.query(
              'UPDATE notification_preferences SET in_app=$2 WHERE user_id=$1',
              [recipient.id, enabled],
            );
            await pool.query('UPDATE listings SET version=$2 WHERE id=$1', [
              listingId,
              version,
            ]);
            await db.transaction((sql) =>
              enqueueImmediateListingNotifications(sql, event(version)),
            );
            assert.equal((await inbox(version)).length, expectedInbox);
            assert.equal((await email(version)).length, expectedEmail);
          }
          await configureSubscription();
          await pool.query(
            'UPDATE notification_preferences SET in_app=true WHERE user_id=$1',
            [recipient.id],
          );
          await assert.rejects(
            db.transaction(async (sql) => {
              await enqueueImmediateListingNotifications(sql, event(8007));
              throw new Error('rollback inbox');
            }),
            /rollback inbox/,
          );
          assert.equal((await inbox(8007)).length, 0);
          assert.equal((await email(8007)).length, 0);
          await pool.query(
            "UPDATE listings SET status='paused',version=8008,title='PRIVATE',price=1 WHERE id=$1",
            [listingId],
          );
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, {
              listingId,
              version: 8008,
              publicBefore: true,
              publicAfter: false,
              previousPrice: '',
              price: '',
            }),
          );
          const unavailable = (
            await product.notifications(recipient, {})
          ).items.find(
            (row) =>
              row.kind === 'subscription.listing.availability' &&
              row.listing_id === listingId,
          );
          assert.ok(unavailable);
          assert.deepEqual(Object.keys(unavailable).sort(), [
            'created_at',
            'event',
            'id',
            'kind',
            'listing_id',
            'read_at',
          ]);
          assert.deepEqual('event' in unavailable && unavailable.event, {
            kind: 'availability',
            available: false,
          });
          await pool.query(
            "UPDATE listings SET status='published',version=8009,price=99 WHERE id=$1",
            [listingId],
          );
          assert.equal(
            (await product.notifications(recipient, {})).items.some(
              (row) => row.id === unavailable.id,
            ),
            false,
          );

          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8009)),
          );
          const currentId = (await inbox(8009))[0].id;
          for (const mutate of [
            () =>
              pool.query('UPDATE users SET active=false WHERE id=$1', [
                actors[0]!.id,
              ]),
            () =>
              pool.query('UPDATE organizations SET active=false WHERE id=$1', [
                org,
              ]),
            () =>
              pool.query(
                'UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2',
                [org, actors[0]!.id],
              ),
          ]) {
            await mutate();
            assert.equal(
              (await product.notifications(recipient, {})).items.some(
                (row) => row.id === currentId,
              ),
              false,
            );
            await pool.query('UPDATE users SET active=true WHERE id=$1', [
              actors[0]!.id,
            ]);
            await pool.query(
              'UPDATE organizations SET active=true WHERE id=$1',
              [org],
            );
            await pool.query(
              'UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2',
              [org, actors[0]!.id],
            );
          }
          const thread = (
            await pool.query(
              'INSERT INTO inquiry_threads(listing_id,buyer_id,seller_id) VALUES($1,$2,$3) ON CONFLICT(listing_id,buyer_id) DO UPDATE SET listing_id=EXCLUDED.listing_id RETURNING id',
              [listingId, recipient.id, actors[0]!.id],
            )
          ).rows[0].id;
          const olderMessage = (
            await pool.query(
              "INSERT INTO notifications(user_id,thread_id,kind) VALUES($1,$2,'message') RETURNING id::text",
              [recipient.id, thread],
            )
          ).rows[0].id;
          const pageVersion = await configureSubscription();
          await pool.query('UPDATE listings SET version=8010 WHERE id=$1', [
            listingId,
          ]);
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8010)),
          );
          const newerStale = (await inbox(8010))[0].id;
          await subscriptions.disable(recipient, listingId, {
            version: pageVersion,
          });
          const first = await product.notifications(recipient, { limit: 1 });
          assert.deepEqual(first, { items: [], cursor: newerStale });
          const second = await product.notifications(recipient, {
            limit: 1,
            cursor: first.cursor,
          });
          assert.equal(second.items[0]!.id, olderMessage);
          await configureSubscription();
          await pool.query('UPDATE listings SET version=8011 WHERE id=$1', [
            listingId,
          ]);
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8011)),
          );
          const readId = (await inbox(8011))[0].id;
          const readVersion = (
            await pool.query(
              'SELECT version FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2',
              [recipient.id, listingId],
            )
          ).rows[0].version;
          const waitForLock = async (part: string, blocker?: number) => {
            const deadline = performance.now() + 4000;
            while (performance.now() < deadline) {
              const waiting = (
                await pool.query(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position($1 in query)>0 AND ($2::integer IS NULL OR $2=ANY(pg_blocking_pids(pid)))) AS waiting",
                  [part, blocker ?? null],
                )
              ).rows[0].waiting;
              if (waiting) return;
              await new Promise<void>((done) => setImmediate(done));
            }
            assert.fail('Inbox lock barrier was not reached');
          };
          const readHolder = await pool.connect();
          let heldRead: ReturnType<Product['read']> | undefined;
          let heldDisable:
            ReturnType<ListingSubscriptions['disable']> | undefined;
          let heldPrefs: ReturnType<Product['preferences']> | undefined;
          try {
            await readHolder.query('BEGIN');
            await readHolder.query(
              'SELECT id FROM notifications WHERE id=$1 FOR UPDATE',
              [readId],
            );
            const pid = (
              await readHolder.query('SELECT pg_backend_pid() AS pid')
            ).rows[0].pid;
            heldRead = product.read(recipient, readId);
            await waitForLock('UPDATE notifications', pid);
            // The blocked final UPDATE proves the real reader already holds its user and subscription locks.
            const readerPid = (
              await pool.query(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position('UPDATE notifications' in query)>0 AND $1=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0].pid;
            heldDisable = subscriptions.disable(recipient, listingId, {
              version: readVersion,
            });
            await waitForLock(
              'SELECT version FROM listing_subscriptions',
              readerPid,
            );
            heldPrefs = product.preferences(recipient, {
              in_app: false,
              email: true,
              sms: false,
              push: false,
            });
            await waitForLock('SELECT id FROM users', readerPid);
            await readHolder.query('COMMIT');
            assert.deepEqual(await heldRead, { ok: true });
            await heldDisable;
            await heldPrefs;
            assert.equal(
              (await product.notifications(recipient, {})).items.some(
                (row) => row.id === readId,
              ),
              false,
            );
            assert.equal(
              (await product.notifications(recipient, {})).items.some(
                (row) => row.id === olderMessage,
              ),
              true,
            );
          } finally {
            await readHolder.query('ROLLBACK');
            readHolder.release();
            if (heldRead) await heldRead;
            if (heldDisable) await heldDisable;
            if (heldPrefs) await heldPrefs;
          }
          await pool.query(
            'UPDATE notification_preferences SET in_app=true WHERE user_id=$1',
            [recipient.id],
          );
          const producerVersion = await configureSubscription();
          const producerHolder = await pool.connect();
          let afterProducer:
            ReturnType<ListingSubscriptions['disable']> | undefined;
          try {
            await producerHolder.query('BEGIN');
            await producerHolder.query(
              'UPDATE listings SET version=8012 WHERE id=$1',
              [listingId],
            );
            await enqueueImmediateListingNotifications(
              producerHolder,
              event(8012),
            );
            const pid = (
              await producerHolder.query('SELECT pg_backend_pid() AS pid')
            ).rows[0].pid;
            afterProducer = subscriptions.disable(recipient, listingId, {
              version: producerVersion,
            });
            await waitForLock('SELECT version FROM listing_subscriptions', pid);
            await producerHolder.query('COMMIT');
            await afterProducer;
            const producedId = (await inbox(8012))[0].id;
            assert.equal(
              (await product.notifications(recipient, {})).items.some(
                (row) => row.id === producedId,
              ),
              false,
            );
          } finally {
            await producerHolder.query('ROLLBACK');
            producerHolder.release();
            if (afterProducer) await afterProducer;
          }
          const disableVersion = await configureSubscription();
          await pool.query('UPDATE listings SET version=8013 WHERE id=$1', [
            listingId,
          ]);
          const disableHolder = await pool.connect();
          let beforeProducer:
            ReturnType<ListingSubscriptions['disable']> | undefined;
          let queuedProducer: Promise<number> | undefined;
          try {
            await disableHolder.query('BEGIN');
            await disableHolder.query(
              'SELECT 1 FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2 FOR UPDATE',
              [recipient.id, listingId],
            );
            const pid = (
              await disableHolder.query('SELECT pg_backend_pid() AS pid')
            ).rows[0].pid;
            beforeProducer = subscriptions.disable(recipient, listingId, {
              version: disableVersion,
            });
            await waitForLock('SELECT version FROM listing_subscriptions', pid);
            queuedProducer = db.transaction((sql) =>
              enqueueImmediateListingNotifications(sql, event(8013)),
            );
            await waitForLock('WITH eligible');
            await disableHolder.query('COMMIT');
            await beforeProducer;
            await queuedProducer;
            assert.equal((await inbox(8013)).length, 0);
            assert.equal((await email(8013)).length, 0);
          } finally {
            await disableHolder.query('ROLLBACK');
            disableHolder.release();
            if (beforeProducer) await beforeProducer;
            if (queuedProducer) await queuedProducer;
          }
          await configureSubscription();
          await pool.query('UPDATE listings SET version=8009 WHERE id=$1', [
            listingId,
          ]);
          // The old envelope now has a different subscription version; create a fresh event/version for the next barrier.
          await pool.query('UPDATE listings SET version=8014 WHERE id=$1', [
            listingId,
          ]);
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8014)),
          );
          // Existing private inbox rows must not deadlock a producer's user FK KEY SHARE.
          await db.transaction((sql) =>
            enqueueImmediateListingNotifications(sql, event(8009)),
          );
          const holder = await pool.connect();
          let reading: ReturnType<Product['notifications']> | undefined;
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT 1 FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2 FOR UPDATE',
              [recipient.id, listingId],
            );
            const pid = (await holder.query('SELECT pg_backend_pid() AS pid'))
              .rows[0].pid;
            reading = product.notifications(recipient, {});
            const deadline = performance.now() + 4000;
            let waited = false;
            while (performance.now() < deadline) {
              waited = (
                await pool.query(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position('FROM listing_subscriptions' in query)>0 AND $1=ANY(pg_blocking_pids(pid))) AS waited",
                  [pid],
                )
              ).rows[0].waited;
              if (waited) break;
              await new Promise<void>((done) => setImmediate(done));
            }
            assert.equal(waited, true);
            await enqueueImmediateListingNotifications(holder, {
              listingId,
              version: 8014,
              publicBefore: false,
              publicAfter: true,
              previousPrice: '',
              price: '99',
            });
            await holder.query('COMMIT');
            await reading;
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            if (reading) await reading;
          }
        } finally {
          await pool.query(
            'UPDATE listings SET status=$2,version=$3,price=$4,title=$5 WHERE id=$1',
            [
              listingId,
              originalListing.status,
              originalListing.version,
              originalListing.price,
              originalListing.title,
            ],
          );
          await pool.query(
            'UPDATE users SET active=$2,role=$3,email_verified_at=$4,phone_verified_at=$5 WHERE id=$1',
            [
              actors[0]!.id,
              originalSeller.active,
              originalSeller.role,
              originalSeller.email_verified_at,
              originalSeller.phone_verified_at,
            ],
          );
        }
      },
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
