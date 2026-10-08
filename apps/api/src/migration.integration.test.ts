import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate } from './modules/database/migrate';
const baseline = 'ff0094589a2835304ff994053e69daca276bb3ed';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
test('Populated current-master upgrade preserves facts, ledger, PostGIS and sequence identity', async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const directory = resolve(
      process.env.LOCAL_PRIVATE_DIR!,
      'master-migrations',
    );
    await mkdir(directory, { recursive: true });
    const names = (await readdir('migrations'))
      .filter((name) => /^00[1-9]_|^01[01]_/.test(name))
      .sort();
    assert.equal(names.length, 11);
    for (const name of names) {
      const original = execFileSync('git', [
        'show',
        `${baseline}:apps/api/migrations/${name}`,
      ]);
      assert.deepEqual(
        await readFile('migrations/' + name),
        original,
        `Immutable baseline ${name}`,
      );
      await writeFile(resolve(directory, name), original);
    }
    await migrate(pool, directory);
    const user = randomUUID(),
      address = randomUUID(),
      property = randomUUID(),
      source = randomUUID(),
      listing = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,'upgrade@example.test','fixture-only','RC upgrade','owner',now(),now())",
      [user],
    );
    await pool.query(
      "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'RC fixture','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
      [address],
    );
    await pool.query(
      "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,'{\"area\":50}')",
      [property, user, address],
    );
    await pool.query(
      "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
      [source],
    );
    await pool.query(
      "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,price,title,status,published_at) VALUES($1,$2,$3,$4,'sale',10000000,'RC upgrade','published',now())",
      [listing, property, source, user],
    );
    await pool.query(
      "INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'rc.fixture','listing',$2)",
      [user, listing],
    );
    await pool.query(
      'INSERT INTO ai_budget_days(day,reserved_micros,spent_micros,uncertain_micros) VALUES(CURRENT_DATE,13,17,19)',
    );
    await pool.query(
      "INSERT INTO ai_usage(capability,mode,reason,attempts,latency_ms,cost_micros,input_tokens,output_tokens,prompt_version,model_version,rule_version,cost_basis,unknown_cost_attempts,uncertain_micros) VALUES('search','ai','fixture',1,1,17,2,3,'fixture','fixture','fixture','reported_only',1,19)",
    );
    await pool.query(
      "UPDATE search_jobs SET updated_at=now()-interval '10 minutes' WHERE listing_id=$1",
      [listing],
    );
    await pool.query(
      'INSERT INTO listing_history(listing_id,actor_id,event,after_data) VALUES($1,$2,\'created\',\'{"fixture":"upgrade"}\')',
      [listing, user],
    );
    await pool.query(
      'INSERT INTO notification_preferences(user_id,in_app,email,sms,push,transactional) VALUES($1,false,true,false,true,false)',
      [user],
    );
    const snapshot = async () => {
      const tables = (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','staff_permission_grants','registration_approval_requests','phone_otp_challenges','phone_otp_send_events') ORDER BY tablename",
        )
      ).rows;
      const facts = [];
      for (const { tablename } of tables) {
        const data =
          tablename === 'search_jobs'
            ? "to_jsonb(t)-'enqueued_at'"
            : tablename === 'addresses'
              ? "to_jsonb(t)-'region_code'"
              : tablename === 'users'
                ? "to_jsonb(t)-'public_id'-'registration_approval_state'"
                : 'to_jsonb(t)';
        const rows = (
          await pool.query(
            `SELECT ${data} AS data FROM public.${quote(tablename)} t ORDER BY (${data})::text`,
          )
        ).rows;
        facts.push({
          table: tablename,
          count: rows.length,
          hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        });
      }
      const sequences = [];
      for (const config of (
        await pool.query(
          "SELECT sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' AND sequencename<>'users_public_id_seq' ORDER BY sequencename",
        )
      ).rows) {
        const state = (
          await pool.query(
            `SELECT last_value::text,is_called FROM public.${quote(config.sequencename)}`,
          )
        ).rows[0];
        sequences.push({ ...config, ...state });
      }
      return {
        facts,
        sequences,
        geometry: (
          await pool.query(
            "SELECT encode(ST_AsEWKB(point),'hex') AS ewkb,ST_SRID(point) AS srid,PostGIS_Version() AS version FROM addresses ORDER BY id",
          )
        ).rows,
      };
    };
    const before = await snapshot();
    const ledger = (
      await pool.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows;
    await migrate(pool);
    const upgradedLedger = (
      await pool.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows;
    assert.equal(upgradedLedger.length, 17);
    for (const [index, name] of [
      [13, '014_user_public_id.sql'],
      [14, '015_staff_permissions.sql'],
      [15, '016_registration_approval.sql'],
      [16, '017_phone_otp.sql'],
    ] as const) {
      assert.equal(upgradedLedger[index].name, name);
      assert.equal(
        upgradedLedger[index].checksum,
        createHash('sha256')
          .update(await readFile('migrations/' + name))
          .digest('hex'),
      );
    }
    for (const table of ['phone_otp_challenges', 'phone_otp_send_events']) {
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM ${quote(table)}`))
          .rows[0].count,
        0,
        `Additive OTP table ${table} starts empty`,
      );
    }
    const identity = (
      await pool.query('SELECT public_id::text FROM users WHERE id=$1', [user])
    ).rows[0];
    assert.match(identity.public_id, /^[1-9][0-9]*$/);
    assert.equal(
      (
        await pool.query(
          'SELECT registration_approval_state FROM users WHERE id=$1',
          [user],
        )
      ).rows[0].registration_approval_state,
      'approved',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM registration_approval_requests',
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      pool.query(
        'UPDATE users SET registration_approval_state=$2 WHERE id=$1',
        [user, 'invalid'],
      ),
      /registration_approval_state_check/,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM staff_permission_grants',
        )
      ).rows[0].count,
      0,
    );
    assert.equal(upgradedLedger[12].name, '013_region_search.sql');
    assert.equal(
      upgradedLedger[12].checksum,
      createHash('sha256')
        .update(await readFile('migrations/013_region_search.sql'))
        .digest('hex'),
    );
    assert.equal(upgradedLedger[11].name, '012_search_queue_observability.sql');
    assert.equal(
      upgradedLedger[11].checksum,
      createHash('sha256')
        .update(await readFile('migrations/012_search_queue_observability.sql'))
        .digest('hex'),
    );
    await migrate(pool);
    assert.deepEqual(
      (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      upgradedLedger,
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (
        await pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows.slice(0, 11),
      ledger,
    );
    const legacyRegion = (
      await pool.query('SELECT region_code FROM addresses WHERE id=$1', [
        address,
      ])
    ).rows[0];
    assert.equal(legacyRegion.region_code, null);
    assert.equal(
      (
        await pool.query(
          'SELECT region_code FROM public_search_listings WHERE id=$1',
          [listing],
        )
      ).rows[0].region_code,
      null,
    );
    const queue = (
      await pool.query(
        'SELECT enqueued_at=updated_at AS preserved FROM search_jobs WHERE listing_id=$1',
        [listing],
      )
    ).rows[0];
    assert.equal(queue.preserved, true);
    const revisionBefore = (
      await pool.query(
        'SELECT revision::text FROM search_jobs WHERE listing_id=$1',
        [listing],
      )
    ).rows[0].revision;
    await pool.query('UPDATE addresses SET region_code=$2 WHERE id=$1', [
      address,
      'moscow',
    ]);
    assert.equal(
      (
        await pool.query(
          'SELECT region_code FROM public_search_listings WHERE id=$1',
          [listing],
        )
      ).rows[0].region_code,
      'moscow',
    );
    const revisionAfter = (
      await pool.query(
        'SELECT revision::text FROM search_jobs WHERE listing_id=$1',
        [listing],
      )
    ).rows[0].revision;
    assert.ok(BigInt(revisionAfter) > BigInt(revisionBefore));
    await assert.rejects(
      pool.query('UPDATE addresses SET region_code=$2 WHERE id=$1', [
        address,
        '../moscow',
      ]),
    );
    await assert.rejects(pool.query('UPDATE audit_events SET action=action'));
    await assert.rejects(pool.query('DELETE FROM audit_events'));
    await assert.rejects(
      pool.query('UPDATE listing_history SET event=event'),
      /History is append-only/,
    );
    await assert.rejects(
      pool.query('DELETE FROM listing_history'),
      /History is append-only/,
    );
    const next = (
      await pool.query(
        "INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'rc.after-upgrade','listing',$2) RETURNING id",
        [user, listing],
      )
    ).rows[0];
    assert.ok(BigInt(next.id) > 1n);
  } finally {
    await pool.end();
  }
});
