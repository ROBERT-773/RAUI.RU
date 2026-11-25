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
      "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone,phone_verified_at) VALUES($1,'upgrade@example.test','fixture-only','RC upgrade','owner',now(),'+70000000001',now())",
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
    const thread = randomUUID();
    await pool.query(
      'INSERT INTO inquiry_threads(id,listing_id,buyer_id,seller_id) VALUES($1,$2,$3,$3)',
      [thread, listing, user],
    );
    const oldMessages = (
      await pool.query(
        "INSERT INTO notifications(user_id,thread_id,kind,read_at) VALUES($1,$2,'message',NULL),($1,$2,'message',now()) RETURNING id::text,read_at",
        [user, thread],
      )
    ).rows;
    const snapshot = async () => {
      const tables = (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('attribute_definitions','schema_migrations','staff_permission_grants','registration_approval_requests','phone_otp_challenges','phone_otp_send_events','phone_sign_in_challenges','listing_subscriptions','listing_daily_candidates','listing_daily_runs','listing_daily_items','subscription_visibility_generations','public_professional_profiles','public_professional_regions','staff_totp_factors','professional_photo_cleanup','listing_form_drafts','seller_contact_phones','seller_contact_phone_challenges','listing_contact_phones','portal_feedback') ORDER BY tablename",
        )
      ).rows;
      const legacyRows: Record<string, string> = {
        search_jobs: "to_jsonb(t)-'enqueued_at'",
        addresses: "to_jsonb(t)-'region_code'",
        listing_sources: "to_jsonb(t)-'personal_feed_owner_id'",
        users:
          "to_jsonb(t)-'public_id'-'registration_approval_state'-'phone_sign_in_enrolled_at'-'contact_mode'",
        notifications:
          "to_jsonb(t)-'listing_id'-'subscription_version'-'listing_version'-'dedupe_key'-'payload'-'captured_frequency'-'daily_run_id'",
        sessions: "to_jsonb(t)-'staff_totp_factor_id'-'staff_assured_until'",
      };
      const facts = [];
      for (const { tablename } of tables) {
        const data = legacyRows[tablename] ?? 'to_jsonb(t)';
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
          "SELECT sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' AND sequencename NOT IN ('users_public_id_seq','listing_daily_candidates_id_seq','subscription_visibility_generation_seq') ORDER BY sequencename",
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
    const attributes = async () =>
      (
        await pool.query<{
          category_code: string;
          code: string;
          name: string;
          required: boolean;
        }>('SELECT * FROM attribute_definitions ORDER BY category_code, code')
      ).rows;
    const baselineAttributes = await attributes();
    const before = await snapshot();
    const ledger = (
      await pool.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows;
    await migrate(pool);
    const upgradedLedger = (
      await pool.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows;
    assert.equal(upgradedLedger.length, 42);
    for (const [index, name] of [
      [13, '014_user_public_id.sql'],
      [14, '015_staff_permissions.sql'],
      [15, '016_registration_approval.sql'],
      [16, '017_phone_otp.sql'],
      [17, '018_listing_subscriptions.sql'],
      [18, '019_listing_subscription_inbox.sql'],
      [19, '020_listing_subscription_daily.sql'],
      [20, '021_subscription_visibility_revisions.sql'],
      [21, '022_legacy_housing_filters.sql'],
      [22, '023_rental_search_terms.sql'],
      [23, '024_commercial_property_type.sql'],
      [24, '025_commercial_search_attributes.sql'],
      [25, '026_rental_utilities_search.sql'],
      [26, '027_short_rental_guest_capacity.sql'],
      [27, '028_short_rental_availability.sql'],
      [28, '029_public_professional_profiles.sql'],
      [29, '030_required_kitchen_area.sql'],
      [30, '031_countryside_listing_fields.sql'],
      [31, '032_required_commercial_type.sql'],
      [32, '033_commercial_automatic_gates.sql'],
      [33, '034_staff_totp.sql'],
      [34, '035_phone_sign_in.sql'],
      [35, '036_phone_sign_in_enrollment.sql'],
      [36, '037_personal_xml_sources.sql'],
      [37, '038_trusted_xml_publication.sql'],
      [38, '039_listing_form_drafts.sql'],
      [39, '040_seller_contact_settings.sql'],
      [40, '041_portal_feedback.sql'],
      [41, '042_professional_profile_image.sql'],
    ] as const) {
      assert.equal(upgradedLedger[index].name, name);
      assert.equal(
        upgradedLedger[index].checksum,
        createHash('sha256')
          .update(await readFile('migrations/' + name))
          .digest('hex'),
      );
    }
    for (const table of [
      'phone_otp_challenges',
      'phone_otp_send_events',
      'phone_sign_in_challenges',
      'listing_subscriptions',
      'listing_daily_candidates',
      'listing_daily_runs',
      'listing_daily_items',
      'professional_photo_cleanup',
      'listing_form_drafts',
      'seller_contact_phone_challenges',
      'listing_contact_phones',
      'portal_feedback',
    ]) {
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM ${quote(table)}`))
          .rows[0].count,
        0,
        `Additive table ${table} starts empty`,
      );
    }
    assert.deepEqual(
      (
        await pool.query('SELECT contact_mode,phone FROM users WHERE id=$1', [
          user,
        ])
      ).rows,
      [{ contact_mode: 'messages', phone: '+70000000001' }],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT phone FROM seller_contact_phones WHERE user_id=$1',
          [user],
        )
      ).rows,
      [{ phone: '+70000000001' }],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT kind,identity,generation::text FROM subscription_visibility_generations ORDER BY kind,identity',
        )
      ).rows,
      [{ kind: 'seller', identity: user, generation: '0' }],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT kind, organization_id, personal_feed_owner_id FROM listing_sources WHERE id=$1',
          [source],
        )
      ).rows,
      [{ kind: 'direct', organization_id: null, personal_feed_owner_id: null }],
    );
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
    assert.equal(
      (await pool.query('SELECT 1 FROM staff_totp_factors LIMIT 1')).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM sessions WHERE staff_totp_factor_id IS NOT NULL OR staff_assured_until IS NOT NULL LIMIT 1',
        )
      ).rowCount,
      0,
    );
    const upgradedAttributes = await attributes();
    for (const field of baselineAttributes) {
      const expected = { ...field };
      if (
        field.code === 'kitchen_area' &&
        ['apartment', 'aparthotel', 'new_build', 'secondary'].includes(
          field.category_code,
        )
      )
        expected.required = true;
      if (field.code === 'area') {
        if (field.category_code === 'land')
          expected.name = 'Площадь участка, м²';
        if (['house', 'townhouse'].includes(field.category_code))
          expected.name = 'Площадь дома, м²';
      }
      assert.deepEqual(
        upgradedAttributes.find(
          (candidate) =>
            candidate.category_code === field.category_code &&
            candidate.code === field.code,
        ),
        expected,
        `Preserved attribute ${field.category_code}.${field.code}`,
      );
    }
    const preserved = (
      await pool.query(
        'SELECT id::text,read_at,listing_id,subscription_version,listing_version,dedupe_key,payload FROM notifications WHERE user_id=$1 ORDER BY id',
        [user],
      )
    ).rows;
    assert.deepEqual(
      preserved.map(({ id, read_at }) => ({ id, read_at })),
      oldMessages,
    );
    for (const row of preserved)
      for (const field of [
        'listing_id',
        'subscription_version',
        'listing_version',
        'dedupe_key',
        'payload',
      ])
        assert.equal(row[field], null);
    await assert.rejects(
      pool.query(
        "INSERT INTO notifications(user_id,kind) VALUES($1,'message')",
        [user],
      ),
      /notifications_shape_check/,
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO notifications(user_id,kind,listing_id,listing_version,subscription_version,dedupe_key,payload) VALUES($1,'subscription.listing.availability',$2,1,NULL,'invalid','{}')",
        [user, listing],
      ),
      /notifications_shape_check/,
    );
    const otherUser = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,$2,'fixture-only','Other upgrade','buyer')",
      [otherUser, `${otherUser}@example.test`],
    );
    const subscriptionInsert =
      'INSERT INTO notifications(user_id,kind,listing_id,listing_version,subscription_version,dedupe_key,payload) VALUES($1,$2,$3,$4,$5,$6,$7)';
    const neutral = {
      listingId: listing,
      listingVersion: 1,
      subscriptionVersion: 1,
      event: { kind: 'availability', available: false },
    };
    const args = [
      user,
      'subscription.listing.availability',
      listing,
      1,
      1,
      'upgrade-event',
      neutral,
    ];
    await pool.query(subscriptionInsert, args);
    await assert.rejects(
      pool.query(subscriptionInsert, args),
      /notifications_subscription_dedupe/,
    );
    await pool.query(subscriptionInsert, [otherUser, ...args.slice(1)]);
    await pool.query(subscriptionInsert, [
      ...args.slice(0, 5),
      'another-upgrade-event',
      neutral,
    ]);
    for (const invalid of [
      [user, 'subscription.listing.unknown', listing, 1, 1, 'unknown', neutral],
      [
        user,
        'subscription.listing.availability',
        listing,
        null,
        1,
        'null',
        neutral,
      ],
      [
        user,
        'subscription.listing.availability',
        listing,
        0,
        1,
        'zero',
        neutral,
      ],
    ])
      await assert.rejects(
        pool.query(subscriptionInsert, invalid),
        /notifications_shape_check/,
      );
    await assert.rejects(
      pool.query(
        "INSERT INTO notifications(user_id,thread_id,kind,listing_id) VALUES($1,$2,'message',$3)",
        [user, thread, listing],
      ),
      /notifications_shape_check/,
    );
    const nextNotification = (
      await pool.query(
        "INSERT INTO notifications(user_id,thread_id,kind) VALUES($1,$2,'message') RETURNING id::text",
        [user, thread],
      )
    ).rows[0];
    assert.ok(BigInt(nextNotification.id) > BigInt(oldMessages.at(-1)!.id));

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
