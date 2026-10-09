import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSchema, indexQuery, sortSpec } from './modules/search/contracts';
import { documentOf, PublicRow, Search } from './modules/search/search';
import { RegionCatalogue, loadRegionDocuments } from './modules/geo/regions';
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

test('regional search uses an exact region term and leaves legacy searches unrestricted', () => {
  const input = searchSchema.parse({ regionCode: 'moscow' });
  assert.ok(
    JSON.stringify(indexQuery(input)).includes('"region_code":"moscow"'),
  );
  assert.ok(
    !JSON.stringify(indexQuery(searchSchema.parse({}))).includes('region_code'),
  );
  for (const regionCode of ['', 'MOSCOW', '../secret'])
    assert.equal(searchSchema.safeParse({ regionCode }).success, false);
});
test('search cursors reject malformed and expired timestamps before querying the index', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let indexCalls = 0;
  const service = new Search(
    { rows: async () => [] } as unknown as ConstructorParameters<
      typeof Search
    >[0],
    {
      alias: 'test',
      request: async () => {
        indexCalls++;
        return {
          hits: {
            hits: Array.from({ length: 20 }, (_, i) => ({
              _id: String(i),
              sort: [now - i, String(i)],
            })),
            total: { value: 20 },
          },
          aggregations: {},
        };
      },
    } as unknown as ConstructorParameters<typeof Search>[1],
    { attach: async () => [] } as unknown as ConstructorParameters<
      typeof Search
    >[2],
    new RegionCatalogue(loadRegionDocuments('config/regions')),
  );
  const first = await service.results({});
  assert.ok(first.cursor);
  const original = JSON.parse(
    Buffer.from(first.cursor, 'base64url').toString(),
  );
  assert.equal(original.expires, now + 900_000);
  const cases = [
    ['missing', undefined],
    ['string', 'invalid'],
    ['numeric string', String(now + 1)],
    ['null', null],
    ['NaN serialized as null', NaN],
    ['Infinity serialized as null', Infinity],
    ['negative Infinity serialized as null', -Infinity],
    ['past', now - 1],
    ['expiry boundary', now],
    ['fractional timestamp', now + 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [name, expires] of cases) {
    const cursor = Buffer.from(
      JSON.stringify({ ...original, expires }),
    ).toString('base64url');
    const callsBefore = indexCalls;
    await assert.rejects(
      service.results({ cursor }),
      /Invalid or expired cursor/,
      String(name),
    );
    assert.equal(indexCalls, callsBefore, String(name));
  }
  const overflow = JSON.stringify(original).replace(
    /"expires":\d+/,
    '"expires":1e309',
  );
  const callsBefore = indexCalls;
  await assert.rejects(
    service.results({ cursor: Buffer.from(overflow).toString('base64url') }),
    /Invalid or expired cursor/,
  );
  assert.equal(indexCalls, callsBefore);
  // A genuine server-generated cursor retains its sort boundary and query binding.
  await service.results({ cursor: first.cursor });
  assert.equal(indexCalls, callsBefore + 1);
  await assert.rejects(
    service.results({ cursor: first.cursor, q: 'changed' }),
    /Invalid or expired cursor/,
  );
  assert.equal(indexCalls, callsBefore + 1);
  for (const after of [null, [], [now], [now, 'id', 'extra']]) {
    const cursor = Buffer.from(JSON.stringify({ ...original, after })).toString(
      'base64url',
    );
    await assert.rejects(
      service.results({ cursor }),
      /Invalid or expired cursor/,
    );
    assert.equal(indexCalls, callsBefore + 1);
  }
});
