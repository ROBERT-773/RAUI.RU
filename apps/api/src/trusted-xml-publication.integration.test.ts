import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import sharp from 'sharp';
import { AppModule } from './app.module';
import { type Actor, hash } from './common/security';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import { Listings } from './modules/listings/listings';
import { readLastPublicPriceSnapshot } from './modules/listings/public-price-history';
import { ObjectStorage } from './modules/media/storage';
import { FeedFetcher } from './modules/professional/feed-fetch';
import { FeedPhotoFetcher } from './modules/professional/feed-photos-fetch';
import { ProfessionalFeeds } from './modules/professional/feeds';
import { ProfessionalImports } from './modules/professional/imports';
import { TrustedFeedSources } from './modules/professional/trusted-feed-sources';

const feedUrl = 'https://delivery.example.test/cian.xml';
const replacementUrl = 'https://delivery.example.test/replacement.xml';
const photoUrl = 'https://delivery.example.test/photo.png';
const description = 'Просторная квартира на Московской улице.';

function cian(price: number, text = description) {
  return `<Feed><Feed_Version>2</Feed_Version><Object><ExternalId>flat-42</ExternalId>
    <Category>newBuildingFlatSale</Category><Title>Двухкомнатная квартира</Title><Description>${text}</Description>
    <Address>Москва, Московская улица, 1</Address><City>Москва</City><Coordinates><Lat>55.7</Lat><Lng>37.6</Lng></Coordinates>
    <FloorNumber>4</FloorNumber><Building><FloorsCount>9</FloorsCount></Building>
    <FlatRoomsCount>2</FlatRoomsCount><TotalArea>55.3</TotalArea><KitchenArea>10</KitchenArea>
    <BargainTerms><Price>${price}</Price><Currency>rur</Currency></BargainTerms>
    <Photos><PhotoSchema><FullUrl>${photoUrl}</FullUrl><IsDefault>true</IsDefault></PhotoSchema></Photos>
  </Object></Feed>`;
}

function image(color: string) {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

test(
  'trusted XML publishes, updates public media and price, replays idempotently, and stops in-flight delivery on revocation',
  { timeout: 90_000 },
  async () => {
    assert.match(
      new URL(process.env.TEST_DATABASE_URL!).pathname,
      /^\/raui_test_[a-f0-9]{16}$/,
    );
    assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
    assert.equal(process.env.STORAGE_DRIVER, 'local');
    assert.ok(process.env.LOCAL_PRIVATE_DIR);
    const previousHosts = process.env.FEED_ALLOWED_HOSTS;
    process.env.FEED_ALLOWED_HOSTS = 'delivery.example.test';
    let xml = cian(9_500_000),
      bytes = await image('#334477');
    let pausePhoto: (() => Promise<void>) | undefined;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FeedFetcher)
      .useValue({
        async fetch(url: string) {
          assert.ok([feedUrl, replacementUrl].includes(url));
          return xml;
        },
      })
      .overrideProvider(FeedPhotoFetcher)
      .useValue({
        async fetch(url: string) {
          assert.equal(url, photoUrl);
          await pausePhoto?.();
          return { bytes, mime: 'image/png' };
        },
      })
      .compile();
    const db = module.get(Database),
      feeds = module.get(ProfessionalFeeds),
      imports = module.get(ProfessionalImports),
      trusted = module.get(TrustedFeedSources),
      listings = module.get(Listings),
      storage = module.get(ObjectStorage);
    async function account(role: 'admin' | 'agent'): Promise<Actor> {
      const id = randomUUID(),
        session = randomUUID();
      await db.pool.query(
        "INSERT INTO users(id,role,email,password_hash,display_name,registration_approval_state,email_verified_at,phone_verified_at) VALUES($1,$2,$3,'fixture','XML acceptance','approved',now(),now())",
        [id, role, id + '@example.test'],
      );
      await db.pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
        [session, id, hash(randomUUID()), hash(randomUUID())],
      );
      return {
        id,
        role,
        session_id: session,
        registration_approval_state: 'approved',
        email_verified_at: new Date().toISOString(),
        phone_verified_at: new Date().toISOString(),
      };
    }
    async function storedKeys() {
      const root = resolve(process.env.LOCAL_PRIVATE_DIR!, 'objects');
      const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath, entry.name))
        .sort();
    }
    try {
      const migrationPool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await migrate(migrationPool);
      } finally {
        await migrationPool.end();
      }
      const agent = await account('agent'),
        admin = await account('admin');
      const { feed, preview } = await feeds.createFromLink(
        agent,
        null,
        { provider: 'cian', url: feedUrl },
        randomUUID(),
      );
      const state = async () =>
        (
          await db.rows<{ version: number; last_apply_run_id: string }>(
            'SELECT version,last_apply_run_id FROM professional_feed_definitions WHERE id=$1',
            [feed.id],
          )
        )[0]!;
      const latest = async () =>
        imports.report(agent, null, feed.id, (await state()).last_apply_run_id);
      async function apply() {
        await db.pool.query(
          "UPDATE professional_feed_definitions SET next_run_at=now()-interval '1 second' WHERE id=$1",
          [feed.id],
        );
        assert.equal(await imports.once(), true);
        return latest();
      }
      await assert.rejects(
        trusted.set(admin, feed.id, {
          trusted: true,
          version: (await state()).version,
        }),
        /preview/i,
      );
      assert.equal(await imports.once(), true);
      assert.equal(
        (await imports.report(agent, null, feed.id, preview.runId)).status,
        'succeeded',
      );
      assert.equal((await db.rows('SELECT id FROM listings')).length, 0);
      await trusted.set(admin, feed.id, {
        trusted: true,
        version: (await state()).version,
      });
      assert.equal(await imports.once(), true);
      const stats = (created: number, updated: number, unchanged: number) => ({
        total: 1,
        valid: 1,
        quarantined: 0,
        created,
        updated,
        unchanged,
      });
      assert.deepEqual((await latest()).stats, stats(1, 0, 0));
      const [record] = await db.rows<{ listing_id: string }>(
        'SELECT listing_id FROM professional_feed_records WHERE feed_id=$1',
        [feed.id],
      );
      assert.ok(record);
      const id = record.listing_id;
      async function current() {
        const [row] = await db.rows<{
          price: string;
          version: number;
          published_at: Date;
        }>('SELECT price,version,published_at FROM listings WHERE id=$1', [id]);
        const [photo] = await db.rows<{
          id: string;
          original_key: string;
          content_sha256: string;
          thumbnail: string;
        }>(
          "SELECT id,original_key,content_sha256,variants->'thumb'->>'key' AS thumbnail FROM media WHERE listing_id=$1 AND kind='photo' AND state='ready'",
          [id],
        );
        assert.ok(row && photo);
        const card = await listings.published(id);
        assert.equal(card.media.length, 1);
        assert.equal(card.media[0]!.id, photo.id);
        assert.equal(card.price, row.price);
        const { format } = await sharp(
          await storage.get(photo.thumbnail),
        ).metadata();
        assert.equal(format, 'webp');
        const [projection] = await db.rows<{ price: number }>(
          'SELECT price FROM public_search_listings WHERE id=$1',
          [id],
        );
        assert.equal(projection!.price, Number(row.price));
        return { ...row, ...photo };
      }
      const initial = await current();
      assert.equal(initial.content_sha256, hash(bytes));
      assert.deepEqual((await apply()).stats, stats(0, 0, 1));
      assert.deepEqual(await current(), initial);
      xml = cian(9_100_000);
      assert.deepEqual((await apply()).stats, stats(0, 1, 0));
      const repriced = await current();
      assert.equal(repriced.id, initial.id);
      assert.equal(repriced.version, initial.version + 1);
      assert.equal(repriced.price, '9100000.00');
      assert.deepEqual(repriced.published_at, initial.published_at);
      assert.equal(
        (await readLastPublicPriceSnapshot(db.pool, id))?.price,
        '9100000.00',
      );
      // Content can change while the supplier keeps its URL and all XML fields unchanged.
      bytes = await image('#116655');
      assert.deepEqual((await apply()).stats, stats(0, 1, 0));
      const changed = await current();
      assert.notEqual(changed.id, initial.id);
      assert.equal(changed.content_sha256, hash(bytes));
      assert.equal(changed.version, repriced.version + 1);
      assert.deepEqual(changed.published_at, initial.published_at);
      assert.deepEqual((await apply()).stats, stats(0, 0, 1));
      assert.deepEqual(await current(), changed);
      const files = await storedKeys();
      assert.equal(files.length, 5);
      // A trust failure is raised after the replacement real image variants have been written to storage.
      xml = cian(7_000_000, 'Переведите деньги до просмотра квартиры.');
      bytes = await image('#992211');
      const denied = await apply();
      assert.equal(denied.status, 'quarantined');
      assert.equal(denied.stats.quarantined, 1);
      assert.deepEqual(await current(), changed);
      assert.deepEqual(await storedKeys(), files);
      xml = cian(7_000_000);
      bytes = Buffer.from('invalid image');
      assert.equal((await apply()).status, 'quarantined');
      assert.deepEqual(await current(), changed);
      assert.deepEqual(await storedKeys(), files);
      bytes = await image('#bb5522');
      let started!: () => void;
      let resume!: () => void;
      const fetchingPhoto = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      pausePhoto = () => {
        started();
        return resumed;
      };
      const fetching = apply();
      try {
        await Promise.race([
          fetchingPhoto,
          fetching.then(() => {
            throw Error('worker finished before photo fetch');
          }),
        ]);
        await trusted.set(admin, feed.id, {
          trusted: false,
          version: (await state()).version,
        });
      } finally {
        resume();
      }
      const revoked = await fetching;
      assert.equal(revoked.status, 'failed');
      assert.equal(revoked.error, 'access_revoked');
      await assert.rejects(
        imports.retry(agent, null, feed.id, revoked.id),
        ConflictException,
      );
      assert.deepEqual(await current(), changed);
      assert.deepEqual(await storedKeys(), files);
      assert.equal(
        (await db.rows('SELECT media_id FROM professional_photo_cleanup'))
          .length,
        0,
      );
      const [historical] = await db.rows<{ count: number }>(
        "SELECT count(*)::int AS count FROM listing_history WHERE listing_id=$1 AND event LIKE 'professional.feed.publication%'",
        [id],
      );
      assert.equal(historical?.count, 2);
      pausePhoto = undefined;
      const fresh = await feeds.createFromLink(
        agent,
        null,
        { provider: 'cian' },
        randomUUID(),
      );
      assert.equal(await imports.once(), true);
      assert.equal(
        (await imports.report(agent, null, feed.id, fresh.preview.runId))
          .status,
        'succeeded',
      );
      await trusted.set(admin, feed.id, {
        trusted: true,
        version: (await state()).version,
      });
      const queued = (await state()).last_apply_run_id;
      const replaced = await feeds.createFromLink(
        agent,
        null,
        { provider: 'cian', url: replacementUrl },
        randomUUID(),
      );
      assert.equal(replaced.feed.id, feed.id);
      assert.equal(replaced.feed.trusted, false);
      assert.equal(await imports.once(), true);
      assert.equal(
        (await imports.report(agent, null, feed.id, queued)).status,
        'failed',
      );
      await assert.rejects(
        imports.retry(agent, null, feed.id, queued),
        ConflictException,
      );
      assert.equal(await imports.once(), true);
      assert.equal(
        (await imports.report(agent, null, feed.id, replaced.preview.runId))
          .status,
        'succeeded',
      );
      assert.deepEqual(await current(), changed);
      assert.deepEqual(await storedKeys(), files);
    } finally {
      await module.close();
      if (previousHosts === undefined) delete process.env.FEED_ALLOWED_HOSTS;
      else process.env.FEED_ALLOWED_HOSTS = previousHosts;
    }
  },
);
