import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Media } from './modules/media/media';

test('trusted XML can publish with one processed photo while manual submission requires five', async () => {
  let ready = 1;
  let pending = 0;
  const media = { db: { rows: async () => [{ ready, pending }] } };
  const check = (minimum?: number) =>
    Reflect.apply(Media.prototype.ready, media, [{}, 'listing', minimum]);
  await check(1);
  await assert.rejects(check(), /5 to 21/);
  ready = 0;
  await assert.rejects(check(1));
  ready = 22;
  await assert.rejects(check(1));
  ready = 5;
  pending = 1;
  await assert.rejects(check(1));
  await assert.rejects(check());
});
