import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from './modules/database/migrate';
import {
  ListingAccess,
  readListingVisibility,
} from './modules/listings/access';
import { Organizations } from './modules/organizations/organizations';
import { eligibleListingSubscriptionEvent } from './modules/product/subscription-eligibility';

test('Visibility revisions real PostgreSQL acceptance: seed, writers, rollback and no ABA', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const prior = await mkdtemp(join(tmpdir(), 'raui-visibility-020-'));
  const seller = randomUUID();
  const organization = randomUUID();
  const directListing = randomUUID();
  const organizationListing = randomUUID();
  async function generation(kind: string, identity: string) {
    return (
      await pool.query<{ generation: string }>(
        'SELECT generation::text AS generation FROM subscription_visibility_generations WHERE kind=$1 AND identity=$2',
        [kind, identity],
      )
    ).rows[0]?.generation;
  }
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 4_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, 'timed out waiting for PostgreSQL lock');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    for (const name of (await readdir('migrations')).filter(
      (name) => /^\d+_.+\.sql$/.test(name) && name < '021_',
    ))
      await copyFile(join('migrations', name), join(prior, name));
    await migrate(pool, prior);

    const address = randomUUID();
    const directProperty = randomUUID();
    const organizationProperty = randomUUID();
    const directSource = randomUUID();
    const organizationSource = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture-only','Visibility owner','owner',now(),now())",
      [seller, seller + '@example.test'],
    );
    await pool.query(
      "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Visibility agency','agency',$2)",
      [organization, seller],
    );
    await pool.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [organization, seller],
    );
    await pool.query(
      "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Visibility fixture','Москва',ST_SetSRID(ST_MakePoint(37.62,55.75),4326))",
      [address],
    );
    await pool.query(
      "INSERT INTO properties(id,created_by,organization_id,category_code,address_id,attributes) VALUES($1,$3,NULL,'apartment',$2,'{}'),($4,$3,$5,'apartment',$2,'{}')",
      [directProperty, address, seller, organizationProperty, organization],
    );
    await pool.query(
      "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
      [directSource],
    );
    await pool.query(
      "INSERT INTO listing_sources(id,kind,organization_id) VALUES($1,'agency',$2)",
      [organizationSource, organization],
    );
    await pool.query(
      "INSERT INTO listings(id,property_id,source_id,seller_id,organization_id,deal_type,price,title,status,published_at) VALUES($1,$2,$3,$4,NULL,'sale',100,'Direct visibility','published',now()),($5,$6,$7,$4,$8,'sale',100,'Organization visibility','published',now())",
      [
        directListing,
        directProperty,
        directSource,
        seller,
        organizationListing,
        organizationProperty,
        organizationSource,
        organization,
      ],
    );

    const blocker = await pool.connect();
    const postMigrationSeller = randomUUID();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE organizations IN ROW EXCLUSIVE MODE');
      const migration = migrate(pool);
      await waitFor(async () =>
        Boolean(
          (
            await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
              SELECT 1 FROM pg_locks users_lock
              JOIN pg_class users_table ON users_table.oid=users_lock.relation
              JOIN pg_locks organizations_lock ON organizations_lock.pid=users_lock.pid
              JOIN pg_class organizations_table ON organizations_table.oid=organizations_lock.relation
              WHERE users_table.relname='users'
                AND users_lock.mode='ShareRowExclusiveLock' AND users_lock.granted
                AND organizations_table.relname='organizations'
                AND organizations_lock.mode='ShareRowExclusiveLock' AND NOT organizations_lock.granted
            ) AS waiting`)
          ).rows[0]?.waiting,
        ),
      );
      const writer = await pool.connect();
      try {
        const writerPid = (
          await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid;
        const insert = writer.query(
          "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture-only','Post migration owner','owner',now(),now())",
          [postMigrationSeller, postMigrationSeller + '@example.test'],
        );
        await waitFor(async () =>
          Boolean(
            (
              await pool.query<{ waiting: boolean }>(
                "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
                [writerPid],
              )
            ).rows[0]?.waiting,
          ),
        );
        await blocker.query('ROLLBACK');
        await migration;
        await insert;
      } finally {
        writer.release();
      }
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } finally {
        blocker.release();
      }
    }
    await migrate(pool);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM schema_migrations'))
        .rows[0].n,
      21,
    );
    assert.equal(await generation('seller', seller), '0');
    assert.ok(BigInt((await generation('seller', postMigrationSeller))!) > 0n);
    assert.equal(await generation('organization', organization), '0');
    assert.equal(
      await generation('membership', organization + ':' + seller),
      '0',
    );

    await t.test(
      'atomic snapshots contain only matching exact dependency tokens',
      async () => {
        assert.deepEqual(await readListingVisibility(pool, directListing), {
          version: 1,
          visible: true,
          visibilityToken: {
            seller: { id: seller, generation: '0' },
            organization: null,
            membership: null,
          },
        });
        assert.deepEqual(
          await readListingVisibility(pool, organizationListing),
          {
            version: 1,
            visible: true,
            visibilityToken: {
              seller: { id: seller, generation: '0' },
              organization: { id: organization, generation: '0' },
              membership: {
                organizationId: organization,
                userId: seller,
                generation: '0',
              },
            },
          },
        );
        const access = new ListingAccess(
          { pool } as never,
          {} as Organizations,
        );
        const legacy = {
          listingId: directListing,
          listingVersion: 1,
          subscriptionVersion: 1,
          event: { kind: 'availability' as const, available: true },
        };
        assert.deepEqual(
          await eligibleListingSubscriptionEvent(
            access,
            'subscription.listing.availability',
            legacy,
            pool,
          ),
          legacy,
        );
      },
    );

    await t.test(
      'irrelevant and equivalent writes preserve generations',
      async () => {
        await pool.query(
          "UPDATE users SET display_name='Renamed',email_verified_at=clock_timestamp() WHERE id=$1",
          [seller],
        );
        await pool.query(
          "UPDATE memberships SET role='admin',active=true WHERE organization_id=$1 AND user_id=$2",
          [organization, seller],
        );
        await pool.query(
          'UPDATE organizations SET name=$2,active=true WHERE id=$1',
          [organization, 'Renamed agency'],
        );
        assert.equal(await generation('seller', seller), '0');
        assert.equal(await generation('organization', organization), '0');
        assert.equal(
          await generation('membership', organization + ':' + seller),
          '0',
        );
      },
    );

    await t.test(
      'relevant source changes advance atomically and rollback together',
      async () => {
        const transaction = await pool.connect();
        try {
          await transaction.query('BEGIN');
          await transaction.query('UPDATE users SET active=false WHERE id=$1', [
            seller,
          ]);
          const rolledBack = (
            await transaction.query<{ generation: string }>(
              "SELECT generation::text AS generation FROM subscription_visibility_generations WHERE kind='seller' AND identity=$1",
              [seller],
            )
          ).rows[0]?.generation;
          assert.notEqual(rolledBack, '0');
          await transaction.query('ROLLBACK');
        } finally {
          transaction.release();
        }
        assert.equal(await generation('seller', seller), '0');

        await pool.query(
          'UPDATE users SET email_verified_at=NULL WHERE id=$1',
          [seller],
        );
        const hidden = await generation('seller', seller);
        assert.ok(BigInt(hidden!) > 0n);
        assert.equal(
          (await readListingVisibility(pool, directListing))!.visible,
          false,
        );
        await pool.query(
          'UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1',
          [seller],
        );
        assert.ok(
          BigInt((await generation('seller', seller))!) > BigInt(hidden!),
        );

        await pool.query('UPDATE organizations SET active=false WHERE id=$1', [
          organization,
        ]);
        const inactiveOrganization = await generation(
          'organization',
          organization,
        );
        assert.ok(BigInt(inactiveOrganization!) > 0n);
        assert.equal(
          (await readListingVisibility(pool, organizationListing))!.visible,
          false,
        );
        await pool.query('UPDATE organizations SET active=true WHERE id=$1', [
          organization,
        ]);
      },
    );

    await t.test(
      'membership delete and recreation advances the retained tombstone',
      async () => {
        const identity = organization + ':' + seller;
        await pool.query(
          'DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2',
          [organization, seller],
        );
        const deleted = await generation('membership', identity);
        assert.ok(BigInt(deleted!) > 0n);
        const deletedSnapshot = (await readListingVisibility(
          pool,
          organizationListing,
        ))!;
        assert.equal(deletedSnapshot.visible, false);
        assert.deepEqual(deletedSnapshot.visibilityToken?.membership, {
          organizationId: organization,
          userId: seller,
          generation: deleted,
        });
        await pool.query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
          [organization, seller],
        );
        const recreated = await generation('membership', identity);
        assert.ok(BigInt(recreated!) > BigInt(deleted!));
        await assert.rejects(
          pool.query(
            "DELETE FROM subscription_visibility_generations WHERE kind='membership' AND identity=$1",
            [identity],
          ),
          /cannot be deleted/i,
        );
        await assert.rejects(
          pool.query(
            "UPDATE subscription_visibility_generations SET generation=0 WHERE kind='membership' AND identity=$1",
            [identity],
          ),
          /must increase/i,
        );
      },
    );

    await t.test(
      'legacy zero is one-way and old v2 never revives at the same listing version',
      async () => {
        const access = new ListingAccess(
          { pool } as never,
          {} as Organizations,
        );
        const legacy = {
          listingId: directListing,
          listingVersion: 1,
          subscriptionVersion: 1,
          event: { kind: 'availability' as const, available: true },
        };
        await pool.query('UPDATE users SET active=false WHERE id=$1', [seller]);
        const unavailable = (await readListingVisibility(pool, directListing))!;
        const oldV2 = {
          ...legacy,
          schemaVersion: 2 as const,
          visibilityToken: unavailable.visibilityToken!,
          event: { kind: 'availability' as const, available: false },
        };
        await pool.query('UPDATE users SET active=true WHERE id=$1', [seller]);
        await pool.query('UPDATE users SET active=false WHERE id=$1', [seller]);
        assert.equal(
          await eligibleListingSubscriptionEvent(
            access,
            'subscription.listing.availability',
            oldV2,
            pool,
          ),
          null,
        );
        await pool.query('UPDATE users SET active=true WHERE id=$1', [seller]);
        assert.equal(
          await eligibleListingSubscriptionEvent(
            access,
            'subscription.listing.availability',
            legacy,
            pool,
          ),
          null,
        );
      },
    );
  } finally {
    await pool.query('ROLLBACK').catch(() => undefined);
    await pool.end();
    await rm(prior, { recursive: true, force: true });
  }
});
