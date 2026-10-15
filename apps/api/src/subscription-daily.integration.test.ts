import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import { ListingAccess } from './modules/listings/access';
import { Organizations } from './modules/organizations/organizations';
import { Product } from './modules/product/product';
import { Search } from './modules/search/search';
import { Actor } from './common/security';
import {
  dailyReleaseSlot,
  dailySubscriptionSettings,
  releaseDailyInbox,
} from './modules/product/subscription-daily';
import { listingSubscriptionConsentVersion } from './modules/product/subscription-contract';
import { enqueueImmediateListingNotifications } from './modules/product/subscription-outbox';

test('Daily in-app real PostgreSQL acceptance: immutable release, late commits and current consent', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const db = new Database();
  const access = new ListingAccess(db, {} as Organizations);
  const product = new Product(db, access, {} as Search);
  const original = {
    zone: process.env.LISTING_DAILY_TIMEZONE,
    hour: process.env.LISTING_DAILY_RELEASE_HOUR,
  };
  process.env.LISTING_DAILY_TIMEZONE = 'UTC';
  process.env.LISTING_DAILY_RELEASE_HOUR = '0';
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      if (!(await releaseDailyInbox(db, access))) return;
    }
    throw new Error('Daily queue did not drain');
  };
  async function fixture() {
    const user = randomUUID(),
      listing = randomUUID(),
      address = randomUUID(),
      property = randomUUID(),
      source = randomUUID();
    await db.pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture-only','Daily owner','owner',now(),now())",
      [user, user + '@example.test'],
    );
    await db.pool.query(
      "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Daily fixture','Москва',ST_SetSRID(ST_MakePoint(37.62,55.75),4326))",
      [address],
    );
    await db.pool.query(
      "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,'{}')",
      [property, user, address],
    );
    await db.pool.query(
      "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
      [source],
    );
    await db.pool.query(
      "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,price,title,status,published_at) VALUES($1,$2,$3,$4,'sale',99,'Daily public','published',now())",
      [listing, property, source, user],
    );
    await db.pool.query(
      "INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version) VALUES($1,$2,ARRAY['price_drop','availability'],ARRAY['in_app','email'],'daily',$3)",
      [user, listing, listingSubscriptionConsentVersion],
    );
    const payload = {
      listingId: listing,
      listingVersion: 1,
      subscriptionVersion: 1,
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10000,
        priceMinor: 9900,
      },
    };
    return { user, listing, payload, actor: { id: user } as Actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function candidate(
    f: Fixture,
    key: string = randomUUID(),
    count = 1,
    expires = '1 hour',
  ) {
    return db.rows<{ id: string }>(
      `INSERT INTO listing_daily_candidates(user_id,listing_id,subscription_version,listing_version,kind,dedupe_key,payload,created_at,expires_at)
      SELECT $1,$2,1,1,'subscription.listing.price_drop',$3||':'||g,$4::jsonb,clock_timestamp()-interval '26 hours',clock_timestamp()+$6::interval FROM generate_series(1,$5::integer) g RETURNING id::text`,
      [f.user, f.listing, key, JSON.stringify(f.payload), count, expires],
    );
  }
  try {
    const prior = await mkdtemp(join(tmpdir(), 'raui-daily-019-'));
    try {
      for (const name of (await readdir('migrations')).filter(
        (name) => /^\d+_.+\.sql$/.test(name) && name < '020_',
      ))
        await copyFile(join('migrations', name), join(prior, name));
      await migrate(db.pool, prior);
      const legacy = await fixture();
      await db.pool.query(
        "UPDATE listing_subscriptions SET frequency='immediate' WHERE user_id=$1",
        [legacy.user],
      );
      const [message] = await db.rows(
        `INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload) VALUES($1,'subscription.listing.price_drop',$2,1,1,'legacy-019',$3) RETURNING id::text,created_at,read_at,payload`,
        [legacy.user, legacy.listing, JSON.stringify(legacy.payload)],
      );
      const oldLedger = await db.rows(
        'SELECT * FROM schema_migrations ORDER BY name',
      );
      await migrate(db.pool);
      await migrate(db.pool);
      assert.equal(
        (await db.rows('SELECT * FROM schema_migrations')).length,
        21,
      );
      assert.deepEqual(
        (await db.rows('SELECT * FROM schema_migrations ORDER BY name')).slice(
          0,
          19,
        ),
        oldLedger,
      );
      const [preserved] = await db.rows(
        'SELECT id::text,created_at,read_at,payload,captured_frequency,daily_run_id FROM notifications WHERE id=$1',
        [message!.id],
      );
      assert.equal(
        (await product.notifications(legacy.actor, {})).items.length,
        1,
      );
      assert.deepEqual(preserved, {
        ...message,
        captured_frequency: null,
        daily_run_id: null,
      });
    } finally {
      await rm(prior, { recursive: true, force: true });
    }
    await t.test(
      'partial manifest is hidden, resumes after restart and releases once without a subscription quota',
      async () => {
        process.env.LISTING_DAILY_TIMEZONE = 'Pacific/Honolulu';
        const f = await fixture();
        await candidate(f, 'batch', 101);
        assert.equal(await releaseDailyInbox(db, access), true);
        const hidden = await product.notifications(f.actor, { limit: 1 });
        assert.equal(hidden.items.length, 0);
        assert.ok(hidden.cursor);
        assert.equal(
          (
            await db.rows(
              'SELECT released_at FROM listing_daily_runs WHERE user_id=$1',
              [f.user],
            )
          )[0]!.released_at,
          null,
        );
        const [opened] = await db.rows(
          'SELECT id,cutoff,release_day FROM listing_daily_runs WHERE user_id=$1',
          [f.user],
        );
        process.env.LISTING_DAILY_TIMEZONE = 'Pacific/Kiritimati';
        // Restart beyond the next local release day must finish the original OPEN run.
        await drain();
        assert.deepEqual(
          (
            await db.rows(
              'SELECT id,cutoff,release_day FROM listing_daily_runs WHERE user_id=$1',
              [f.user],
            )
          )[0],
          opened,
        );
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          101,
        );
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          20,
        );
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM listing_daily_runs WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          1,
        );
        await drain();
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          101,
        );
        await assert.rejects(
          db.pool.query(
            'UPDATE listing_daily_candidates SET payload=payload WHERE user_id=$1',
            [f.user],
          ),
          /immutable|history/i,
        );
        await assert.rejects(
          db.pool.query(
            'UPDATE listing_daily_items SET outcome=outcome WHERE user_id=$1',
            [f.user],
          ),
          /immutable|history/i,
        );
        await assert.rejects(
          db.pool.query(
            'UPDATE listing_daily_runs SET cutoff=cutoff WHERE user_id=$1',
            [f.user],
          ),
          /immutable/i,
        );
        const [extra] = await candidate(f, 'closed-extra');
        const [run] = await db.rows(
          'SELECT id FROM listing_daily_runs WHERE user_id=$1',
          [f.user],
        );
        await assert.rejects(
          db.pool.query(
            "INSERT INTO listing_daily_items(run_id,user_id,candidate_id,outcome) VALUES($1,$2,$3,'skipped')",
            [run!.id, f.user, extra!.id],
          ),
          /closed/,
        );
        process.env.LISTING_DAILY_TIMEZONE = 'UTC';
      },
    );
    await t.test(
      'candidate committed after released run is not lost behind an ID high water',
      async () => {
        // Two operational timezone configurations yield adjacent local release days for the same due instant.
        process.env.LISTING_DAILY_TIMEZONE = 'Pacific/Honolulu';
        const f = await fixture();
        const held = await db.pool.connect();
        try {
          await held.query('BEGIN');
          const inserted = await held.query(
            `INSERT INTO listing_daily_candidates(user_id,listing_id,subscription_version,listing_version,kind,dedupe_key,payload,created_at,expires_at) VALUES($1,$2,1,1,'subscription.listing.price_drop','late-low-id',$3,clock_timestamp()-interval '26 hours',clock_timestamp()+interval '1 hour') RETURNING id`,
            [f.user, f.listing, JSON.stringify(f.payload)],
          );
          await candidate(f, 'committed-higher-id');
          await drain();
          const first = (
            await db.rows(
              'SELECT id,release_day FROM listing_daily_runs WHERE user_id=$1',
              [f.user],
            )
          )[0];
          await held.query('COMMIT');
          await drain();
          assert.equal(
            (
              await db.rows(
                'SELECT count(*)::int AS n FROM listing_daily_items WHERE candidate_id=$1',
                [inserted.rows[0].id],
              )
            )[0]!.n,
            0,
          );
          process.env.LISTING_DAILY_TIMEZONE = 'Pacific/Kiritimati';
          await drain();
          const assigned = (
            await db.rows(
              'SELECT r.release_day FROM listing_daily_items i JOIN listing_daily_runs r ON r.id=i.run_id WHERE i.candidate_id=$1',
              [inserted.rows[0].id],
            )
          )[0];
          assert.ok(assigned);
          assert.notEqual(
            String(assigned.release_day),
            String(first!.release_day),
          );
        } finally {
          await held.query('ROLLBACK');
          held.release();
          process.env.LISTING_DAILY_TIMEZONE = 'UTC';
        }
      },
    );
    await t.test(
      'concurrent coordinators serialize recipient and produce exactly one released manifest',
      async () => {
        const f = await fixture();
        await candidate(f);
        await Promise.all([
          releaseDailyInbox(db, access),
          releaseDailyInbox(db, access),
        ]);
        await drain();
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM listing_daily_runs WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          1,
        );
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          1,
        );
        await db.pool.query(
          'UPDATE notification_preferences SET in_app=false WHERE user_id=$1',
          [f.user],
        );
        // Missing preference row defaults true; use explicit upsert for an actual opt-out.
        await db.pool.query(
          'INSERT INTO notification_preferences(user_id,in_app) VALUES($1,false) ON CONFLICT(user_id) DO UPDATE SET in_app=false',
          [f.user],
        );
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          0,
        );
        const [n] = await db.rows(
          'SELECT id::text FROM notifications WHERE user_id=$1',
          [f.user],
        );
        await assert.rejects(product.read(f.actor, n!.id));
        assert.equal(
          (
            await db.rows('SELECT read_at FROM notifications WHERE id=$1', [
              n!.id,
            ])
          )[0]!.read_at,
          null,
        );
      },
    );
    for (const condition of [
      'disabled',
      'version',
      'frequency',
      'channel',
      'event',
      'global',
      'inactive',
      'expired',
    ] as const)
      await t.test(
        'daily candidate suppressed before release: ' + condition,
        async () => {
          const f = await fixture();
          await candidate(
            f,
            condition,
            1,
            condition === 'expired' ? '-1 second' : '1 hour',
          );
          if (condition === 'disabled')
            await db.pool.query(
              'UPDATE listing_subscriptions SET disabled_at=now() WHERE user_id=$1',
              [f.user],
            );
          if (condition === 'version')
            await db.pool.query(
              'UPDATE listing_subscriptions SET version=2 WHERE user_id=$1',
              [f.user],
            );
          if (condition === 'frequency')
            await db.pool.query(
              "UPDATE listing_subscriptions SET frequency='immediate' WHERE user_id=$1",
              [f.user],
            );
          if (condition === 'channel')
            await db.pool.query(
              "UPDATE listing_subscriptions SET channels=ARRAY['email'] WHERE user_id=$1",
              [f.user],
            );
          if (condition === 'event')
            await db.pool.query(
              "UPDATE listing_subscriptions SET events=ARRAY['availability'] WHERE user_id=$1",
              [f.user],
            );
          if (condition === 'global')
            await db.pool.query(
              'INSERT INTO notification_preferences(user_id,in_app) VALUES($1,false)',
              [f.user],
            );
          if (condition === 'inactive')
            await db.pool.query('UPDATE users SET active=false WHERE id=$1', [
              f.user,
            ]);
          await drain();
          assert.equal(
            (await product.notifications(f.actor, {})).items.length,
            0,
          );
          assert.equal(
            (
              await db.rows(
                "SELECT count(*)::int AS n FROM listing_daily_items WHERE user_id=$1 AND outcome='skipped'",
                [f.user],
              )
            )[0]!.n,
            1,
          );
        },
      );
    await t.test(
      'global preference committed during user-lock wait wins over daily release',
      async () => {
        await drain();
        const f = await fixture();
        await candidate(f);
        const held = await db.pool.connect();
        let release: Promise<boolean> | undefined;
        try {
          await held.query('BEGIN');
          const pid = (await held.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          await held.query(
            'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
            [f.user],
          );
          release = releaseDailyInbox(db, access);
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const rows = await db.rows<{ n: number }>(
              'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
              [pid],
            );
            if (rows[0]!.n > 0) {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(
            blocked,
            true,
            'coordinator reached the real recipient lock',
          );
          await held.query(
            'INSERT INTO notification_preferences(user_id,in_app) VALUES($1,false)',
            [f.user],
          );
          await held.query('COMMIT');
          await release;
          assert.equal(
            (await product.notifications(f.actor, {})).items.length,
            0,
          );
          assert.equal(
            (
              await db.rows(
                'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',
                [f.user],
              )
            )[0]!.n,
            0,
          );
        } finally {
          await held.query('ROLLBACK');
          held.release();
          await release;
        }
      },
    );
    await t.test(
      'expiry after visibility wait is checked at final insertion, not cached candidate selection',
      async () => {
        const f = await fixture();
        await candidate(f, 'expire-during-visibility', 1, '2 seconds');
        let waited = false;
        const delayed = {
          visible: async (
            id: string,
            sql: Parameters<ListingAccess['visible']>[1],
          ) => {
            if (id === f.listing) {
              await db.pool.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision+0.02) FROM listing_daily_candidates WHERE user_id=$1',
                [f.user],
              );
              waited = true;
            }
            return access.visible(id, sql);
          },
          currentVisibility: access.currentVisibility.bind(access),
        } as ListingAccess;
        await releaseDailyInbox(db, delayed);
        await drain();
        assert.equal(waited, true);
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          0,
        );
      },
    );
    await t.test(
      'cross-user run links and counterfeit same-user manifests fail closed',
      async () => {
        const f = await fixture(),
          other = await fixture();
        await candidate(f);
        await drain();
        const [n] = await db.rows(
          'SELECT * FROM notifications WHERE user_id=$1',
          [f.user],
        );
        await assert.rejects(
          db.pool.query(
            "INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload,captured_frequency,daily_run_id) VALUES($1,$2,$3,1,1,'cross-user',$4,'daily',$5)",
            [
              other.user,
              n!.kind,
              f.listing,
              JSON.stringify(f.payload),
              n!.daily_run_id,
            ],
          ),
          /foreign key/,
        );
        await assert.rejects(
          db.pool.query(
            "INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload,daily_run_id) VALUES($1,$2,$3,1,1,'null-frequency',$4,$5)",
            [
              f.user,
              n!.kind,
              f.listing,
              JSON.stringify(f.payload),
              n!.daily_run_id,
            ],
          ),
          /frequency_shape/,
        );
        await db.pool.query(
          "INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload,captured_frequency,daily_run_id) VALUES($1,$2,$3,1,1,'no-manifest',$4,'daily',$5)",
          [
            f.user,
            n!.kind,
            f.listing,
            JSON.stringify(f.payload),
            n!.daily_run_id,
          ],
        );
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          1,
        );
        await db.pool.query(
          "UPDATE notifications SET payload=jsonb_set(payload,'{event,priceMinor}','9800') WHERE id=$1",
          [n!.id],
        );
        assert.equal(
          (await product.notifications(f.actor, {})).items.length,
          0,
        );
      },
    );
    await t.test(
      'canonical lifecycle producer persists daily candidates, never per-item daily email',
      async () => {
        const f = await fixture();
        await db.transaction((sql) =>
          enqueueImmediateListingNotifications(sql, {
            listingId: f.listing,
            version: 1,
            publicBefore: true,
            publicAfter: true,
            previousPrice: '100',
            price: '99',
          }),
        );
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM listing_daily_candidates WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          1,
        );
        assert.equal(
          (
            await db.rows(
              'SELECT count(*)::int AS n FROM notification_deliveries WHERE user_id=$1',
              [f.user],
            )
          )[0]!.n,
          0,
        );
        const now = new Date();
        const day = dailyReleaseSlot(now, dailySubscriptionSettings());
        assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      },
    );
    await t.test(
      'v2 availability bytes survive daily manifest release and gated read',
      async () => {
        const f = await fixture();
        await db.transaction(async (sql) => {
          await sql.query("UPDATE listings SET status='paused' WHERE id=$1", [
            f.listing,
          ]);
          await enqueueImmediateListingNotifications(sql, {
            listingId: f.listing,
            version: 1,
            publicBefore: true,
            publicAfter: false,
            previousPrice: '99',
            price: '99',
          });
        });
        const [captured] = await db.rows<{
          dedupe_key: string;
          payload: Record<string, unknown>;
        }>(
          "SELECT dedupe_key,payload FROM listing_daily_candidates WHERE user_id=$1 AND kind='subscription.listing.availability'",
          [f.user],
        );
        assert.equal(captured!.payload.schemaVersion, 2);
        assert.deepEqual(captured!.payload.event, {
          kind: 'availability',
          available: false,
        });
        assert.notEqual(
          (
            captured!.payload.visibilityToken as {
              seller: { generation: string };
            }
          ).seller.generation,
          '0',
        );
        const agedKey = captured!.dedupe_key + ':aged';
        await db.pool.query(
          `INSERT INTO listing_daily_candidates(user_id,listing_id,subscription_version,listing_version,kind,dedupe_key,payload,created_at,expires_at)
           VALUES($1,$2,1,1,'subscription.listing.availability',$3,$4::jsonb,clock_timestamp()-interval '26 hours',clock_timestamp()+interval '1 hour')`,
          [f.user, f.listing, agedKey, JSON.stringify(captured!.payload)],
        );
        await drain();
        const [released] = await db.rows<{
          id: string;
          payload: Record<string, unknown>;
          candidate_payload: Record<string, unknown>;
        }>(
          `SELECT n.id::text,n.payload,c.payload AS candidate_payload
           FROM listing_daily_items i
           JOIN listing_daily_candidates c ON c.id=i.candidate_id
           JOIN notifications n ON n.id=i.notification_id
           WHERE c.user_id=$1 AND c.dedupe_key=$2 AND i.outcome='released'`,
          [f.user, agedKey],
        );
        assert.deepEqual(released!.payload, captured!.payload);
        assert.deepEqual(released!.candidate_payload, captured!.payload);
        const inbox = await product.notifications(f.actor, {});
        assert.ok(inbox.items.some((item) => item.id === released!.id));
        assert.deepEqual(await product.read(f.actor, released!.id), {
          ok: true,
        });
      },
    );
  } finally {
    for (const [name, value] of [
      ['LISTING_DAILY_TIMEZONE', original.zone],
      ['LISTING_DAILY_RELEASE_HOUR', original.hour],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db.onModuleDestroy();
  }
});
