import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { Product } from './modules/product/product';
import { Actor } from './common/security';
import { Database } from './modules/database/database';
import { ListingAccess } from './modules/listings/access';
import { Search } from './modules/search/search';
import { listingSubscriptionConsentVersion } from './modules/product/subscription-contract';
const actor = { id: '12345678-1234-4234-8234-123456789abc' } as Actor;
const listingId = '22345678-1234-4234-8234-123456789abc';
const item = {
  id: '42',
  kind: 'subscription.listing.price_drop',
  thread_id: null,
  listing_id: listingId,
  subscription_version: 1,
  listing_version: 8,
  read_at: null,
  created_at: '2026-10-14T00:00:00Z',
  payload: {
    listingId,
    subscriptionVersion: 1,
    listingVersion: 8,
    event: { kind: 'price_drop', previousPriceMinor: 10000, priceMinor: 9900 },
  },
};
function fixture(
  options: {
    version?: number;
    price?: string;
    inApp?: boolean;
    disabled?: boolean;
    raw?: unknown[];
    hidden?: boolean;
  } = {},
) {
  let reads = 0;
  const readInputs: unknown[][] = [];
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    pool: sql,
    transaction: async (work: (sql: unknown) => Promise<unknown>) => work(sql),
    rows: async (query: string, values: unknown[]) => {
      if (query.includes('id=$2::bigint')) readInputs.push(values);
      if (query.startsWith('UPDATE notifications')) {
        reads++;
        return [{ id: '42' }];
      }
      if (query.includes('FROM notifications')) return options.raw ?? [item];
      if (query.includes('FROM listing_subscriptions'))
        return [
          {
            listing_id: listingId,
            version: options.version ?? 1,
            disabled_at: options.disabled ? 'now' : null,
            consent_version: listingSubscriptionConsentVersion,
            frequency: 'immediate',
            events: ['price_drop', 'availability'],
            channels: ['in_app'],
          },
        ];
      if (query.includes('FROM users')) return [{ active: true }];
      if (query.includes('FROM notification_preferences'))
        return [{ in_app: options.inApp ?? true }];
      return [];
    },
  } as unknown as Database;
  const access = {
    visible: async () =>
      options.hidden ? undefined : { version: 8, price: options.price ?? '99' },
    currentVisibility: async () => ({ version: 8, visible: !options.hidden }),
  } as unknown as ListingAccess;
  return {
    service: new Product(db, access, {} as Search),
    reads: () => reads,
    readInputs,
  };
}
test('stale subscription page is hidden while cursor advances over scanned rows', async () => {
  const { service } = fixture({ version: 2 });
  assert.deepEqual(await service.notifications(actor, { limit: 1 }), {
    items: [],
    cursor: '42',
  });
});
test('public price changed without version bump hides old price drop', async () => {
  assert.deepEqual(
    (await fixture({ price: '98' }).service.notifications(actor, {})).items,
    [],
  );
});
test('in-app preference hides subscription but preserves existing message inbox behavior', async () => {
  const message = {
    id: '41',
    kind: 'message',
    thread_id: listingId,
    read_at: null,
    created_at: item.created_at,
  };
  const result = await fixture({
    inApp: false,
    raw: [item, message],
  }).service.notifications(actor, {});
  assert.deepEqual(result.items, [message]);
});
test('stale mark-read returns generic not-found and makes no update', async () => {
  const { service, reads } = fixture({ disabled: true });
  await assert.rejects(service.read(actor, '42'), NotFoundException);
  assert.equal(reads(), 0);
});
test('valid subscription response contains only typed safe fields', async () => {
  const result = await fixture().service.notifications(actor, {});
  assert.deepEqual(result.items, [
    {
      id: '42',
      kind: item.kind,
      listing_id: listingId,
      event: item.payload.event,
      read_at: null,
      created_at: item.created_at,
    },
  ]);
});
test('notification cursor/read IDs retain PostgreSQL bigint precision', async () => {
  const id = '9007199254740993';
  const f = fixture({ raw: [{ ...item, id }] });
  assert.equal((await f.service.notifications(actor, { limit: 1 })).cursor, id);
  assert.deepEqual(await f.service.read(actor, id), { ok: true });
  assert.deepEqual(f.readInputs, [
    [actor.id, id],
    [actor.id, id],
  ]);
  await assert.rejects(f.service.read(actor, '9e15'));
  await assert.rejects(
    f.service.notifications(actor, { cursor: '9223372036854775808' }),
  );
});
for (const corrupt of [
  { ...item.payload, privateTitle: 'SECRET' },
  { ...item.payload, listingVersion: 9 },
  { ...item.payload, subscriptionVersion: 2 },
])
  test('corrupt inbox envelope never returns stored private or mismatched data', async () => {
    const result = await fixture({
      raw: [{ ...item, payload: corrupt }],
    }).service.notifications(actor, {});
    assert.deepEqual(result.items, []);
  });
test('neutral unavailable response avoids loading private listing details', async () => {
  const raw = {
    ...item,
    kind: 'subscription.listing.availability',
    payload: {
      ...item.payload,
      event: { kind: 'availability', available: false },
    },
  };
  const f = fixture({ hidden: true, raw: [raw] });
  assert.deepEqual((await f.service.notifications(actor, {})).items, [
    {
      id: '42',
      kind: raw.kind,
      listing_id: listingId,
      event: { kind: 'availability', available: false },
      read_at: null,
      created_at: item.created_at,
    },
  ]);
});
