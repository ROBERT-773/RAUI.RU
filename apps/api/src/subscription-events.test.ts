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

test('lower republish compares authoritative last public price and emits both stable event keys', () => {
  const republish = {
    ...base,
    publicBefore: false,
    previousPrice: 'private-draft',
    lastPublicPrice: '100.10',
  };
  const expected = [
    {
      key: 'listing:fixture:4:availability',
      event: { kind: 'availability', available: true },
    },
    {
      key: 'listing:fixture:4:price_drop',
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10010,
        priceMinor: 9999,
      },
    },
  ];
  assert.deepEqual(listingSubscriptionEvents(republish), expected);
  assert.deepEqual(listingSubscriptionEvents({ ...republish }), expected);
});

test('unchanged and higher republish prices emit only availability', () => {
  for (const price of ['100.10', '101']) {
    const republish = {
      ...base,
      publicBefore: false,
      previousPrice: '999',
      lastPublicPrice: '100.10',
      price,
    };
    assert.deepEqual(listingSubscriptionEvents(republish), [
      {
        key: 'listing:fixture:4:availability',
        event: { kind: 'availability', available: true },
      },
    ]);
  }
});

test('first publication never falls back to an unpublished previous price', () => {
  for (const republish of [
    { ...base, publicBefore: false, previousPrice: '999' },
    {
      ...base,
      publicBefore: false,
      previousPrice: 'private',
      lastPublicPrice: null,
    },
  ]) {
    assert.deepEqual(listingSubscriptionEvents(republish), [
      {
        key: 'listing:fixture:4:availability',
        event: { kind: 'availability', available: true },
      },
    ]);
  }
});

test('nonpublic after-state never parses or emits any supplied price baseline', () => {
  for (const publicBefore of [false, true]) {
    const hidden = {
      ...base,
      publicBefore,
      publicAfter: false,
      previousPrice: 'private-before',
      price: 'private-after',
      lastPublicPrice: 'private-baseline',
    };
    assert.deepEqual(
      listingSubscriptionEvents(hidden),
      publicBefore
        ? [
            {
              key: 'listing:fixture:4:availability',
              event: { kind: 'availability', available: false },
            },
          ]
        : [],
    );
  }
});

test('republish rejects invalid authoritative baseline while continuous-public uses prior public price', () => {
  for (const lastPublicPrice of [
    '',
    '99.999',
    '1e2',
    '-1',
    '0',
    '99999999999999.99',
  ]) {
    const republish = { ...base, publicBefore: false, lastPublicPrice };
    assert.throws(() => listingSubscriptionEvents(republish));
  }
  const continuous = { ...base, lastPublicPrice: 'private-ignored' };
  assert.deepEqual(
    listingSubscriptionEvents(continuous),
    listingSubscriptionEvents(base),
  );
});
