import { test } from 'node:test';
import { Geo, addressSchema } from './modules/geo/geo';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { passwordHash, passwordMatches } from './common/security';
import { assertTransition } from './modules/listings/listings';
import { validateAttributes } from './modules/catalog/catalog';
import { validateImage } from './modules/media/media';
import { envSchema } from './config';
import sharp from 'sharp';
import { enrichOpenApi } from './common/openapi';
import type { OpenAPIObject } from '@nestjs/swagger';
import { migrate } from './modules/database/migrate';
import type { Pool } from 'pg';
import { Database } from './modules/database/database';
import { RegionCatalogue, loadRegionDocuments } from './modules/geo/regions';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Migration cleanup preserves primary failures and discards unsafe pooled connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raui-migrate-unit-'));
  try {
    for (const mode of [
      'rollback',
      'unlock-after-error',
      'unlock-after-success',
    ]) {
      const primary = new Error('primary fixture failure');
      const cleanup = new Error('cleanup fixture failure');
      let discarded: boolean | undefined;
      const client = {
        query: async (statement: string) => {
          if (
            statement.startsWith('CREATE TABLE') &&
            mode !== 'unlock-after-success'
          )
            throw primary;
          if (statement === 'ROLLBACK' && mode === 'rollback') throw cleanup;
          if (statement.includes('pg_advisory_unlock') && mode !== 'rollback')
            throw cleanup;
          return { rows: [] };
        },
        release: (destroy: boolean) => {
          discarded = destroy;
        },
      };
      const pool = { connect: async () => client } as unknown as Pool;
      await assert.rejects(
        migrate(pool, directory),
        (error) =>
          error === (mode === 'unlock-after-success' ? cleanup : primary),
      );
      assert.equal(discarded, true, mode);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('OpenAPI enrichment preserves path metadata and query parameters on repeated calls', () => {
  const query = {
    in: 'query' as const,
    name: 'fixture',
    schema: { type: 'string' as const },
  };
  const pathParameter = {
    in: 'path' as const,
    name: 'id',
    required: true,
    schema: { type: 'string' as const },
  };
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/organizations': {
        parameters: [pathParameter],
        servers: [{ url: 'https://example.test' }],
        post: {
          responses: {},
          parameters: [
            query,
            {
              in: 'header',
              name: 'Idempotency-Key',
              schema: { type: 'string' },
            },
          ],
        },
      },
      '/v1/commerce/webhook': { post: { responses: {}, parameters: [query] } },
      '/v1/search/sitemap': { get: { responses: {}, parameters: [query] } },
    },
  };
  enrichOpenApi(document);
  enrichOpenApi(document);
  assert.deepEqual(document.paths['/v1/organizations']!.parameters, [
    pathParameter,
  ]);
  assert.deepEqual(document.paths['/v1/organizations']!.servers, [
    { url: 'https://example.test' },
  ]);
  for (const path of ['/v1/organizations', '/v1/commerce/webhook']) {
    const parameters = document.paths[path]!.post!.parameters!;
    assert.equal(parameters.length, 2);
    assert.deepEqual(parameters[0], query);
  }
  assert.equal(
    document.paths['/v1/search/sitemap']!.get!.parameters!.length,
    2,
  );
});
test('adaptive hashes use independent salts and reject incorrect passwords', async () => {
  const first = await passwordHash('a-strong-password'),
    second = await passwordHash('a-strong-password');
  assert.notEqual(first, second);
  assert.ok(await passwordMatches('a-strong-password', first));
  assert.equal(await passwordMatches('incorrect', first), false);
});
test('listing lifecycle blocks publication bypass, terminal changes and incompatible deal outcomes', () => {
  assertTransition('draft', 'processing', 'sale');
  assertTransition('published', 'sold', 'sale');
  assert.throws(
    () => assertTransition('draft', 'published', 'sale'),
    ConflictException,
  );
  assert.throws(
    () => assertTransition('sold', 'draft', 'sale'),
    ConflictException,
  );
  assert.throws(
    () => assertTransition('published', 'rented', 'sale'),
    BadRequestException,
  );
});
test('configurable attributes reject unknown fields, enforce types, enums and publication requirements', () => {
  const definitions = [
    { code: 'area', kind: 'number' as const, required: true, options: [] },
    {
      code: 'renovation',
      kind: 'enum' as const,
      required: false,
      options: ['new'],
    },
  ];
  validateAttributes(definitions, {}, false);
  validateAttributes(definitions, { area: 50, renovation: 'new' }, true);
  for (const values of [
    {},
    { area: -1 },
    { area: '50' },
    { area: 50, extra: true },
    { area: 50, renovation: 'unknown' },
  ])
    assert.throws(
      () => validateAttributes(definitions, values, true),
      BadRequestException,
    );
});
test('images require genuine content, matching extensions and bounded input', async () => {
  const image = await sharp({
    create: { width: 10, height: 20, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  assert.equal(
    (await validateImage(image, 'image/png', 'photo.png')).height,
    20,
  );
  await assert.rejects(
    validateImage(image, 'image/jpeg', 'photo.jpg'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(Buffer.from('<svg/>'), 'image/png', 'file.png'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(image, 'image/png', 'photo.webp'),
    BadRequestException,
  );
  await assert.rejects(
    validateImage(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', 'photo.png'),
    BadRequestException,
  );
});
test('production refuses local verification/storage fallback', () => {
  assert.equal(
    envSchema.safeParse({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://raui.ru',
      DATABASE_URL: 'postgresql://localhost/raui',
      REDIS_URL: 'redis://localhost',
    }).success,
    false,
  );
});
test('module boundaries prevent controllers from executing SQL and media from depending on listing workflow', async () => {
  const { readFile } = await import('node:fs/promises');
  const { glob } = await import('node:fs/promises');
  for await (const filename of glob('src/modules/**/*.ts')) {
    const source = await readFile(filename, 'utf8');
    const controller = source.indexOf('@Controller(');
    if (controller >= 0) {
      const moduleEnd = source.indexOf('@Module(', controller);
      const section = source.slice(
        controller,
        moduleEnd >= 0 ? moduleEnd : undefined,
      );
      assert.doesNotMatch(section, /\.query\(|\.rows\(/, filename);
    }
    if (filename.includes('/media/'))
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/listings\/listings['"]/,
        filename,
      );
    if (filename.includes('/database/'))
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/(auth|listings|properties|media)\//,
        filename,
      );
  }
});

test('address contract accepts explicit region selection while preserving legacy input', () => {
  const address = {
    formatted: 'Москва, Тверская',
    locality: 'Москва',
    longitude: 37.6,
    latitude: 55.7,
  };
  assert.equal(addressSchema.parse(address).regionCode, undefined);
  for (const regionCode of ['moscow', 'moscow_oblast'])
    assert.equal(
      addressSchema.parse({ ...address, regionCode }).regionCode,
      regionCode,
    );
  for (const regionCode of ['', '../moscow', 'Moscow', null])
    assert.equal(
      addressSchema.safeParse({ ...address, regionCode }).success,
      false,
    );
});

test('Geo validates catalogue membership before writing an address', async () => {
  const catalogue = new RegionCatalogue(loadRegionDocuments('config/regions'));
  let writes = 0;
  const db = {
    rows: async () => {
      writes++;
      return [{ id: 'fixture' }];
    },
  } as unknown as Database;
  const geo = new Geo(db, catalogue);
  const address = {
    formatted: 'Fixture address',
    locality: 'Fixture',
    longitude: 37.6,
    latitude: 55.7,
  };
  await assert.rejects(
    geo.create({} as Pool, { ...address, regionCode: 'unknown' }),
    BadRequestException,
  );
  assert.equal(writes, 0);
  for (const regionCode of ['moscow', 'moscow_oblast'])
    assert.equal(
      await geo.create({} as Pool, { ...address, regionCode }),
      'fixture',
    );
  assert.equal(await geo.create({} as Pool, address), 'fixture');
  assert.equal(writes, 3);
});

test('CSRF recovery OpenAPI requires cookie authentication and exposes only the token schema', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: { '/v1/auth/csrf': { get: { responses: {} } } },
  };
  enrichOpenApi(document);
  const operation = document.paths['/v1/auth/csrf']!.get!;
  assert.deepEqual(operation.security, [{ cookie: [] }]);
  assert.ok(operation.responses['200']);
  assert.ok(operation.responses['401']);
});
