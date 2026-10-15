import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from './modules/database/database';
import {
  buildPublicPriceSnapshot,
  readLastPublicPriceSnapshot,
} from './modules/listings/public-price-history';
const input = {
  price: '99999999999999.99',
  currency: 'RUB',
  listingVersion: 7,
  capturedAt: new Date('2026-10-12T01:02:03.004Z'),
};

test('public price snapshot preserves exact PostgreSQL decimal and server version/time', async () => {
  assert.deepEqual(buildPublicPriceSnapshot(input), {
    schemaVersion: 1,
    price: input.price,
    currency: 'RUB',
    listingVersion: 7,
    capturedAt: input.capturedAt.toISOString(),
  });
  for (const price of ['0', '-1', '1e2', '1.001', '', '100000000000000'])
    assert.throws(() => buildPublicPriceSnapshot({ ...input, price }));
  for (const listingVersion of [0, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => buildPublicPriceSnapshot({ ...input, listingVersion }));
  assert.throws(() => buildPublicPriceSnapshot({ ...input, currency: 'USD' }));
  assert.throws(() =>
    buildPublicPriceSnapshot({ ...input, capturedAt: new Date('invalid') }),
  );
});

test('reader validates latest server marker and never queries an older fallback', async () => {
  const snapshot = buildPublicPriceSnapshot(input);
  for (const after_data of [
    {
      status: 'published',
      publicPriceSnapshot: snapshot,
      caseId: 'legacy-metadata',
      reason: 'approved',
    },
    { status: 'paused', publicPriceSnapshot: snapshot },
    { status: 'published', publicPriceSnapshot: null },
    {
      status: 'published',
      publicPriceSnapshot: { ...snapshot, schemaVersion: 2 },
    },
    {
      status: 'published',
      publicPriceSnapshot: { ...snapshot, clientPrice: '1' },
    },
    ...['', 'nonsense', '2026-02-30T01:02:03.004Z'].map((capturedAt) => ({
      status: 'published',
      publicPriceSnapshot: { ...snapshot, capturedAt },
    })),
    { status: 'published', publicPriceSnapshot: { ...snapshot, price: '1e2' } },
  ]) {
    let reads = 0;
    const sql = {
      query: async (query: string, values: unknown[]) => {
        reads++;
        assert.deepEqual(values, ['listing']);
        assert.match(query, /after_data \? 'publicPriceSnapshot'/);
        assert.match(query, /ORDER BY id DESC LIMIT 1/);
        assert.doesNotMatch(query, /after_data->>'status'/);
        return { rows: [{ after_data }] };
      },
    } as unknown as Sql;
    assert.deepEqual(
      await readLastPublicPriceSnapshot(sql, 'listing'),
      after_data === undefined ||
        after_data.status !== 'published' ||
        after_data.publicPriceSnapshot !== snapshot
        ? null
        : snapshot,
    );
    assert.equal(reads, 1);
  }
  assert.equal(
    await readLastPublicPriceSnapshot(
      { query: async () => ({ rows: [] }) } as unknown as Sql,
      'listing',
    ),
    null,
  );
});

test('internal capture requires authoritative public eligibility on the caller SQL client', async () => {
  const { Listings } = await import('./modules/listings/listings.js');
  const sql = {
    query: async () => {
      throw new Error('Capture wrapper must not write');
    },
  } as unknown as Sql;
  let visible = false;
  const access = {
    visible: async (id: string, client: Sql) => {
      assert.equal(id, 'listing');
      assert.equal(client, sql);
      return visible ? { price: '10.01', version: 7 } : undefined;
    },
  };
  const listings = new Listings(
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  assert.equal(
    await listings.publicPriceSnapshot('listing', sql, input.capturedAt),
    null,
  );
  visible = true;
  assert.deepEqual(
    await listings.publicPriceSnapshot('listing', sql, input.capturedAt),
    buildPublicPriceSnapshot({ ...input, price: '10.01' }),
  );
});
