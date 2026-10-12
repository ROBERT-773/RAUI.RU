import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingSubscriptionEvents } from './modules/product/subscription-events';

const base = {
  listingId: 'fixture',
  version: 4,
  publicBefore: true,
  publicAfter: true,
  previousPrice: '100.10',
  price: '99.99',
};
test('public price decreases use exact minor units and stable version event keys', () => {
  const expected = [
    {
      key: 'listing:fixture:4:price_drop',
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10010,
        priceMinor: 9999,
      },
    },
  ];
  assert.deepEqual(listingSubscriptionEvents(base), expected);
  assert.deepEqual(listingSubscriptionEvents({ ...base }), expected);
  for (const price of ['100.10', '101'])
    assert.deepEqual(listingSubscriptionEvents({ ...base, price }), []);
});
test('availability events do not expose private prices or moderation reasons', () => {
  assert.deepEqual(
    listingSubscriptionEvents({
      ...base,
      publicAfter: false,
      price: 'private',
    }),
    [
      {
        key: 'listing:fixture:4:availability',
        event: { kind: 'availability', available: false },
      },
    ],
  );
  assert.deepEqual(
    listingSubscriptionEvents({
      ...base,
      publicBefore: false,
      publicAfter: false,
    }),
    [],
  );
});
test('price event rejects rounding, exponent notation and unsafe integer amounts', () => {
  for (const price of ['99.999', '1e2', '-1', '99999999999999.99'])
    assert.throws(() => listingSubscriptionEvents({ ...base, price }));
});
