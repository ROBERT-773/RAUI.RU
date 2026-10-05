import { hash } from './common/security';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import {
  VerificationDelivery,
  VerificationMessage,
} from './modules/auth/delivery';
import { MediaWorker, WorkerModule } from './modules/media/worker';
import { ObjectStorage } from './modules/media/storage';
import { signIdentity } from '@raui/config/ingress';

class CaptureDelivery extends VerificationDelivery {
  readonly messages: VerificationMessage[] = [];
  async send(message: VerificationMessage) {
    this.messages.push(message);
  }
  latest(destination: string, purpose: VerificationMessage['purpose']) {
    return [...this.messages]
      .reverse()
      .find((m) => m.destination === destination && m.purpose === purpose)!
      .token;
  }
}
interface Session {
  sessionToken: string;
  csrfToken: string;
  user: { id: string };
}
interface Entity {
  id: string;
  version: number;
  status: string;
  source_id: string;
  property_id: string;
}
const address = {
  formatted: 'Москва, Тверская, 1',
  locality: 'Москва',
  longitude: 37.6173,
  latitude: 55.7558,
};

test('Phase 2 PostgreSQL/PostGIS and HTTP acceptance', async (t) => {
  assert.ok(
    process.env.TEST_DATABASE_URL?.includes('/raui_test_'),
    'Isolated test database required',
  );
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  await migrate(pool);
  const delivery = new CaptureDelivery();
  const module = await Test.createTestingModule({
    imports: [AppModule, WorkerModule],
  })
    .overrideProvider(VerificationDelivery)
    .useValue(delivery)
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(),
    db = app.get(Database),
    worker = app.get(MediaWorker),
    storage = app.get(ObjectStorage);
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    session?: Session,
    key?: string,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(session ? { Authorization: `Bearer ${session.sessionToken}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers };
  }
  async function ok<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    session?: Session,
    key?: string,
  ): Promise<T> {
    const response = await call(path, method, body, session, key);
    assert.ok(
      response.status >= 200 && response.status < 300,
      `${method} ${path}: ${response.status} ${JSON.stringify(response.data)}`,
    );
    return response.data as T;
  }
  let phoneCounter = 0;
  async function account(name: string, role = 'owner'): Promise<Session> {
    const email = `${name}@example.test`;
    await ok('/auth/register', 'POST', {
      email,
      password: 'correct-long-password',
      displayName: name,
      role,
    });
    await ok('/auth/verification/email/confirm', 'POST', {
      token: delivery.latest(email, 'email'),
    });
    const session = await ok<Session>('/auth/login', 'POST', {
      email,
      password: 'correct-long-password',
      transport: 'bearer',
    });
    const phone = `+7999${String(++phoneCounter).padStart(7, '0')}`;
    await ok('/auth/verification/phone', 'POST', { phone }, session);
    await ok(
      '/auth/verification/phone/confirm',
      'POST',
      { token: delivery.latest(phone, 'phone') },
      session,
    );
    return session;
  }
  async function property(
    session: Session,
    key: string,
    organizationId?: string,
    extra: Record<string, unknown> = {},
  ) {
    return ok<Entity>(
      '/properties',
      'POST',
      {
        category: 'apartment',
        address,
        attributes: { area: 55 },
        ...(organizationId ? { organizationId } : {}),
        ...extra,
      },
      session,
      key,
    );
  }
  let owner: Session, other: Session, admin: Session, buyer: Session;
  let listing: Entity, physical: Entity;
  try {
    t.beforeEach(async () => {
      await db.pool.query('DELETE FROM rate_limits');
    });
    await t.test(
      'migrations are clean, repeatable, checksum-protected and atomic',
      async () => {
        assert.equal(
          (await pool.query('SELECT count(*) FROM schema_migrations')).rows[0]
            .count,
          '11',
        );
        const directory = resolve(
          process.env.LOCAL_PRIVATE_DIR!,
          'migration-fixtures',
        );
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, '001_core.sql'),
          (await readFile('migrations/001_core.sql', 'utf8')) +
            '\n-- tampered\n',
        );
        await assert.rejects(migrate(pool, directory), /checksum changed/);
        await writeFile(
          resolve(directory, '002_broken.sql'),
          'CREATE TABLE must_rollback(id int); SELECT missing_column;',
        );
        // Use a directory with only the failing new migration.
        const failed = resolve(directory, 'failed');
        await mkdir(failed);
        await writeFile(
          resolve(failed, '002_broken.sql'),
          'CREATE TABLE must_rollback(id int); SELECT missing_column;',
        );
        await assert.rejects(migrate(pool, failed));
        assert.equal(
          (await pool.query("SELECT to_regclass('must_rollback') AS relation"))
            .rows[0].relation,
          null,
        );
      },
    );
    await t.test(
      'Migration lock acquisition is bounded and preserves pooled connection settings',
      async () => {
        const runner = new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          max: 1,
        });
        const blocker = await pool.connect();
        let unlocking: Promise<unknown> | undefined;
        const unlock = () =>
          (unlocking ??= blocker.query(
            "SELECT pg_advisory_unlock(hashtextextended('raui:migrations',0))",
          ));
        await runner.query(
          "SET lock_timeout='1700ms'; SET statement_timeout='23s'",
        );
        await blocker.query(
          "SELECT pg_advisory_lock(hashtextextended('raui:migrations',0))",
        );
        const watchdog = setTimeout(() => {
          void unlock().catch(() => {});
        }, 8000);
        const started = Date.now();
        try {
          await assert.rejects(
            migrate(runner),
            (error: unknown) => (error as { code?: string }).code === '55P03',
          );
          assert.ok(
            Date.now() - started >= 4500 && Date.now() - started < 7000,
            'Must reject before watchdog releases lock',
          );
          const settings = async () =>
            (
              await runner.query(
                "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
              )
            ).rows[0];
          assert.deepEqual(await settings(), {
            lock: '1700ms',
            statement: '23s',
          });
          await unlock();
          await migrate(runner);
          assert.deepEqual(await settings(), {
            lock: '1700ms',
            statement: '23s',
          });
        } finally {
          clearTimeout(watchdog);
          try {
            await unlock();
          } finally {
            blocker.release();
            await runner.end();
          }
        }
      },
    );
    await t.test(
      'auth denies escalation, unverified publishing and unauthorized admin',
      async () => {
        assert.equal(
          (
            await call('/auth/register', 'POST', {
              email: 'root@example.test',
              password: 'correct-long-password',
              displayName: 'root',
              role: 'admin',
            })
          ).status,
          400,
        );
        assert.equal((await call('/admin/users')).status, 401);
        await ok('/auth/register', 'POST', {
          email: 'unverified@example.test',
          password: 'correct-long-password',
          displayName: 'unverified',
          role: 'owner',
        });
        const unverified = await ok<Session>('/auth/login', 'POST', {
          email: 'unverified@example.test',
          password: 'correct-long-password',
          transport: 'bearer',
        });
        assert.equal(
          (
            await call(
              '/properties',
              'POST',
              { category: 'apartment', address },
              unverified,
              'unverified-key',
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call('/auth/login', 'POST', {
              email: 'missing@example.test',
              password: 'correct-long-password',
            })
          ).status,
          401,
        );
        owner = await account('owner');
        other = await account('other');
        admin = await account('admin');
        // Exercise the actual audited operator command, including session revocation.
        const { execFileSync } = await import('node:child_process');
        execFileSync(
          process.execPath,
          ['.cache/test/modules/auth/bootstrap-admin.js', 'admin@example.test'],
          { stdio: 'pipe' },
        );
        admin = await ok<Session>('/auth/login', 'POST', {
          email: 'admin@example.test',
          password: 'correct-long-password',
          transport: 'bearer',
        });
        assert.equal(
          (await call('/admin/users', 'GET', undefined, owner)).status,
          403,
        );
      },
    );
    await t.test(
      'Production markers always secure HTTP session cookies',
      async () => {
        // Connections and the delivery adapter were constructed against the isolated
        // local database above; these synthetic production URLs are never contacted.
        const production = {
          WEB_ORIGIN: 'https://raui.ru',
          PROXY_IDENTITY_SECRET: 'synthetic-forwarding-key-'.repeat(2),
          TRUSTED_PROXY_PEERS: '192.168.99.99',
          TRUSTED_INGRESS_IP_HEADER: 'x-real-ip',
          SITE_URL: 'https://raui.ru',
          DATABASE_URL:
            'postgresql://service@db.internal/raui?sslmode=verify-full',
          REDIS_URL: 'rediss://redis.internal:6380',
          OPENSEARCH_URL: 'https://search.internal:9200',
          OPENSEARCH_TOKEN: 'test-only-search-token',
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'raui-private',
          S3_ENDPOINT: 'https://storage.internal',
          VERIFICATION_GATEWAY_URL: 'https://verification.example/generate',
          VERIFICATION_GATEWAY_TOKEN: 'test-only-verification-token',
          NODE_ENV: 'development',
          DEPLOYMENT_ENV: 'production',
        };
        const saved = Object.fromEntries(
          Object.keys(production).map((key) => [key, process.env[key]]),
        );
        try {
          Object.assign(process.env, production);
          for (const markers of [
            { NODE_ENV: 'development', DEPLOYMENT_ENV: 'production' },
            { NODE_ENV: 'production', DEPLOYMENT_ENV: 'local' },
          ]) {
            Object.assign(process.env, markers);
            const response = await call('/auth/login', 'POST', {
              email: 'owner@example.test',
              password: 'correct-long-password',
              transport: 'cookie',
            });
            assert.equal(response.status, 201);
            const cookie = response.headers.get('set-cookie') ?? '';
            assert.ok(
              cookie.includes('; Secure'),
              'Production cookie requires Secure',
            );
            assert.ok(cookie.includes('; HttpOnly'));
            assert.ok(cookie.includes('; SameSite=Lax'));
          }
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      },
    );
    await t.test(
      'Signed proxy identities isolate real HTTP rate counters and reject spoofing',
      async () => {
        const previousSecret = process.env.PROXY_IDENTITY_SECRET;
        const previousPeers = process.env.TRUSTED_PROXY_PEERS;
        const secret = 'synthetic-forwarding-key-'.repeat(2);
        process.env.PROXY_IDENTITY_SECRET = secret;
        process.env.TRUSTED_PROXY_PEERS = '127.0.0.1';
        try {
          for (let n = 0; n < 160; n++) {
            for (const ip of ['8.8.8.8', '8.8.4.4']) {
              const response = await call(
                '/categories',
                'GET',
                undefined,
                undefined,
                undefined,
                signIdentity('GET', '/v1/categories', ip, secret),
              );
              assert.equal(response.status, 200);
            }
          }
          assert.deepEqual(
            (
              await pool.query(
                "SELECT key,count FROM rate_limits WHERE key IN ('api:8.8.8.8','api:8.8.4.4') ORDER BY key",
              )
            ).rows,
            [
              { key: 'api:8.8.4.4', count: 160 },
              { key: 'api:8.8.8.8', count: 160 },
            ],
          );
          const bad = signIdentity('GET', '/v1/categories', '8.8.8.8', secret);
          bad['x-raui-forwarded-signature'] = '0'.repeat(64);
          assert.equal(
            (
              await call(
                '/categories',
                'GET',
                undefined,
                undefined,
                undefined,
                bad,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await call(
                '/categories',
                'GET',
                undefined,
                undefined,
                undefined,
                { 'x-forwarded-for': '8.8.4.4' },
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count FROM rate_limits WHERE key='api:8.8.4.4'",
              )
            ).rows[0].count,
            160,
          );
        } finally {
          if (previousSecret === undefined)
            delete process.env.PROXY_IDENTITY_SECRET;
          else process.env.PROXY_IDENTITY_SECRET = previousSecret;
          if (previousPeers === undefined)
            delete process.env.TRUSTED_PROXY_PEERS;
          else process.env.TRUSTED_PROXY_PEERS = previousPeers;
        }
      },
    );
    await t.test(
      'Operations and metrics require admin authorization and expose aggregates without payloads',
      async () => {
        assert.equal((await call('/admin/operations')).status, 401);
        assert.equal(
          (await call('/admin/operations/metrics', 'GET', undefined, owner))
            .status,
          403,
        );
        await pool.query(
          "INSERT INTO ai_usage(capability,mode,reason,attempts,latency_ms,cost_micros,input_tokens,output_tokens,prompt_version,model_version,rule_version) SELECT 'search','fallback','disabled',0,0,0,0,0,'fixture','fixture','fixture' FROM generate_series(1,6)",
        );
        const response = await call(
          '/admin/operations',
          'GET',
          undefined,
          admin,
        );
        assert.equal(response.status, 200);
        const snapshot = response.data as {
          queues: unknown[];
          flags: unknown[];
          dependencies: string;
        };
        assert.ok(
          Array.isArray(snapshot.queues) && Array.isArray(snapshot.flags),
        );
        assert.equal(snapshot.dependencies, 'ok');
        assert.ok(!JSON.stringify(snapshot).includes('example.test'));
        const metrics = await call(
          '/admin/operations/metrics',
          'GET',
          undefined,
          admin,
        );
        assert.equal(metrics.status, 200);
        const text = String(metrics.data);
        assert.ok(text.includes('raui_http_duration_seconds_bucket'));
        assert.ok(text.includes('raui_queue_jobs'));
        assert.ok(text.includes('raui_ai_fallbacks_hour 6'));
        assert.ok(
          text.includes('raui_provider_failures_hour{provider="ai"} 0'),
        );

        assert.ok(
          !text.includes('sessionToken') && !text.includes('example.test'),
        );
        assert.match(
          response.headers.get('traceparent') ?? '',
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-00$/,
        );
      },
    );
    await t.test('buyer role and global rate limits are enforced', async () => {
      buyer = await account('buyer', 'buyer');
      assert.equal(
        (
          await call(
            '/properties',
            'POST',
            { category: 'apartment', address },
            buyer,
            'buyer-property',
          )
        ).status,
        403,
      );
      await db.pool.query(
        "UPDATE rate_limits SET count=500 WHERE key LIKE 'api:%'",
      );
      assert.equal((await call('/categories')).status, 429);
    });
    await t.test(
      'physical objects persist true PostGIS coordinates and protected editable attributes',
      async () => {
        physical = await property(owner, 'physical-object');
        const row = (
          await pool.query(
            'SELECT ST_SRID(point) AS srid,ST_X(point) AS lon,ST_Y(point) AS lat FROM addresses a JOIN properties p ON p.address_id=a.id WHERE p.id=$1',
            [physical.id],
          )
        ).rows[0];
        assert.equal(row.srid, 4326);
        assert.equal(row.lon, address.longitude);
        assert.equal(row.lat, address.latitude);
        assert.equal(
          (await call(`/properties/${physical.id}`, 'GET', undefined, other))
            .status,
          403,
        );
        assert.equal(
          (
            await call(
              '/properties',
              'POST',
              { category: 'apartment', address, attributes: { unknown: 3 } },
              owner,
              'unknown-field',
            )
          ).status,
          400,
        );
        physical = await ok<Entity>(
          `/properties/${physical.id}`,
          'PATCH',
          {
            version: physical.version,
            address: { ...address, longitude: 37.6, latitude: 55.7 },
          },
          owner,
        );
        assert.equal(
          (
            await ok<{ address: { longitude: number } }>(
              `/properties/${physical.id}`,
              'GET',
              undefined,
              owner,
            )
          ).address.longitude,
          37.6,
        );
      },
    );
    await t.test(
      'Property, Listing and ListingSource remain distinct; drafts autosave with optimistic concurrency and idempotency',
      async () => {
        listing = await ok<Entity>(
          '/listings',
          'POST',
          { propertyId: physical.id, dealType: 'sale' },
          owner,
          'draft-listing',
        );
        assert.notEqual(listing.id, listing.property_id);
        assert.notEqual(listing.id, listing.source_id);
        const repeated = await ok<Entity>(
          '/listings',
          'POST',
          { propertyId: physical.id, dealType: 'sale' },
          owner,
          'draft-listing',
        );
        assert.equal(repeated.id, listing.id);
        assert.equal(
          (
            await call(
              '/listings',
              'POST',
              { propertyId: physical.id, dealType: 'long_rent' },
              owner,
              'draft-listing',
            )
          ).status,
          409,
        );
        const before = listing.version;
        listing = await ok<Entity>(
          `/listings/${listing.id}`,
          'PATCH',
          {
            version: before,
            title: 'Квартира в Москве',
            price: 15000000,
            description: 'Описание',
          },
          owner,
        );
        assert.equal(
          (
            await call(
              `/listings/${listing.id}`,
              'PATCH',
              { version: before, price: 1 },
              owner,
            )
          ).status,
          409,
        );
        assert.equal(
          (await call(`/listings/${listing.id}`, 'GET', undefined, other))
            .status,
          403,
        );
        assert.equal(
          (
            await call(
              `/listings/${listing.id}/transitions`,
              'POST',
              { version: listing.version, status: 'published' },
              owner,
              'bypass-publish',
            )
          ).status,
          400,
        );
        assert.equal(
          (await call(`/listings/${listing.id}/public`)).status,
          404,
        );
      },
    );
    let mediaId: string;
    await t.test(
      'async object-storage pipeline produces stripped responsive WebP/AVIF and private originals',
      async () => {
        const image = await sharp({
          create: {
            width: 300,
            height: 150,
            channels: 3,
            background: '#336699',
          },
        })
          .jpeg()
          .withMetadata({ orientation: 6 })
          .toBuffer();
        assert.equal(
          (
            await call(
              '/media',
              'POST',
              {
                listingId: listing.id,
                filename: 'fake.jpg',
                mime: 'image/jpeg',
                base64: Buffer.from('<script/>').toString('base64'),
              },
              owner,
              'fake-image',
            )
          ).status,
          400,
        );
        const uploaded = await ok<{ id: string }>(
          '/media',
          'POST',
          {
            listingId: listing.id,
            filename: 'photo.jpg',
            mime: 'image/jpeg',
            base64: image.toString('base64'),
          },
          owner,
          'upload-photo',
        );
        mediaId = uploaded.id;
        assert.equal((await call(`/media/${mediaId}/thumb`)).status, 404);
        const claims = await Promise.all([worker.once(), worker.once()]);
        assert.equal(claims.filter(Boolean).length, 1);
        const row = (
          await pool.query('SELECT * FROM media WHERE id=$1', [mediaId])
        ).rows[0];
        assert.equal(row.state, 'ready');
        assert.equal(row.content_sha256, hash(image));
        assert.deepEqual(Object.keys(row.variants).sort(), [
          'avif',
          'large',
          'small',
          'thumb',
        ]);
        const processed = await storage.get(row.variants.large.key);
        const metadata = await sharp(processed).metadata();
        assert.equal(metadata.format, 'webp');
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.orientation, undefined);
        assert.equal(metadata.width, 150);
        assert.equal(metadata.height, 300);
        assert.equal(
          (await call(`/media/${mediaId}/thumb`, 'GET', undefined, other))
            .status,
          403,
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}`,
          'GET',
          undefined,
          owner,
        );
      },
    );
    await t.test(
      'moderation gate allows only authorized publication and records immutable history/audit',
      async () => {
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'processing' },
          owner,
          'submit-processing',
        );
        assert.equal(
          (
            await call(
              `/listings/${listing.id}`,
              'PATCH',
              { version: listing.version, price: 1 },
              owner,
            )
          ).status,
          409,
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'moderation' },
          owner,
          'submit-moderation',
        );
        const cases = await ok<Array<{ id: string }>>(
          '/admin/moderation',
          'GET',
          undefined,
          admin,
        );
        const id = cases[0]!.id;
        assert.equal(
          (
            await call(
              `/admin/moderation/${id}/decision`,
              'POST',
              { decision: 'approve', reason: 'valid listing' },
              owner,
              'owner-moderate',
            )
          ).status,
          403,
        );
        const decision = await ok<{ status: string }>(
          `/admin/moderation/${id}/decision`,
          'POST',
          { decision: 'approve', reason: 'valid listing' },
          admin,
          'approve-listing',
        );
        assert.equal(decision.status, 'published');
        assert.equal(
          (await call(`/listings/${listing.id}/public`)).status,
          200,
        );
        assert.equal(
          (await fetch(`${base}/v1/media/${mediaId}/thumb`)).status,
          200,
        );
        const history = await ok<Array<{ event: string }>>(
          `/listings/${listing.id}/history`,
          'GET',
          undefined,
          owner,
        );
        assert.ok(history.some((h) => h.event === 'listing.fields.changed'));
        assert.ok(history.some((h) => h.event === 'moderation.decided'));
        assert.ok(
          (await ok<unknown[]>('/admin/audit', 'GET', undefined, admin))
            .length > 0,
        );
        await assert.rejects(
          pool.query(
            "UPDATE listing_history SET event='tampered' WHERE listing_id=$1",
            [listing.id],
          ),
          /append-only/,
        );
      },
    );
    await t.test(
      'changes withdraw publication; sold/rented are deal-specific terminal states',
      async () => {
        listing = await ok<Entity>(
          `/listings/${listing.id}`,
          'GET',
          undefined,
          owner,
        );
        assert.equal(
          (
            await call(
              `/properties/${physical.id}`,
              'PATCH',
              { version: physical.version, attributes: { area: 60 } },
              owner,
            )
          ).status,
          409,
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'paused' },
          owner,
          'pause-listing',
        );
        assert.equal(
          (await call(`/listings/${listing.id}/public`)).status,
          404,
        );
        assert.equal(
          (
            await call(
              `/listings/${listing.id}/transitions`,
              'POST',
              { version: listing.version, status: 'rented' },
              owner,
              'wrong-deal',
            )
          ).status,
          400,
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}`,
          'PATCH',
          { version: listing.version, price: 14000000 },
          owner,
        );
        assert.equal(listing.status, 'draft');
      },
    );
    await t.test(
      'resubmission requires moderation and terminal offers survive later physical corrections',
      async () => {
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'processing' },
          owner,
          'resubmit-process',
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'moderation' },
          owner,
          'resubmit-review',
        );
        const cases = await ok<Array<{ id: string; listing_id: string }>>(
          '/admin/moderation',
          'GET',
          undefined,
          admin,
        );
        const pending = cases.find((c) => c.listing_id === listing.id)!;
        await ok(
          `/admin/moderation/${pending.id}/decision`,
          'POST',
          { decision: 'approve', reason: 'Updated price reviewed' },
          admin,
          'resubmit-approve',
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}`,
          'GET',
          undefined,
          owner,
        );
        listing = await ok<Entity>(
          `/listings/${listing.id}/transitions`,
          'POST',
          { version: listing.version, status: 'sold' },
          owner,
          'finalize-sold',
        );
        assert.equal(
          (
            await call(
              `/listings/${listing.id}/transitions`,
              'POST',
              { version: listing.version, status: 'draft' },
              owner,
              'reopen-sold',
            )
          ).status,
          409,
        );
        physical = await ok<Entity>(
          `/properties/${physical.id}`,
          'PATCH',
          { version: physical.version, attributes: { area: 60 } },
          owner,
        );
        assert.equal(
          (await ok<Entity>(`/listings/${listing.id}`, 'GET', undefined, owner))
            .status,
          'sold',
        );
      },
    );
    await t.test(
      'professional membership and complex/building/section/floor/unit hierarchy enforce organization boundaries',
      async () => {
        const developer = await account('developer', 'developer');
        const organization = await ok<{ id: string }>(
          '/organizations',
          'POST',
          { name: 'Застройщик', kind: 'developer' },
          developer,
          'developer-org',
        );
        assert.equal(
          (
            await call(
              '/properties',
              'POST',
              {
                organizationId: organization.id,
                category: 'new_build',
                address,
              },
              other,
              'foreign-org',
            )
          ).status,
          403,
        );
        await ok(
          `/organizations/${organization.id}/members`,
          'PATCH',
          { userId: other.user.id, role: 'member', active: true },
          developer,
        );
        const complex = await ok<{ id: string }>(
          '/structures/complexes',
          'POST',
          { organizationId: organization.id, name: 'ЖК', address },
          other,
          'new-complex',
        );
        const building = await ok<{ id: string }>(
          '/structures/buildings',
          'POST',
          {
            organizationId: organization.id,
            complexId: complex.id,
            name: 'Корпус 1',
            address,
          },
          other,
          'new-building',
        );
        const section = await ok<{ id: string }>(
          '/structures/sections',
          'POST',
          { buildingId: building.id, name: 'Секция 1' },
          other,
          'new-section',
        );
        const floor = await ok<{ id: string }>(
          '/structures/floors',
          'POST',
          { sectionId: section.id, number: 2 },
          other,
          'new-floor',
        );
        const unit = await property(other, 'new-unit', organization.id, {
          category: 'new_build',
          buildingId: building.id,
          floorId: floor.id,
          unitNumber: '23',
        });
        const offer = await ok<Entity>(
          '/listings',
          'POST',
          {
            propertyId: unit.id,
            dealType: 'sale',
            title: 'Квартира',
            price: 100,
          },
          other,
          'developer-offer',
        );
        assert.equal(
          (
            await pool.query('SELECT kind FROM listing_sources WHERE id=$1', [
              offer.source_id,
            ])
          ).rows[0].kind,
          'developer',
        );
        assert.equal(
          (
            await call(
              `/organizations/${organization.id}/members`,
              'PATCH',
              { userId: owner.user.id, role: 'admin', active: true },
              other,
            )
          ).status,
          403,
        );
        await ok(
          `/organizations/${organization.id}/members`,
          'PATCH',
          { userId: other.user.id, role: 'member', active: false },
          developer,
        );
        assert.equal(
          (await call(`/listings/${offer.id}`, 'GET', undefined, other)).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/listings',
              'POST',
              {
                propertyId: unit.id,
                dealType: 'sale',
                title: 'Квартира',
                price: 100,
              },
              other,
              'developer-offer',
            )
          ).status,
          403,
        );
        await ok(
          `/admin/organizations/${organization.id}`,
          'PATCH',
          { active: false },
          admin,
        );
        assert.equal(
          (
            await call(
              `/structures/${organization.id}`,
              'GET',
              undefined,
              developer,
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      'media retries, dead-letter recovery and storage path protection',
      async () => {
        const offer = await ok<Entity>(
          '/listings',
          'POST',
          { propertyId: physical.id, dealType: 'sale' },
          owner,
          'fault-offer',
        );
        const image = await sharp({
          create: { width: 20, height: 20, channels: 3, background: '#fff' },
        })
          .png()
          .toBuffer();
        const asset = await ok<{ id: string }>(
          '/media',
          'POST',
          {
            listingId: offer.id,
            filename: 'fault.png',
            mime: 'image/png',
            base64: image.toString('base64'),
          },
          owner,
          'fault-upload',
        );
        const row = (
          await pool.query('SELECT original_key FROM media WHERE id=$1', [
            asset.id,
          ])
        ).rows[0];
        await storage.delete(row.original_key);
        for (let i = 0; i < 3; i++) {
          assert.ok(await worker.once());
          await pool.query(
            'UPDATE media_jobs SET available_at=now() WHERE media_id=$1',
            [asset.id],
          );
        }
        const dead = (
          await pool.query(
            'SELECT id,state,attempts FROM media_jobs WHERE media_id=$1',
            [asset.id],
          )
        ).rows[0];
        assert.equal(dead.state, 'dead');
        assert.equal(dead.attempts, 3);
        await storage.put(row.original_key, image, 'image/png');
        await ok(
          `/admin/media-jobs/${dead.id}/retry`,
          'POST',
          {},
          admin,
          'retry-dead-media',
        );
        assert.ok(await worker.once());
        assert.equal(
          (await pool.query('SELECT state FROM media WHERE id=$1', [asset.id]))
            .rows[0].state,
          'ready',
        );
        await assert.rejects(storage.get('../outside.png'));
        await assert.rejects(storage.get('/tmp/outside.png'));
      },
    );
    await t.test(
      'admin deactivation revokes sessions and remains audited',
      async () => {
        const response = await ok<{ id: string }>(
          `/admin/users/${buyer.user.id}`,
          'PATCH',
          { active: false },
          admin,
        );
        assert.equal(response.id, buyer.user.id);
        assert.equal(
          (await call('/auth/me', 'GET', undefined, buyer)).status,
          401,
        );
        const rows = await ok<Array<{ action: string }>>(
          `/admin/audit?entityId=${buyer.user.id}`,
          'GET',
          undefined,
          admin,
        );
        assert.ok(rows.some((row) => row.action === 'admin.user.changed'));
      },
    );
    await t.test(
      'cookie auth has CSRF protection; logout and password reset revoke sessions; tokens are single-use',
      async () => {
        const email = 'owner@example.test';
        const login = await call('/auth/login', 'POST', {
          email,
          password: 'correct-long-password',
        });
        assert.equal(login.status, 201);
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
        assert.equal(
          (login.data as { sessionToken?: string }).sessionToken,
          undefined,
        );
        assert.equal(
          (
            await call('/auth/logout', 'POST', {}, undefined, undefined, {
              Cookie: cookie,
            })
          ).status,
          403,
        );
        const csrf = (login.data as { csrfToken: string }).csrfToken;
        assert.equal(
          (
            await call('/auth/logout', 'POST', {}, undefined, undefined, {
              Cookie: cookie,
              Origin: process.env.WEB_ORIGIN!,
              'X-CSRF-Token': csrf,
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await call('/auth/me', 'GET', undefined, undefined, undefined, {
              Cookie: cookie,
            })
          ).status,
          401,
        );
        const unknown = await ok('/auth/password-reset', 'POST', {
          email: 'unknown@example.test',
        });
        assert.deepEqual(unknown, { accepted: true });
        await ok('/auth/password-reset', 'POST', { email });
        const reset = delivery.latest(email, 'reset');
        await ok('/auth/password-reset/confirm', 'POST', {
          token: reset,
          password: 'new-long-password',
        });
        assert.equal(
          (await call('/auth/me', 'GET', undefined, owner)).status,
          401,
        );
        assert.equal(
          (
            await call('/auth/password-reset/confirm', 'POST', {
              token: reset,
              password: 'new-long-password',
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call('/auth/login', 'POST', {
              email,
              password: 'correct-long-password',
            })
          ).status,
          401,
        );
        const next = await ok<Session>('/auth/login', 'POST', {
          email,
          password: 'new-long-password',
          transport: 'bearer',
        });
        await ok('/auth/logout-all', 'POST', {}, next);
        assert.equal(
          (await call('/auth/me', 'GET', undefined, next)).status,
          401,
        );
      },
    );
    await t.test('OpenAPI exposes versioned core operations', async () => {
      const response = await fetch(`${base}/v1/openapi.json`);
      assert.equal(response.status, 200);
      const schema = (await response.json()) as {
        paths: Record<string, unknown>;
      };
      assert.ok(schema.paths['/v1/auth/register']);
      assert.ok(schema.paths['/v1/properties']);
      const propertyContract = schema.paths['/v1/properties'] as {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { required: string[] } } };
          };
        };
      };
      assert.ok(
        propertyContract.post.requestBody.content[
          'application/json'
        ].schema.required.includes('address'),
      );
      assert.ok(schema.paths['/v1/admin/moderation/{id}/decision']);
      const anonymous = new Set(
        `get /health
get /health/ready
get /v1/categories
get /v1/categories/{code}/attributes
get /v1/listings/{id}/public
get /v1/media/{id}/{variant}
get /v1/search/sitemap
post /v1/search
post /v1/search/selection
post /v1/search/map
post /v1/geo/layers
post /v1/commerce/webhook
post /v1/auth/register
post /v1/auth/login
post /v1/auth/verification/email/confirm
post /v1/auth/password-reset
post /v1/auth/password-reset/confirm`.split('\n'),
      );
      const partner = new Set(
        `get /v1/partner/listings
post /v1/partner/feeds/{id}/apply
post /v1/partner/listings/bulk-pause`.split('\n'),
      );
      const keys = new Set(
        `post /v1/organizations
post /v1/properties
post /v1/listings
post /v1/listings/{id}/transitions
post /v1/media
post /v1/structures/complexes
post /v1/structures/buildings
post /v1/structures/sections
post /v1/structures/floors
post /v1/admin/media-jobs/{id}/retry
post /v1/admin/moderation/{id}/decision
post /v1/trust/listings/{id}/scan
post /v1/admin/trust/listings/{id}/decision
post /v1/admin/trust/candidates/{id}/decision
post /v1/organizations/{organizationId}/feeds
post /v1/organizations/{organizationId}/feeds/{feedId}/dry-run
post /v1/organizations/{organizationId}/feeds/{feedId}/apply
post /v1/organizations/{organizationId}/professional/portfolios
post /v1/organizations/{organizationId}/professional/portfolios/{portfolioId}/listings
post /v1/organizations/{organizationId}/professional/listings/bulk-pause
post /v1/organizations/{organizationId}/professional/partner-clients
post /v1/partner/feeds/{id}/apply
post /v1/partner/listings/bulk-pause
post /v1/commerce/orders
post /v1/commerce/ads/campaigns/{id}/events
post /v1/commerce/reconciliation/{id}/retry
post /v1/commerce/promotions/activate
post /v1/commerce/ads/placements
post /v1/commerce/ads/campaigns
post /v1/commerce/promotions
patch /v1/commerce/promotions/{code}/{version}`.split('\n'),
      );
      const seen = new Set<string>();
      for (const [path, methods] of Object.entries(schema.paths)) {
        for (const [method, raw] of Object.entries(
          methods as Record<string, unknown>,
        )) {
          if (!['get', 'post', 'patch', 'delete', 'put'].includes(method))
            continue;
          const id = `${method} ${path}`;
          seen.add(id);
          const operation = raw as {
            security: unknown;
            parameters?: {
              in?: string;
              name?: string;
              required?: boolean;
              schema?: {
                minLength?: number;
                maxLength?: number;
                pattern?: string;
              };
            }[];
          };
          assert.deepEqual(
            operation.security,
            anonymous.has(id)
              ? []
              : partner.has(id)
                ? [{ partner: [] }]
                : [{ bearer: [] }, { cookie: [] }],
            id,
          );
          const headers = (operation.parameters ?? []).filter(
            (p) =>
              p.in === 'header' && p.name?.toLowerCase() === 'idempotency-key',
          );
          assert.equal(headers.length, keys.has(id) ? 1 : 0, id);
          if (keys.has(id)) {
            assert.equal(headers[0]!.required, true, id);
            assert.equal(headers[0]!.schema?.minLength, 8, id);
            const commerce = path.startsWith('/v1/commerce/');
            assert.equal(
              headers[0]!.schema?.maxLength,
              commerce ? 128 : 100,
              id,
            );
            assert.equal(
              headers[0]!.schema?.pattern,
              commerce ? '^[A-Za-z0-9._:-]{8,128}$' : '^[A-Za-z0-9_-]{8,100}$',
              id,
            );
          }
        }
      }
      for (const id of new Set([...anonymous, ...partner, ...keys]))
        assert.ok(seen.has(id), `Missing operation ${id}`);
      const geo = await fetch(`${base}/v1/geo/layers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bounds: [37.5, 55.6, 37.7, 55.8] }),
      });
      assert.equal(geo.status, 201);
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
