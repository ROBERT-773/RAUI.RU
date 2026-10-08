import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { hash, token } from './common/security';
import { ObjectStorage } from './modules/media/storage';

test('delegated moderation permissions require explicit admin grants and respect immediate revocation', async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function account(role: 'admin' | 'owner') {
    const id = randomUUID(),
      secret = token();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Fixture',$3,now(),now())",
      [id, `${id}@example.test`, role],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [id, hash(secret), hash(token())],
    );
    return { id, secret };
  }
  async function call(
    path: string,
    actor: { secret: string },
    method = 'GET',
    body?: unknown,
  ) {
    return fetch(`${base}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${actor.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const mediaKey = `staff-fixture/${randomUUID()}.jpg`;
  try {
    const admin = await account('admin'),
      staff = await account('owner'),
      other = await account('owner');
    const permissions = `/admin/users/${staff.id}/permissions`;
    const grant = (permission: string, granted: boolean) =>
      call(permissions, admin, 'PATCH', {
        permission,
        granted,
        reason: 'Assigned moderation duty',
      });
    assert.equal((await call('/admin/moderation', staff)).status, 403);
    assert.equal((await grant('moderation.read', true)).status, 200);
    assert.equal((await call('/admin/moderation', staff)).status, 200);
    assert.equal((await call('/admin/users', staff)).status, 403);
    assert.equal((await call(permissions, staff)).status, 403);
    assert.equal(
      (
        await call(permissions, staff, 'PATCH', {
          permission: 'moderation.decide',
          granted: true,
          reason: 'Self grant attempt',
        })
      ).status,
      403,
    );
    assert.equal((await grant('admin', true)).status, 400);
    assert.equal(
      (
        await call(permissions, admin, 'PATCH', {
          permission: 'moderation.read',
          granted: true,
          reason: ' ',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(`/admin/users/${admin.id}/permissions`, admin, 'PATCH', {
          permission: 'moderation.read',
          granted: true,
          reason: 'Own privileges',
        })
      ).status,
      403,
    );
    const listed = await call(permissions, admin);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), {
      userId: staff.id,
      permissions: ['moderation.read'],
    });
    async function pending(seller: string) {
      const address = randomUUID(),
        property = randomUUID(),
        source = randomUUID(),
        listing = randomUUID(),
        id = randomUUID();
      await pool.query(
        "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Fixture','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
        [address],
      );
      await pool.query(
        "INSERT INTO properties(id,created_by,category_code,address_id) VALUES($1,$2,'apartment',$3)",
        [property, seller, address],
      );
      await pool.query(
        "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
        [source],
      );
      await pool.query(
        "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,title,status) VALUES($1,$2,$3,$4,'sale','Fixture listing','moderation')",
        [listing, property, source, seller],
      );
      await pool.query(
        'INSERT INTO moderation_cases(id,listing_id,listing_version) VALUES($1,$2,1)',
        [id, listing],
      );
      return id;
    }
    const otherCase = await pending(other.id),
      ownCase = await pending(staff.id);
    const decide = (id: string) =>
      call(`/admin/moderation/${id}/decision`, staff, 'POST', {
        decision: 'reject',
        reason: 'Listing information requires correction',
      });
    const materials = await call(
      `/admin/moderation/${otherCase}/materials`,
      staff,
    );
    assert.equal(materials.status, 200);
    const materialData = (await materials.json()) as {
      listing: { id: string };
    };
    assert.deepEqual(Object.keys(materialData).sort(), [
      'caseId',
      'listing',
      'listingVersion',
      'media',
      'property',
    ]);
    assert.deepEqual(Object.keys(materialData.listing).sort(), [
      'deal_type',
      'description',
      'id',
      'price',
      'title',
      'version',
    ]);
    assert.equal(
      (await call(`/listings/${materialData.listing.id}`, staff)).status,
      403,
    );
    const mediaId = randomUUID();
    await app
      .get(ObjectStorage)
      .put(mediaKey, Buffer.from('fixture image'), 'image/jpeg');
    await pool.query(
      "INSERT INTO media(id,listing_id,uploaded_by,kind,original_key,mime,state,variants) VALUES($1,$2,$3,'photo',$4,'image/jpeg','ready',$5)",
      [
        mediaId,
        materialData.listing.id,
        other.id,
        mediaKey,
        JSON.stringify({ small: { key: mediaKey, mime: 'image/jpeg' } }),
      ],
    );
    const image = await call(
      `/admin/moderation/${otherCase}/media/${mediaId}/small`,
      staff,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.equal(await image.text(), 'fixture image');
    assert.equal(
      (await call(`/admin/moderation/${ownCase}/media/${mediaId}/small`, staff))
        .status,
      404,
    );

    await pool.query('UPDATE users SET phone_verified_at=NULL WHERE id=$1', [
      staff.id,
    ]);
    assert.equal((await call('/admin/moderation', staff)).status, 403);
    await pool.query(
      'UPDATE users SET phone_verified_at=now(),active=false WHERE id=$1',
      [staff.id],
    );
    assert.equal((await call('/admin/moderation', staff)).status, 401);
    await pool.query('UPDATE users SET active=true WHERE id=$1', [staff.id]);
    assert.equal(
      (await call(`/admin/moderation/${randomUUID()}/materials`, staff)).status,
      404,
    );
    assert.equal((await decide(otherCase)).status, 403);
    assert.equal((await grant('moderation.decide', true)).status, 200);
    assert.equal((await decide(ownCase)).status, 403);
    assert.equal((await decide(otherCase)).status, 201);
    assert.equal(
      (await call(`/admin/moderation/${otherCase}/materials`, staff)).status,
      404,
    );
    assert.equal((await grant('moderation.read', false)).status, 200);
    assert.equal(
      (
        await call(
          `/admin/moderation/${otherCase}/media/${mediaId}/small`,
          staff,
        )
      ).status,
      403,
    );
    assert.equal((await call('/admin/moderation', staff)).status, 403);
    assert.equal((await grant('moderation.decide', false)).status, 200);
    assert.equal((await decide(await pending(other.id))).status, 403);
    assert.equal((await call('/admin/moderation', admin)).status, 200);
    const row = (
      await pool.query('SELECT role FROM users WHERE id=$1', [staff.id])
    ).rows[0];
    assert.equal(row.role, 'owner');
    const audit = await pool.query(
      "SELECT data FROM audit_events WHERE entity_id=$1 AND action='admin.staff.permission.changed' ORDER BY id",
      [staff.id],
    );
    assert.equal(audit.rowCount, 4);
    assert.equal(audit.rows[3].data.granted, false);
  } finally {
    await app.get(ObjectStorage).delete(mediaKey);
    await app.close();
    await pool.end();
  }
});
