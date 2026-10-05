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
import { Analytics } from './modules/analytics/analytics';
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
      'Candidate edits during scoring cannot leave a stale duplicate hold',
      async (t2) => {
        await pool.query(
          "UPDATE listings SET description='Normal description',version=version+1 WHERE id=$1",
          [first],
        );
        await trust.enqueue(actors[0]!, first, token());
        const score = worker.scorer.score.bind(worker.scorer);
        t2.mock.method(
          worker.scorer,
          'score',
          async (input: Parameters<typeof score>[0]) => {
            const report = await score(input);
            await pool.query(
              'UPDATE properties SET version=version+1 WHERE id=(SELECT property_id FROM listings WHERE id=$1)',
              [second],
            );
            return report;
          },
        );
        assert.equal(await worker.once(), true);
        const snapshot = await trust.snapshot(first);
        const assessment = (
          await pool.query(
            'SELECT id,findings FROM trust_assessments WHERE listing_id=$1 AND fact_hash=$2',
            [first, snapshot.factHash],
          )
        ).rows[0];
        assert.ok(assessment);
        assert.ok(
          !assessment.findings.some(
            (x: { code: string }) => x.code === 'duplicate_candidate',
          ),
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM duplicate_candidates WHERE assessment_id=$1',
              [assessment.id],
            )
          ).rows[0].count,
          '0',
        );
        const old = (
          await pool.query(
            'SELECT id FROM duplicate_candidates WHERE listing_id=$1',
            [first],
          )
        ).rows[0];
        assert.equal(
          (
            await call(
              '/v1/admin/trust/candidates/' + old.id + '/decision',
              'POST',
              { decision: 'distinct', reason: 'Recheck after property change' },
              2,
              token(),
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'Trust jobs fence stale snapshots, claim once concurrently and dead-letter bounded failures with audited admin retry',
      async (t2) => {
        await pool.query(
          'UPDATE listings SET price=price+1,version=version+1 WHERE id=$1',
          [first],
        );
        await trust.enqueue(actors[0]!, first, token());
        await pool.query(
          'UPDATE listings SET price=price+1,version=version+1 WHERE id=$1',
          [first],
        );
        await worker.once();
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM trust_jobs WHERE listing_id=$1 AND state='stale'",
              [first],
            )
          ).rows[0].count,
          '1',
        );
        const snapshot = await trust.snapshot(first);
        await trust.enqueue(actors[0]!, first, token());
        const score = worker.scorer.score.bind(worker.scorer);
        const mock = t2.mock.method(worker.scorer, 'score', async () => {
          throw new Error('provider-secret-should-not-leak');
        });
        for (let i = 0; i < 3; i++) {
          await worker.once();
          await pool.query(
            'UPDATE trust_jobs SET available_at=now() WHERE listing_id=$1 AND fact_hash=$2',
            [first, snapshot.factHash],
          );
        }
        const job = (
          await pool.query(
            'SELECT * FROM trust_jobs WHERE listing_id=$1 AND fact_hash=$2',
            [first, snapshot.factHash],
          )
        ).rows[0];
        assert.equal(job.state, 'dead');
        assert.equal(job.attempts, 3);
        assert.equal(job.last_error, 'assessment_failed');
        assert.equal(
          (
            await call(
              '/v1/admin/trust/jobs/' + job.id + '/retry',
              'POST',
              {},
              0,
              token(),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/v1/admin/trust/jobs/' + job.id + '/retry',
              'POST',
              {},
              2,
              token(),
            )
          ).status,
          201,
        );
        mock.mock.restore();
        const calls = t2.mock.method(worker.scorer, 'score', score);
        await Promise.all([worker.once(), worker.once()]);
        assert.equal(calls.mock.callCount(), 1);
        assert.equal(
          (
            await pool.query('SELECT state FROM trust_jobs WHERE id=$1', [
              job.id,
            ])
          ).rows[0].state,
          'done',
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM audit_events WHERE action='trust.job.retried' AND entity_id=$1",
              [job.id],
            )
          ).rows[0].count,
          '1',
        );
      },
    );
    await t.test(
      'Expired leases after three crashed attempts dead-letter without an unbounded fourth scoring attempt',
      async (t2) => {
        await pool.query(
          'UPDATE listings SET price=price+1,version=version+1 WHERE id=$1',
          [first],
        );
        const snapshot = await trust.snapshot(first);
        await trust.enqueue(actors[0]!, first, token());
        await pool.query(
          "UPDATE trust_jobs SET state='running',attempts=3,lease_token=$3,lease_until=now()-interval '1 second' WHERE listing_id=$1 AND fact_hash=$2",
          [first, snapshot.factHash, randomUUID()],
        );
        const score = t2.mock.method(
          worker.scorer,
          'score',
          worker.scorer.score.bind(worker.scorer),
        );
        await worker.once();
        const job = (
          await pool.query(
            'SELECT * FROM trust_jobs WHERE listing_id=$1 AND fact_hash=$2',
            [first, snapshot.factHash],
          )
        ).rows[0];
        assert.equal(job.state, 'dead');
        assert.equal(job.attempts, 3);
        assert.equal(score.mock.callCount(), 0);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM trust_assessments WHERE listing_id=$1 AND fact_hash=$2',
              [first, snapshot.factHash],
            )
          ).rows[0].count,
          '0',
        );
      },
    );
    await t.test(
      'HTTP publication cannot bypass deterministic trust review when AI is off',
      async () => {
        await pool.query(
          "UPDATE listings SET status='moderation',description='Переведите предоплату до просмотра квартиры',version=version+1 WHERE id=$1",
          [first],
        );
        const snapshot = await trust.snapshot(first),
          id = randomUUID();
        await pool.query(
          'INSERT INTO moderation_cases(id,listing_id,listing_version) VALUES($1,$2,$3)',
          [id, first, snapshot.version],
        );
        const approve = () =>
          call(
            '/v1/admin/moderation/' + id + '/decision',
            'POST',
            { decision: 'approve', reason: 'Independent verified review' },
            2,
            token(),
          );
        assert.equal(process.env.AI_ENABLED, 'false');
        assert.equal((await approve()).status, 409);
        assert.equal(
          (
            await pool.query('SELECT state FROM moderation_cases WHERE id=$1', [
              id,
            ])
          ).rows[0].state,
          'pending',
        );
        assert.equal(
          (
            await call(
              '/v1/admin/trust/listings/' + first + '/decision',
              'POST',
              {
                factHash: snapshot.factHash,
                decision: 'allow',
                reason: 'Risk checked independently',
              },
              2,
              token(),
            )
          ).status,
          201,
        );
        const published = await approve();
        assert.equal(published.status, 201);
        assert.equal(
          ((await published.json()) as { status: string }).status,
          'published',
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
      'In-flight recommendation withdrawal removes stale AI advice but settles provider cost',
      async (t2) => {
        await pool.query(
          "UPDATE listings SET status='published',published_at=now() WHERE id=ANY($1::uuid[])",
          [[first, second]],
        );
        await pool.query(
          'UPDATE ai_budget_days SET spent_micros=0,reserved_micros=0 WHERE day=CURRENT_DATE',
        );
        const enabled = await call(
          '/v1/admin/ai/features/recommendations',
          'PATCH',
          { version: 1, enabled: true },
          2,
        );
        assert.equal(enabled.status, 200);
        process.env.AI_ENABLED = 'true';
        const generate = provider.generate.bind(provider);
        t2.mock.method(provider, 'generate', async () => {
          const reply = await generate();
          await pool.query(
            "UPDATE listings SET status='paused',version=version+1 WHERE id=$1",
            [second],
          );
          return { ...reply, suggestion: 'Recommended listing ' + second };
        });
        try {
          const response = await call(
            '/v1/ai/assist',
            'POST',
            { capability: 'recommendations', listingId: first },
            3,
          );
          assert.equal(response.status, 201);
          const answer = (await response.json()) as {
            mode: string;
            reason: string;
            costMicros: number;
          };
          assert.equal(answer.mode, 'fallback');
          assert.equal(answer.reason, 'context_changed');
          assert.ok(!JSON.stringify(answer).includes(second));
          assert.equal(answer.costMicros, 7);
          const budget = (
            await pool.query(
              'SELECT reserved_micros,spent_micros FROM ai_budget_days WHERE day=CURRENT_DATE',
            )
          ).rows[0];
          assert.equal(budget.reserved_micros, '0');
          assert.equal(budget.spent_micros, '7');
        } finally {
          process.env.AI_ENABLED = 'false';
        }
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
    await t.test(
      'Market and valuation require five live offers from three sellers and suppress withdrawn comparables',
      async () => {
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          const source = randomUUID(),
            property = randomUUID(),
            id = randomUUID();
          await pool.query(
            "INSERT INTO listing_sources(id,kind,metadata) VALUES($1,'direct','{}')",
            [source],
          );
          await pool.query(
            'INSERT INTO properties(id,created_by,category_code,address_id,attributes,unit_number) SELECT $1,$2,category_code,address_id,attributes,$3 FROM properties WHERE id=(SELECT property_id FROM listings WHERE id=$4)',
            [property, actors[i % 3]!.id, String(30 + i), first],
          );
          await pool.query(
            "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,title,price,status,published_at) VALUES($1,$2,$3,$4,'sale','Market offer',$5,'published',now())",
            [id, property, source, actors[i % 3]!.id, 9000000 + i * 1000000],
          );
          ids.push(id);
        }
        const market = await app.get(Analytics).market(actors[3]!, {
          category: 'apartment',
          locality: 'Москва',
          dealType: 'sale',
        });
        assert.equal(market.cohorts.length, 1);
        assert.equal(market.cohorts[0]!.sample_size_floor, 5);
        assert.ok(!ids.some((id) => JSON.stringify(market).includes(id)));
        const answer = (await (
          await call(
            '/v1/ai/assist',
            'POST',
            { capability: 'valuation', listingId: first },
            3,
          )
        ).json()) as {
          result: {
            status: string;
            range: { currency: string; min: number; max: number } | null;
          };
        };
        assert.equal(answer.result.status, 'indicative');
        assert.equal(answer.result.range?.currency, 'RUB');
        assert.ok(answer.result.range!.max >= answer.result.range!.min);
        await pool.query("UPDATE listings SET status='paused' WHERE id=$1", [
          ids[0],
        ]);
        assert.deepEqual(
          (await app.get(Analytics).market(actors[3]!, { dealType: 'sale' }))
            .cohorts,
          [],
        );
        const fallback = (await (
          await call(
            '/v1/ai/assist',
            'POST',
            { capability: 'valuation', listingId: first },
            3,
          )
        ).json()) as { result: { status: string; range: null } };
        assert.equal(fallback.result.status, 'insufficient_data');
        assert.equal(fallback.result.range, null);
      },
    );
    await t.test(
      'Analytics retention removes expired events and matching pseudonym keys without touching current events',
      async () => {
        await pool.query(
          'INSERT INTO analytics_daily_keys(day) VALUES(CURRENT_DATE-91)',
        );
        await pool.query(
          "INSERT INTO analytics_events(schema_version,event_key,listing_id,day,actor_hash,kind,promoted) VALUES(1,$1,$2,CURRENT_DATE-91,repeat('a',64),'view',false)",
          [randomUUID(), first],
        );
        const before = (
          await pool.query(
            'SELECT count(*) FROM analytics_events WHERE day=CURRENT_DATE',
          )
        ).rows[0].count;
        await app.get(Analytics).prune();
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
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM analytics_events WHERE day=CURRENT_DATE',
            )
          ).rows[0].count,
          before,
        );
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
          provider.fail = false;
          process.env.AI_ENABLED = 'false';
        }
      },
    );
  } finally {
    if (oldEnabled === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = oldEnabled;
    await app.close();
    await pool.end();
  }
});
