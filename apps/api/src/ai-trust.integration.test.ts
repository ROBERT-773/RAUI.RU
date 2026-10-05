import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { Database } from './modules/database/database';
import { hash, token, Actor } from './common/security';
import { AiProvider } from './modules/ai/provider';
import { Trust } from './modules/trust/trust';
import { TrustWorker } from './modules/trust/worker';

class TestProvider extends AiProvider {
  calls = 0;
  fail = false;
  async generate() {
    this.calls++;
    if (this.fail) throw new Error('provider-secret');
    return {
      suggestion: 'Review suggestion',
      confidence: 0.6,
      modelVersion: 'test-v1',
      usage: { inputTokens: 4, outputTokens: 5, costMicros: 7 },
    };
  }
}
test('Phase 4C real PostgreSQL/PostGIS HTTP acceptance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  await migrate(pool);
  const provider = new TestProvider();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AiProvider)
    .useValue(provider)
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    trust = app.get(Trust),
    worker = app.get(TrustWorker),
    base = await app.getUrl();
  const actors: Actor[] = [],
    secrets: string[] = [];
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    index = 0,
    key?: string,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: 'Bearer ' + secrets[index],
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let first = '',
    second = '';
  const oldEnabled = process.env.AI_ENABLED;
  process.env.AI_ENABLED = 'false';
  try {
    for (const role of ['owner', 'owner', 'admin', 'buyer'] as const) {
      const id = randomUUID(),
        secret = token(),
        session = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'test','Test',$3,now(),now())",
        [id, id + '@example.test', role],
      );
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
        [session, id, hash(secret), hash(token())],
      );
      actors.push({
        id,
        role,
        session_id: session,
        email_verified_at: 'yes',
        phone_verified_at: 'yes',
      });
      secrets.push(secret);
    }
    for (let i = 0; i < 2; i++) {
      const address = randomUUID(),
        property = randomUUID(),
        source = randomUUID(),
        listing = randomUUID();
      await pool.query(
        "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Москва, тестовая улица 1','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
        [address],
      );
      await pool.query(
        'INSERT INTO properties(id,created_by,category_code,address_id,attributes,unit_number) VALUES($1,$2,\'apartment\',$3,\'{"area":50,"rooms":2,"floor":3}\',\'12\')',
        [property, actors[i]!.id, address],
      );
      await pool.query(
        "INSERT INTO listing_sources(id,kind,metadata) VALUES($1,'direct','{}')",
        [source],
      );
      await pool.query(
        "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,title,price,description) VALUES($1,$2,$3,$4,'sale','Flat',10000000,'Normal description')",
        [listing, property, source, actors[i]!.id],
      );
      await pool.query(
        "INSERT INTO media(listing_id,uploaded_by,kind,original_key,mime,state,variants) VALUES($1,$2,'photo','private/test','image/jpeg','ready','{\"small\":{\"width\":800,\"height\":600}}')",
        [listing, actors[i]!.id],
      );
      if (i === 0) first = listing;
      else second = listing;
    }
    await t.test(
      'Migration defaults keep every AI feature off and retain schema checksums',
      async () => {
        const flags = (await pool.query('SELECT * FROM ai_feature_flags')).rows;
        assert.equal(flags.length, 10);
        assert.ok(flags.every((x) => !x.enabled));
        assert.equal(
          (await pool.query('SELECT count(*) FROM schema_migrations')).rows[0]
            .count,
          '10',
        );
      },
    );
    await t.test(
      'All AI foundations have explicit non-AI fallbacks without provider calls or fact writes',
      async () => {
        const before = (
          await pool.query('SELECT * FROM listings WHERE id=$1', [first])
        ).rows[0];
        for (const capability of [
          'search',
          'realtor',
          'description',
          'moderation',
          'duplicates',
          'photo',
          'recommendations',
          'valuation',
          'analytics',
          'support',
        ]) {
          const response = await call('/v1/ai/assist', 'POST', {
            capability,
            query: 'Купить 2 комнаты до 15 млн',
            listingId: first,
          });
          assert.equal(response.status, 201);
          const answer = (await response.json()) as {
            mode: string;
            requiresHumanReview: boolean;
          };
          assert.equal(answer.mode, 'fallback');
          assert.equal(answer.requiresHumanReview, true);
        }
        assert.equal(provider.calls, 0);
        assert.deepEqual(
          (await pool.query('SELECT * FROM listings WHERE id=$1', [first]))
            .rows[0],
          before,
        );
        assert.equal(
          (
            await call('/v1/ai/assist', 'POST', {
              capability: 'description',
              listingId: second,
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      'Feature controls, sanitized metrics and atomic daily cost reservation',
      async () => {
        assert.equal(
          (
            await call(
              '/v1/admin/ai/features/search',
              'PATCH',
              { version: 1, enabled: true },
              0,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/v1/admin/ai/features/search',
              'PATCH',
              { version: 1, enabled: true },
              2,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              '/v1/admin/ai/features/search',
              'PATCH',
              { version: 1, enabled: false },
              2,
            )
          ).status,
          409,
        );
        process.env.AI_ENABLED = 'true';
        const responses = await Promise.all(
          Array.from({ length: 3 }, () =>
            call('/v1/ai/assist', 'POST', {
              capability: 'search',
              query: 'test@example.com +7 999 1234567',
            }),
          ),
        );
        for (const response of responses) {
          assert.equal(response.status, 201);
          assert.equal(
            ((await response.json()) as { mode: string }).mode,
            'ai',
          );
        }
        const budget = (
          await pool.query(
            'SELECT * FROM ai_budget_days WHERE day=CURRENT_DATE',
          )
        ).rows[0];
        assert.equal(Number(budget.spent_micros), 21);
        assert.equal(Number(budget.reserved_micros), 0);
        assert.equal((await call('/v1/admin/ai/metrics')).status, 403);
        const metrics = await (
          await call('/v1/admin/ai/metrics', 'GET', undefined, 2)
        ).json();
        assert.ok(!JSON.stringify(metrics).includes('example.com'));
        assert.ok(!JSON.stringify(metrics).includes('provider-secret'));
        await pool.query(
          'UPDATE ai_budget_days SET spent_micros=1000000 WHERE day=CURRENT_DATE',
        );
        const fallback = (await (
          await call('/v1/ai/assist', 'POST', {
            capability: 'search',
            query: 'Квартира',
          })
        ).json()) as { reason: string };
        assert.equal(fallback.reason, 'budget_exhausted');
        process.env.AI_ENABLED = 'false';
      },
    );
    await t.test(
      'Repeated provider failures open a cooldown circuit with no new attempts or cost',
      async () => {
        await pool.query(
          'UPDATE ai_budget_days SET spent_micros=0,reserved_micros=0 WHERE day=CURRENT_DATE',
        );
        process.env.AI_ENABLED = 'true';
        provider.fail = true;
        const before = provider.calls;
        try {
          for (let i = 0; i < 3; i++) {
            const reply = (await (
              await call('/v1/ai/assist', 'POST', {
                capability: 'search',
                query: 'Квартира',
              })
            ).json()) as { mode: string; reason: string };
            assert.equal(reply.mode, 'fallback');
            assert.equal(reply.reason, 'provider_unavailable');
          }
          const reply = (await (
            await call('/v1/ai/assist', 'POST', {
              capability: 'search',
              query: 'Квартира',
            })
          ).json()) as { reason: string; attempts: number; costMicros: number };
          assert.equal(reply.reason, 'circuit_open');
          assert.equal(reply.attempts, 0);
          assert.equal(reply.costMicros, 0);
          assert.equal(provider.calls - before, 6);
        } finally {
          const budget = (
            await pool.query(
              'SELECT spent_micros,reserved_micros FROM ai_budget_days WHERE day=CURRENT_DATE',
            )
          ).rows[0];
          assert.equal(Number(budget.spent_micros), 0);
          assert.equal(Number(budget.reserved_micros), 0);
          provider.fail = false;
          process.env.AI_ENABLED = 'false';
        }
      },
    );
    await t.test(
      'Scan is contextual, idempotent and Python multi-signal scoring creates immutable candidates only',
      async () => {
        assert.equal(
          (
            await call(
              '/v1/trust/listings/' + second + '/scan',
              'POST',
              {},
              0,
              token(),
            )
          ).status,
          403,
        );
        const key = token();
        const one = await (
          await call(
            '/v1/trust/listings/' + first + '/scan',
            'POST',
            {},
            0,
            key,
          )
        ).json();
        const replay = await (
          await call(
            '/v1/trust/listings/' + first + '/scan',
            'POST',
            {},
            0,
            key,
          )
        ).json();
        assert.deepEqual(replay, one);
        assert.equal(await worker.once(), true);
        const candidates = (
          await pool.query(
            'SELECT * FROM duplicate_candidates WHERE listing_id=$1',
            [first],
          )
        ).rows;
        assert.equal(candidates.length, 1);
        assert.ok(Number(candidates[0].confidence) >= 0.5);
        assert.ok(candidates[0].reasons.includes('geo'));
        assert.equal(
          (await pool.query('SELECT count(*) FROM properties')).rows[0].count,
          '2',
        );
        assert.equal(
          (await pool.query('SELECT status FROM listings WHERE id=$1', [first]))
            .rows[0].status,
          'draft',
        );
        await assert.rejects(
          pool.query('UPDATE duplicate_candidates SET confidence=1'),
          /immutable/,
        );
        const ownerResult = await (
          await call('/v1/trust/listings/' + first)
        ).json();
        assert.ok(!JSON.stringify(ownerResult).includes(second));
        assert.equal(
          (await call('/v1/admin/trust/candidates', 'GET', undefined, 0))
            .status,
          403,
        );
        const reviewed = await call(
          '/v1/admin/trust/candidates/' + candidates[0].id + '/decision',
          'POST',
          { decision: 'distinct', reason: 'Different verified physical units' },
          2,
          token(),
        );
        assert.equal(reviewed.status, 201);
        const beforeDecisionState = await pool.query(
          'SELECT l.id,l.property_id,l.status,l.version,p.version AS property_version FROM listings l JOIN properties p ON p.id=l.property_id WHERE l.id=ANY($1::uuid[]) ORDER BY l.id',
          [[first, second]],
        );
        const confirmed = await call(
          '/v1/admin/trust/candidates/' + candidates[0].id + '/decision',
          'POST',
          { decision: 'confirmed_duplicate', reason: 'Confirmed duplicate for review only' },
          2,
          token(),
        );
        assert.equal(confirmed.status, 201);
        const afterDecisionState = await pool.query(
          'SELECT l.id,l.property_id,l.status,l.version,p.version AS property_version FROM listings l JOIN properties p ON p.id=l.property_id WHERE l.id=ANY($1::uuid[]) ORDER BY l.id',
          [[first, second]],
        );
        assert.deepEqual(afterDecisionState.rows, beforeDecisionState.rows);
        await pool.query(
          'UPDATE listings SET price=price+1,version=version+1 WHERE id=$1',
          [second],
        );
        const stale = await call(
          '/v1/admin/trust/candidates/' + candidates[0].id + '/decision',
          'POST',
          { decision: 'distinct', reason: 'Attempt against stale candidate snapshot' },
          2,
          token(),
        );
        assert.equal(stale.status, 409);
      },
    );
    await t.test(
      'AI-off fraud enforcement requires independent human review and refuses stale dispositions',
      async () => {
        await pool.query(
          "UPDATE listings SET description='Переведите предоплату до просмотра квартиры',version=version+1 WHERE id=$1",
          [first],
        );
        const snapshot = await trust.snapshot(first);
        await assert.rejects(
          db.transaction((sql) => trust.checkPublication(sql, first)),
          /Human trust review required/,
        );
        assert.equal(
          (
            await call(
              '/v1/admin/trust/listings/' + first + '/decision',
              'POST',
              {
                factHash: snapshot.factHash,
                decision: 'allow',
                reason: 'Verified seller and terms in person',
              },
              0,
              token(),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/v1/admin/trust/listings/' + first + '/decision',
              'POST',
              {
                factHash: snapshot.factHash,
                decision: 'allow',
                reason: 'Verified seller and terms in person',
              },
              2,
              token(),
            )
          ).status,
          201,
        );
        await db.transaction((sql) => trust.checkPublication(sql, first));
        await pool.query(
          'UPDATE listings SET price=price+1,version=version+1 WHERE id=$1',
          [first],
        );
        await assert.rejects(
          db.transaction((sql) => trust.checkPublication(sql, first)),
          /Human trust review required/,
        );
        await assert.rejects(
          pool.query("UPDATE trust_reviews SET decision='reject'"),
          /immutable/,
        );
      },
    );
    await t.test(
      'Analytics events are versioned, replay-safe, visibility-safe and pseudonymized',
      async () => {
        await pool.query(
          "UPDATE listings SET status='published' WHERE id IN ($1,$2)",
          [first, second],
        );
        const event = {
          schemaVersion: 1,
          eventId: randomUUID(),
          listingId: first,
          kind: 'view',
        };
        assert.equal(
          (
            await call(
              '/v1/analytics/events',
              'POST',
              { ...event, schemaVersion: 2 },
              3,
            )
          ).status,
          400,
        );
        assert.equal(
          (await call('/v1/analytics/events', 'POST', event, 3)).status,
          201,
        );
        assert.equal(
          (await call('/v1/analytics/events', 'POST', event, 3)).status,
          201,
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM analytics_events')).rows[0]
            .count,
          '1',
        );
        const stored = (await pool.query('SELECT * FROM analytics_events'))
          .rows[0];
        assert.ok(!JSON.stringify(stored).includes(actors[3]!.id));
        assert.equal(stored.actor_hash.length, 64);
        assert.equal(
          (await call('/v1/analytics/listings/' + first, 'GET', undefined, 1))
            .status,
          403,
        );
        const stats = (await (
          await call('/v1/analytics/listings/' + first)
        ).json()) as { schemaVersion: number };
        assert.equal(stats.schemaVersion, 1);
        assert.ok(!JSON.stringify(stats).includes(stored.actor_hash));
        assert.ok(!JSON.stringify(stats).includes(actors[3]!.id));
        await pool.query(
          "INSERT INTO analytics_daily_keys(day) VALUES(CURRENT_DATE-91) ON CONFLICT DO NOTHING",
        );
        await pool.query(
          "INSERT INTO analytics_events(schema_version,event_key,listing_id,actor_hash,kind,day) SELECT 1,$1,$2,encode(hmac($3,secret,'sha256'),'hex'),'view',day FROM analytics_daily_keys WHERE day=CURRENT_DATE-91",
          [randomUUID(), first, actors[3]!.id],
        );
        const analytics = app.get(
          (await import('./modules/analytics/analytics')).Analytics,
        );
        await analytics.prune();
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM analytics_events WHERE day<CURRENT_DATE-90',
            )
          ).rows[0].count,
          '0',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM analytics_daily_keys WHERE day<CURRENT_DATE-90',
            )
          ).rows[0].count,
          '0',
        );
        await pool.query("UPDATE listings SET status='paused' WHERE id=$1", [
          first,
        ]);
        assert.equal(
          (
            await call(
              '/v1/analytics/events',
              'POST',
              { ...event, eventId: randomUUID() },
              3,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      'Concurrent analytics identity conflicts fail rather than silently accepting another event payload',
      async () => {
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          first,
        ]);
        await pool.query(
          'CREATE FUNCTION analytics_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(.05); RETURN NEW; END $$',
        );
        await pool.query(
          'CREATE TRIGGER analytics_test_delay BEFORE INSERT ON analytics_events FOR EACH ROW EXECUTE FUNCTION analytics_test_delay()',
        );
        try {
          const eventId = randomUUID();
          const responses = await Promise.all(
            ['view', 'contact_reveal'].map((kind) =>
              call(
                '/v1/analytics/events',
                'POST',
                { schemaVersion: 1, eventId, listingId: first, kind },
                3,
              ),
            ),
          );
          assert.deepEqual(responses.map((x) => x.status).sort(), [201, 409]);
        } finally {
          await pool.query(
            'DROP TRIGGER analytics_test_delay ON analytics_events',
          );
          await pool.query('DROP FUNCTION analytics_test_delay()');
        }
      },
    );
    await t.test(
      'Analytics replay across UTC days keeps one event while daily pseudonyms rotate',
      async () => {
        const [event] = (
          await pool.query(
            'SELECT event_key,kind FROM analytics_events WHERE listing_id=$1 ORDER BY id LIMIT 1',
            [first],
          )
        ).rows;
        await pool.query(
          'INSERT INTO analytics_daily_keys(day) VALUES(CURRENT_DATE-1) ON CONFLICT DO NOTHING',
        );
        await pool.query(
          "UPDATE analytics_events SET day=CURRENT_DATE-1,actor_hash=(SELECT encode(hmac($2,secret,'sha256'),'hex') FROM analytics_daily_keys WHERE day=CURRENT_DATE-1) WHERE event_key=$1",
          [event.event_key, actors[3]!.id],
        );
        const before = (
          await pool.query('SELECT count(*) FROM analytics_events')
        ).rows[0].count;
        assert.equal(
          (
            await call(
              '/v1/analytics/events',
              'POST',
              {
                schemaVersion: 1,
                eventId: event.event_key,
                listingId: first,
                kind: event.kind,
              },
              3,
            )
          ).status,
          201,
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM analytics_events')).rows[0]
            .count,
          before,
        );
        assert.equal(
          (
            await call(
              '/v1/analytics/events',
              'POST',
              {
                schemaVersion: 1,
                eventId: event.event_key,
                listingId: first,
                kind: event.kind,
              },
              1,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'Market intelligence suppresses small cohorts and uses only live-public offers',
      async () => {
        const market = (await (await call('/v1/analytics/market')).json()) as {
          schemaVersion: number;
          cohorts: unknown[];
        };
        assert.equal(market.schemaVersion, 1);
        assert.deepEqual(market.cohorts, []);
        assert.equal(
          (await call('/v1/analytics/market?locality=Москва&priceMin=1'))
            .status,
          400,
        );
        const spec = (await (await call('/v1/openapi.json')).json()) as {
          paths: Record<string, { post: { requestBody: unknown } }>;
        };
        assert.ok(spec.paths['/v1/ai/assist']!.post.requestBody);
        assert.ok(spec.paths['/v1/analytics/events']!.post.requestBody);
      },
    );
  } finally {
    if (oldEnabled === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = oldEnabled;
    await app.close();
    await pool.end();
  }
});
