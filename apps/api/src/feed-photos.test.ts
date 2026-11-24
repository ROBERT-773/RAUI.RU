import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from './modules/professional/feed-parser';
import { importItem } from './modules/professional/contracts';
import { FeedPhotos } from './modules/professional/feed-photos';
import { FeedPhotoFetcher } from './modules/professional/feed-photos-fetch';
import sharp from 'sharp';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from './config';
import { MediaWorker } from './modules/media/worker';
import { ConfiguredStorage } from './modules/media/storage';
import type { MediaRow } from './modules/media/media';

test('provider galleries preserve photos, plans, signed query parameters and the default photo', () => {
  const cover = 'https://cdn.example/cover.jpg?x=1&y=2',
    plan = 'https://cdn.example/plan.png';
  const escaped = cover.replace('&', '&amp;'),
    gallery = [
      { url: cover, kind: 'photo' },
      { url: plan, kind: 'floor_plan' },
    ];
  for (const xml of [
    `<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06"><offer internal-id="1"><image>${escaped}</image><image tag="floor-plan">${plan}</image></offer></realty-feed>`,
    `<Feed><Feed_Version>2</Feed_Version><Object><Photos><PhotoSchema><FullUrl>${escaped}</FullUrl><IsDefault>true</IsDefault></PhotoSchema></Photos><LayoutPhoto><FullUrl>${plan}</FullUrl><IsDefault>false</IsDefault></LayoutPhoto></Object></Feed>`,
    `<complexes><complex><images><image>${escaped}</image></images><buildings><building><flats><flat><plans><plan>${plan}</plan></plans></flat></flats></building></buildings></complex></complexes>`,
  ]) {
    const [row] = parseFeed(xml, 'xml', {}) as { photos: unknown }[];
    assert.deepEqual(importItem.shape.photos.parse(row!.photos), gallery);
  }
  const avito = `<Ads formatVersion="3" target="Avito.ru"><Ad><Images><Image url="${escaped}"/><Image url="https://cdn.example/flat.jpg"/></Images></Ad></Ads>`;
  const [row] = parseFeed(avito, 'xml', {}) as { photos: unknown }[];
  assert.deepEqual(row!.photos, [
    gallery[0],
    { url: 'https://cdn.example/flat.jpg', kind: 'photo' },
  ]);
  const cian = `<feed><feed_version>2</feed_version><object><Photos><PhotoSchema><FullUrl>https://cdn.example/second.jpg</FullUrl></PhotoSchema><PhotoSchema><FullUrl>${escaped}</FullUrl><IsDefault>true</IsDefault></PhotoSchema></Photos></object></feed>`;
  assert.partialDeepStrictEqual(parseFeed(cian, 'xml', {})[0], {
    photos: [
      gallery[0],
      { url: 'https://cdn.example/second.jpg', kind: 'photo' },
    ],
  });
});
test('photo fetches validate all resolved addresses and pin TLS to the selected address for an approved media host', async (t) => {
  const before = process.env.FEED_MEDIA_ALLOWED_HOSTS;
  process.env.FEED_MEDIA_ALLOWED_HOSTS = 'cdn.example';
  t.after(() => {
    if (before === undefined) delete process.env.FEED_MEDIA_ALLOWED_HOSTS;
    else process.env.FEED_MEDIA_ALLOWED_HOSTS = before;
  });
  const png = await sharp({
    create: { width: 3, height: 2, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  let local = false,
    status = 200,
    mime = 'image/png',
    requests = 0;
  t.mock.method(dns, 'lookup', async () => [
    { address: local ? '127.0.0.1' : '8.8.8.8', family: 4 },
  ]);
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (res: unknown) => void,
  ) => {
    requests++;
    assert.equal(url.hostname, 'cdn.example');
    assert.equal(options.servername, url.hostname);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.family, 4);
    options.lookup!(url.hostname, {}, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, '8.8.8.8');
    });
    return Object.assign(new EventEmitter(), {
      end() {
        callback(
          Object.assign(Readable.from([png]), {
            statusCode: status,
            headers: { 'content-type': mime },
          }),
        );
      },
    });
  }) as never);
  const fetcher = new FeedPhotoFetcher();
  const url = 'https://cdn.example/a.png';
  assert.deepEqual(await fetcher.fetch(url), { bytes: png, mime: 'image/png' });
  await assert.rejects(fetcher.fetch('https://other.example/a.png'));
  local = true;
  await assert.rejects(fetcher.fetch(url));
  local = false;
  assert.equal(requests, 1);
  status = 302;
  await assert.rejects(fetcher.fetch(url));
  status = 200;
  mime = 'text/html';
  await assert.rejects(fetcher.fetch(url));
});
test('real derivatives are reserved before writes; partial storage failures are retryable and committed keys survive release', async (t) => {
  const bytes = await sharp({
    create: { width: 7, height: 4, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const objects = new Map<string, Buffer>();
  const reservations = new Map<string, { keys: string[]; due: boolean }>();
  const db = {
    pool: {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.startsWith('INSERT INTO professional_photo_cleanup'))
          reservations.set(args[0] as string, {
            keys: args[1] as string[],
            due: false,
          });
        else if (
          sql.startsWith('UPDATE professional_photo_cleanup SET available_at')
        )
          for (const id of args[0] as string[]) {
            const r = reservations.get(id);
            if (r) r.due = true;
          }
        else if (sql.includes('WITH due AS'))
          return {
            rows: [...reservations]
              .filter(([, r]) => r.due)
              .map(([media_id, r]) => ({ media_id, object_keys: r.keys })),
          };
        else if (sql.startsWith('DELETE FROM professional_photo_cleanup'))
          reservations.delete(args[0] as string);
        else throw new Error('Unexpected SQL');
        return { rows: [] };
      },
    },
  };
  let failAt: string | undefined,
    failedDelete: string | undefined,
    payload = bytes;
  const storage = {
    get: async (key: string) => objects.get(key)!,
    put: async (key: string, value: Buffer) => {
      assert.ok([...reservations.values()].some((r) => r.keys.includes(key)));
      objects.set(key, value);
      if (key.endsWith(failAt ?? '!')) throw new Error('storage unavailable');
    },
    delete: async (key: string) => {
      if (key === failedDelete) throw new Error('delete unavailable');
      objects.delete(key);
    },
  };
  const photos = new FeedPhotos(db as never, storage, {
    fetch: async () => ({ bytes: payload, mime: 'image/png' }),
  });
  const input = { url: 'https://cdn.example/a.png', kind: 'photo' as const };
  const prepared = await photos.prepare([input]);
  assert.equal(objects.size, 5);
  for (const v of Object.values(prepared[0]!.variants)) {
    const meta = await sharp(objects.get(v.key)).metadata();
    assert.equal(meta.width, 7);
    assert.equal(meta.height, 4);
    assert.equal(meta.format, v.mime === 'image/avif' ? 'heif' : 'webp');
  }
  failedDelete = prepared[0]!.originalKey;
  const errorLog = t.mock.method(console, 'error', () => {});
  await photos.release(prepared);
  assert.equal(errorLog.mock.callCount(), 1);
  assert.deepEqual([...objects.keys()], [failedDelete]);
  assert.equal(reservations.size, 1);
  failedDelete = undefined;
  await photos.cleanup();
  assert.equal(objects.size, 0);
  assert.equal(reservations.size, 0);
  failAt = 'small.webp';
  await assert.rejects(photos.prepare([input]), /storage unavailable/);
  assert.equal(objects.size, 0);
  assert.equal(reservations.size, 0);
  failAt = undefined;
  payload = bytes.subarray(0, 64);
  assert.equal((await sharp(payload).metadata()).width, 7);
  await assert.rejects(photos.prepare([input]), /пиксели/);
  assert.equal(objects.size, 0);
  assert.equal(reservations.size, 0);
  payload = Buffer.from('not an image');
  await assert.rejects(photos.prepare([input]), /image/i);
  assert.equal(objects.size, 0);
  assert.equal(reservations.size, 0);
  payload = bytes;
  await assert.rejects(photos.prepare([input, input]), /повторяется/);
  assert.equal(objects.size, 0);
  const committed = await photos.prepare([input]);
  const media = committed[0]!;
  const writes: unknown[][] = [];
  const transaction = {
    query: async (statement: string, args: unknown[]) => {
      if (statement.startsWith('SELECT seller_id'))
        return { rows: [{ seller_id: 'seller' }], rowCount: 1 };
      if (statement.startsWith('SELECT id,kind')) return { rows: [] };
      if (statement.startsWith('SELECT count')) return { rows: [{ count: 0 }] };
      if (statement.startsWith('DELETE FROM professional_photo_cleanup'))
        return { rowCount: Number(reservations.delete(args[0] as string)) };
      if (statement.startsWith('INSERT INTO media')) {
        writes.push(args);
        return { rowCount: 1 };
      }
      throw new Error('Unexpected transition: ' + statement);
    },
  };
  assert.equal(
    await photos.replace(transaction as never, 'listing', committed),
    true,
  );
  assert.equal(writes[0]![0], media.id);
  assert.equal(reservations.size, 0);
  await photos.release(committed);
  assert.equal(objects.size, 5);
  assert.deepEqual(objects.get(media.originalKey), bytes);
});

test('the upload worker writes all four readable renditions to local object storage before marking a job done', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raui-media-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config.envSchema.parse({
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
    WEB_ORIGIN: 'http://localhost:3000',
    LOCAL_PRIVATE_DIR: directory,
  });
  t.mock.method(config, 'loadConfig', () => settings);
  const storage = new ConfiguredStorage();
  const id = randomUUID();
  const originalKey = 'originals/' + id + '.png';
  const data = await sharp({
    create: { width: 249, height: 83, channels: 3, background: 'navy' },
  })
    .png()
    .toBuffer();
  await storage.put(originalKey, data, 'image/png');
  const writes: { statement: string; args: unknown[] }[] = [];
  const transaction = {
    query: async (statement: string, args: unknown[]) => {
      writes.push({ statement, args });
      return { rowCount: 1 };
    },
  };
  const db = {
    transaction: async (work: (sql: typeof transaction) => Promise<unknown>) =>
      work(transaction),
    rows: async (sql: string) =>
      sql.includes('FROM media_jobs')
        ? [{ id: 'job', media_id: id, attempts: 0 }]
        : [{ id, original_key: originalKey }],
  };
  const events: string[] = [];
  const audit = {
    record: async (_sql: unknown, _actor: unknown, event: string) => {
      events.push(event);
    },
  };
  const worker = new MediaWorker(db as never, storage, audit as never);
  assert.equal(await worker.once(), true);
  assert.deepEqual(events, ['media.processed']);
  const done = writes.find((w) => w.statement.includes("SET state='done'"));
  assert.deepEqual(done?.args, ['job', 1]);
  const result = writes.find((w) => w.statement.includes("SET state='ready'"))!;
  assert.equal(result.args[0], id);
  assert.equal(result.args[2], createHash('sha256').update(data).digest('hex'));
  const variants: MediaRow['variants'] = JSON.parse(result.args[1] as string);
  assert.deepEqual(Object.keys(variants).sort(), [
    'avif',
    'large',
    'small',
    'thumb',
  ]);
  for (const [name, variant] of Object.entries(variants)) {
    const info = await sharp(await storage.get(variant.key)).metadata();
    assert.equal(info.format, name === 'avif' ? 'heif' : 'webp');
    assert.equal(info.width, name === 'thumb' ? 240 : 249);
    assert.equal(info.height, name === 'thumb' ? 80 : 83);
  }
  assert.deepEqual(await storage.get(originalKey), data);
});
