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
          '8',
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
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
