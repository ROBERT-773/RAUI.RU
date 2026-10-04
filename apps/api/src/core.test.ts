import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { passwordHash, passwordMatches } from './common/security';
import { assertTransition } from './modules/listings/listings';
import { validateAttributes } from './modules/catalog/catalog';
import { validateImage } from './modules/media/media';
import { envSchema } from './config';
import sharp from 'sharp';
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
