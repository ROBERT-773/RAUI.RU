import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleListingSubscriptionEvent } from './modules/product/subscription-eligibility';
import { listingSubscriptionDeliverySchema } from './modules/product/subscription-contract';
import { ListingAccess } from './modules/listings/access';
import {
  availabilityDedupeKey,
  visibilityTokenSchema,
} from './modules/product/subscription-visibility';
const listingId = '12345678-1234-4234-8234-123456789abc';
const sellerId = '22345678-1234-4234-8234-123456789abc';
const token = (generation = '0') => ({
  seller: { id: sellerId, generation },
  organization: null,
  membership: null,
});
const legacy = {
  listingId,
  listingVersion: 1,
  subscriptionVersion: 1,
  event: { kind: 'availability', available: false },
};
const snapshot = (generation = '0') => ({
  version: 1,
  visible: false,
  visibilityToken: token(generation),
});
test('legacy availability does not revive after same-version hide/show/hide generation advance', async () => {
  const access = {
    currentVisibility: async () => snapshot('3'),
  } as unknown as ListingAccess;
  assert.equal(
    await eligibleListingSubscriptionEvent(
      access,
      'subscription.listing.availability',
      legacy,
    ),
    null,
  );
});
test('v2 availability retains its strict exact bigint token and uses only neutral snapshot', async () => {
  const payload = {
    ...legacy,
    schemaVersion: 2,
    visibilityToken: token('9223372036854775807'),
  };
  assert.equal(
    listingSubscriptionDeliverySchema.safeParse(payload).success,
    true,
  );
  const access = {
    currentVisibility: async () => snapshot('9223372036854775807'),
    visible: async () => {
      throw new Error('No private listing projection');
    },
  } as unknown as ListingAccess;
  assert.deepEqual(
    await eligibleListingSubscriptionEvent(
      access,
      'subscription.listing.availability',
      payload,
    ),
    payload,
  );
});
for (const generation of ['01', '-1', '1e3', '9223372036854775808', 1, null])
  test(
    'invalid visibility generation fails closed: ' + String(generation),
    () => {
      assert.equal(
        listingSubscriptionDeliverySchema.safeParse({
          ...legacy,
          schemaVersion: 2,
          visibilityToken: { ...token(), seller: { id: sellerId, generation } },
        }).success,
        false,
      );
    },
  );

test('visibility tokens reject extra and mismatched dependency identities', () => {
  const organizationId = '32345678-1234-4234-8234-123456789abc';
  const membership = {
    organizationId,
    userId: sellerId,
    generation: '0',
  };
  for (const invalid of [
    { ...token(), extra: true },
    { ...token(), membership },
    {
      ...token(),
      organization: { id: organizationId, generation: '0' },
      membership: null,
    },
    {
      ...token(),
      organization: { id: organizationId, generation: '0' },
      membership: { ...membership, userId: listingId },
    },
  ])
    assert.equal(visibilityTokenSchema.safeParse(invalid).success, false);
});

test('canonical availability key changes for each dependency generation', () => {
  const current = token('1');
  assert.notEqual(
    availabilityDedupeKey(listingId, 1, current),
    availabilityDedupeKey(listingId, 1, token('2')),
  );
  assert.equal(
    availabilityDedupeKey(listingId, 1, current),
    availabilityDedupeKey(listingId, 1, structuredClone(current)),
  );
});

test('missing current registry token fails closed for legacy and v2 availability', async () => {
  const access = {
    currentVisibility: async () => ({
      version: 1,
      visible: false,
      visibilityToken: null,
    }),
  } as unknown as ListingAccess;
  assert.equal(
    await eligibleListingSubscriptionEvent(
      access,
      'subscription.listing.availability',
      legacy,
    ),
    null,
  );
  assert.equal(
    await eligibleListingSubscriptionEvent(
      access,
      'subscription.listing.availability',
      { ...legacy, schemaVersion: 2, visibilityToken: token() },
    ),
    null,
  );
});
