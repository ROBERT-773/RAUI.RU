import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import sharp from 'sharp';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { hash, token } from './common/security';
import { migrate } from './modules/database/migrate';
import { ObjectStorage } from './modules/media/storage';
import { FeedPhotos } from './modules/professional/feed-photos';

test('profile images follow editor permissions, public visibility, and versioned storage cleanup', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  t.after(() => db.end());
  await t.test(
    '042 preserves an existing published profile from 041 and can be reapplied',
    async () => {
      const oldMigrations = join(
        process.env.LOCAL_PRIVATE_DIR!,
        'profile-before-042',
      );
      await mkdir(oldMigrations, { recursive: true });
      for (const filename of await readdir('migrations')) {
        if (/^\d+_.+\.sql$/.test(filename) && filename < '042_')
          await copyFile(
            join('migrations', filename),
            join(oldMigrations, filename),
          );
      }
      await migrate(db, oldMigrations);
      const oldAgent = await user('agent');
      const oldProfile = randomUUID();
      await db.query(
        "INSERT INTO public_professional_profiles(id,agent_id,display_name,published_at) VALUES($1,$2,'Прежний агент',now())",
        [oldProfile, oldAgent.id],
      );
      await db.query(
        "INSERT INTO public_professional_regions(profile_id,region_code) VALUES($1,'moscow')",
        [oldProfile],
      );
      const read = () =>
        db.query(
          'SELECT to_jsonb(p) AS profile,r.region_code FROM public_professional_profiles p JOIN public_professional_regions r ON r.profile_id=p.id WHERE p.id=$1',
          [oldProfile],
        );
      const before = (await read()).rows[0]!;
      await migrate(db);
      await migrate(db);
      assert.deepEqual((await read()).rows, [
        { ...before, profile: { ...before.profile, image_id: null } },
      ]);
    },
  );
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  t.after(() => app.close());
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/v1/search/';
  async function user(role: string) {
    const id = randomUUID(),
      secret = token();
    await db.query(
      "INSERT INTO users(id,email,password_hash,display_name,role,registration_approval_state,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Test',$3,'approved',now(),now())",
      [id, id + '@test.invalid', role],
    );
    await db.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [id, hash(secret), hash(token())],
    );
    return { id, secret };
  }
  function call(
    path: string,
    actor?: { secret: string },
    method = 'GET',
    body?: unknown,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(actor ? { Authorization: 'Bearer ' + actor.secret } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const agent = await user('agent'),
    manager = await user('agency'),
    member = await user('agent');
  const org = randomUUID(),
    own = 'professional-profile',
    agency = own + '/agency/' + org;
  await db.query(
    "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Test','agency',$2)",
    [org, manager.id],
  );
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role,active) VALUES($1,$2,'owner',true),($1,$3,'member',true)",
    [org, manager.id, member.id],
  );
  const pixels = await sharp({
    create: {
      width: 640,
      height: 320,
      channels: 4,
      background: { r: 0, g: 20, b: 100, alpha: 0.5 },
    },
  })
    .png()
    .withMetadata()
    .toBuffer();
  const upload = {
    filename: 'identity.png',
    mime: 'image/png',
    base64: pixels.toString('base64'),
    expectedImageId: null as string | null,
  };
  const form = { name: 'Профиль', regionCodes: ['moscow'], published: false };
  assert.equal((await call(own + '/image', agent, 'PUT', upload)).status, 404);
  const create = await call(own, agent, 'PATCH', form);
  assert.equal(create.status, 200);
  const { id } = (await create.json()) as { id: string };
  const publicId = async () =>
    (
      (await (await call('professionals/' + id)).json()) as {
        imageId: string | null;
      }
    ).imageId;
  const added = await call(own + '/image', agent, 'PUT', upload);
  assert.equal(added.status, 200);
  const { imageId: first } = (await added.json()) as { imageId: string };
  const path = 'professionals/' + id + '/image/';
  assert.equal(
    (
      (await (await call(own, agent)).json()) as {
        profile: { imageId: string };
      }
    ).profile.imageId,
    first,
  );
  const res = await call(own + '/image/' + first, agent);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const img = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.deepEqual(
    [img.format, img.width, img.height, img.hasAlpha, img.exif],
    ['webp', 512, 256, true, undefined],
  );
  assert.equal((await call(own + '/image/' + first)).status, 401);
  assert.equal((await call(own + '/image/' + first, member)).status, 404);
  assert.equal((await call(path + first)).status, 404);
  assert.equal(
    (await call(own, agent, 'PATCH', { ...form, published: true })).status,
    200,
  );
  assert.equal(await publicId(), first);
  assert.equal((await call(path + first)).status, 200);
  assert.equal(
    (
      await call(own + '/image', agent, 'PUT', {
        ...upload,
        expectedImageId: first,
        base64: Buffer.from('invalid').toString('base64'),
      })
    ).status,
    400,
  );
  assert.equal((await call(own + '/image', agent, 'PUT', upload)).status, 409);
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      call(own + '/image', agent, 'PUT', { ...upload, expectedImageId: first }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const replace = concurrent.find((r) => r.status === 200)!;
  const { imageId: second } = (await replace.json()) as { imageId: string };
  assert.notEqual(first, second);
  assert.equal(await publicId(), second);
  assert.equal((await call(path + first)).status, 404);
  assert.equal((await call(path + second)).status, 200);
  assert.equal(
    (await call(own + '/image/' + first, agent, 'DELETE')).status,
    409,
  );
  const storage = app.get(ObjectStorage),
    save = storage.put.bind(storage);
  const broken = t.mock.method(
    storage,
    'put',
    async (key: string, bytes: Buffer, mime: string) => {
      await save(key, bytes, mime);
      throw new Error('storage operation interrupted');
    },
  );
  assert.equal(
    (
      await call(own + '/image', agent, 'PUT', {
        ...upload,
        expectedImageId: second,
      })
    ).status,
    503,
  );
  broken.mock.restore();
  assert.equal((await call(path + second)).status, 200);
  await db.query('UPDATE users SET phone_verified_at=NULL WHERE id=$1', [
    agent.id,
  ]);
  assert.equal((await call(path + second)).status, 404);
  await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1', [
    agent.id,
  ]);
  assert.deepEqual(
    await (await call(own + '/image/' + second, agent, 'DELETE')).json(),
    { imageId: null },
  );
  assert.equal(await publicId(), null);
  assert.equal((await call(path + second)).status, 404);
  const orgProfile = await call(agency, manager, 'PATCH', {
    ...form,
    published: true,
  });
  assert.equal(orgProfile.status, 200);
  const orgId = ((await orgProfile.json()) as { id: string }).id;
  assert.equal(
    (await call(agency + '/image', member, 'PUT', upload)).status,
    403,
  );
  const orgRes = await call(agency + '/image', manager, 'PUT', upload);
  assert.equal(orgRes.status, 200);
  const logo = ((await orgRes.json()) as { imageId: string }).imageId;
  const publicLogo = 'professionals/' + orgId + '/image/' + logo;
  assert.equal((await call(publicLogo)).status, 200);
  const revoked = t.mock.method(
    storage,
    'put',
    async (key: string, bytes: Buffer, mime: string) => {
      await save(key, bytes, mime);
      await db.query(
        'UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2',
        [org, manager.id],
      );
    },
  );
  assert.equal(
    (
      await call(agency + '/image', manager, 'PUT', {
        ...upload,
        expectedImageId: logo,
      })
    ).status,
    403,
  );
  revoked.mock.restore();
  assert.equal((await call(publicLogo)).status, 200);
  assert.equal((await call(agency + '/image/' + logo, manager)).status, 403);
  assert.equal(
    (await call(agency + '/image/' + logo, manager, 'DELETE')).status,
    403,
  );
  await db.query('UPDATE organizations SET active=false WHERE id=$1', [org]);
  assert.equal((await call(publicLogo)).status, 404);
  const keys = (
    await db.query<{ object_keys: string[] }>(
      'SELECT object_keys FROM professional_photo_cleanup',
    )
  ).rows.flatMap((row) => row.object_keys);
  assert.ok(keys.length >= 3);
  assert.ok(!keys.includes('profile-images/' + logo + '.webp'));
  const worker = app.get(FeedPhotos);
  const remove = storage.delete.bind(storage);
  const retry = keys[0]!;
  const unavailable = t.mock.method(storage, 'delete', async (key: string) => {
    if (key === retry) throw new Error('storage unavailable');
    await remove(key);
  });
  await worker.cleanup();
  unavailable.mock.restore();
  assert.equal(
    (
      await db.query(
        'SELECT media_id FROM professional_photo_cleanup WHERE $1=ANY(object_keys)',
        [retry],
      )
    ).rowCount,
    1,
  );
  await db.query(
    'UPDATE professional_photo_cleanup SET available_at=now() WHERE $1=ANY(object_keys)',
    [retry],
  );
  await worker.cleanup();
  for (const key of keys) await assert.rejects(storage.get(key));
  assert.ok((await storage.get('profile-images/' + logo + '.webp')).length > 0);
});
