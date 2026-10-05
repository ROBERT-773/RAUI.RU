import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSchema, indexQuery, sortSpec } from './modules/search/contracts';
import { documentOf, PublicRow } from './modules/search/search';
test('search contract validates finite ranges, strict attributes, bounds and closed polygon', () => {
  for (const value of [
    { price: { min: 10, max: 1 } },
    { bounds: [180, 0, -180, 10] },
    {
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    },
    { attributes: { private_key: 'secret' } },
    { limit: 1000 },
    { price: { min: Infinity } },
  ])
    assert.equal(searchSchema.safeParse(value).success, false);
  assert.equal(
    searchSchema.safeParse({
      attributes: { rooms: { min: 2 }, elevator: true },
      bounds: [37, 55, 38, 56],
    }).success,
    true,
  );
});
test('filters stay nested and ranges preserve zero; sort has unique tie-breaker', () => {
  const query = indexQuery(
    searchSchema.parse({
      price: { min: 0 },
      attributes: { rooms: { min: 2, max: 4 }, elevator: true },
      q: 'квртира',
    }),
  );
  const serialized = JSON.stringify(query);
  assert.match(serialized, /nested/);
  assert.match(serialized, /fuzziness/);
  assert.match(serialized, /gte":0/);
  assert.deepEqual(sortSpec('price_asc'), [
    { price: { order: 'asc', missing: '_last' } },
    { id: 'asc' },
  ]);
});
test('public index projection excludes identities and arbitrary private attributes', () => {
  const doc = documentOf({
    id: 'x',
    title: 'Квартира',
    description: '',
    address: '',
    category: 'apartment',
    deal_type: 'sale',
    price: 100,
    price_per_m2: 2,
    locality: 'Москва',
    district: 'Центр',
    published_at: new Date(),
    seller_type: 'owner',
    source_type: 'direct',
    longitude: 37,
    latitude: 55,
    attributes: { area: 50, rooms: 2, private_note: 'secret' },
    seller_id: 'secret',
  } as PublicRow);
  assert.doesNotMatch(JSON.stringify(doc), /secret|seller_id|private_note/);
  assert.deepEqual(doc.location, { lon: 37, lat: 55 });
});

test('unconfigured notification adapter defers without acknowledging a send', async () => {
  const { UnconfiguredNotificationTransport } =
    await import('./modules/product/delivery.js');
  assert.equal(
    await new UnconfiguredNotificationTransport().deliver(),
    'deferred',
  );
});
