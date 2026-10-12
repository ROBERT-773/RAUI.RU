import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueImmediateListingEmails } from './modules/product/subscription-outbox';
import { Database, Sql } from './modules/database/database';
import {
  NotificationWorker,
  NotificationAdapter,
} from './modules/professional/notifications';
import { listingSubscriptionConsentVersion } from './modules/product/subscription-contract';
import { ListingAccess } from './modules/listings/access';
import { Audit } from './modules/audit/audit';

test('unchanged public listing produces no queued price notifications', async () => {
  const sql = {
    query: async () => {
      throw new Error('Unexpected queue insert');
    },
  } as unknown as Sql;
  assert.equal(
    await enqueueImmediateListingEmails(sql, {
      listingId: 'fixture',
      version: 1,
      publicBefore: true,
      publicAfter: true,
      previousPrice: '100',
      price: '100',
    }),
    0,
  );
});
test('worker suppresses queued email after unsubscribe before invoking transport', async () => {
  const job = {
    id: 'job',
    user_id: 'user',
    channel: 'email',
    kind: 'subscription.listing.price_drop',
    payload: {
      listingId: '12345678-1234-4234-8234-123456789abc',
      subscriptionVersion: 1,
      listingVersion: 8,
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10000,
        priceMinor: 9900,
      },
    },
    dedupe_key: 'event',
    attempts: 0,
  };
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    pool: sql,
    transaction: async (work: (value: unknown) => Promise<unknown>) =>
      work(sql),
    rows: async (query: string) =>
      query.includes('FOR UPDATE SKIP LOCKED')
        ? [job]
        : query.includes('FROM users')
          ? [{ active: true, email_enabled: true, email_verified_at: 'now' }]
          : [],
  } as unknown as Database;
  let result = '';
  const adapter = {
    configured: true,
    send: async () => {
      throw new Error('Transport must not be invoked');
    },
  } as NotificationAdapter;
  const worker = new NotificationWorker(
    db,
    adapter,
    {} as Audit,
    {
      visible: async () => ({ version: 8, price: '99' }),
    } as unknown as ListingAccess,
  );
  worker.finish = async (_job, state) => {
    result = state;
  };
  assert.equal(await worker.once(), true);
  assert.equal(result, 'skipped');
});

test('enqueue binds the current server-owned consent version as a SQL parameter', async () => {
  let checked = false;
  const sql = {
    query: async (query: string, values: unknown[]) => {
      assert.match(query, /s\.consent_version\s*=\s*\$5/);
      assert.equal(values[4], listingSubscriptionConsentVersion);
      checked = true;
      return { rows: [] };
    },
  } as unknown as Sql;
  await enqueueImmediateListingEmails(sql, {
    listingId: '12345678-1234-4234-8234-123456789abc',
    version: 1,
    publicBefore: true,
    publicAfter: true,
    previousPrice: '100',
    price: '99',
  });
  assert.equal(checked, true);
});

test('worker binds current consent version before allowing subscription transport', async () => {
  const listingId = '12345678-1234-4234-8234-123456789abc';
  const job = {
    id: 'job',
    user_id: 'user',
    channel: 'email',
    kind: 'subscription.listing.price_drop',
    payload: {
      listingId,
      subscriptionVersion: 1,
      listingVersion: 8,
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10000,
        priceMinor: 9900,
      },
    },
    dedupe_key: 'event',
    attempts: 0,
  };
  const sql = { query: async () => ({ rows: [] }) };
  const db = {
    pool: sql,
    transaction: async (work: (value: unknown) => Promise<unknown>) =>
      work(sql),
    rows: async (query: string, values: unknown[]) => {
      if (query.includes('FOR UPDATE SKIP LOCKED')) return [job];
      if (query.includes('FROM users'))
        return [
          {
            active: true,
            email: 'user@example.test',
            email_enabled: true,
            email_verified_at: 'now',
          },
        ];
      if (query.includes('FROM notification_deliveries'))
        return [{ id: job.id }];
      assert.match(query, /consent_version\s*=\s*\$5/);
      assert.deepEqual(values, [
        'user',
        listingId,
        1,
        'price_drop',
        listingSubscriptionConsentVersion,
      ]);
      return [{}];
    },
  } as unknown as Database;
  let sends = 0;
  let result = '';
  const adapter = {
    configured: true,
    send: async () => {
      sends++;
    },
  } as NotificationAdapter;
  const worker = new NotificationWorker(
    db,
    adapter,
    {} as Audit,
    {
      visible: async () => ({ version: 8, price: '99' }),
    } as unknown as ListingAccess,
  );
  worker.finish = async (_job, state) => {
    result = state;
  };
  await worker.once();
  assert.equal(result, 'sent');
  assert.equal(sends, 1);
});

test('subscription transport stays in the transaction that locks its consent row', async () => {
  const job = {
    id: 'job',
    user_id: 'user',
    channel: 'email',
    kind: 'subscription.listing.price_drop',
    dedupe_key: 'event',
    attempts: 0,
    payload: {
      listingId: '12345678-1234-4234-8234-123456789abc',
      subscriptionVersion: 1,
      listingVersion: 8,
      event: {
        kind: 'price_drop',
        previousPriceMinor: 10000,
        priceMinor: 9900,
      },
    },
  };
  const sql = { query: async () => ({ rows: [] }) };
  let inTransaction = false;
  let consentLocked = false;
  let leaseLocked = false;
  const db = {
    pool: sql,
    transaction: async (work: (value: unknown) => Promise<unknown>) => {
      assert.equal(inTransaction, false, 'must not nest transactions');
      inTransaction = true;
      try {
        return await work(sql);
      } finally {
        inTransaction = false;
      }
    },
    rows: async (query: string, _values: unknown[], client: unknown) => {
      if (query.includes('FOR UPDATE SKIP LOCKED')) return [job];
      if (query.includes('FROM users'))
        return [
          {
            active: true,
            email: 'user@example.test',
            email_enabled: true,
            email_verified_at: 'now',
          },
        ];
      if (query.includes('FROM listing_subscriptions')) {
        assert.equal(inTransaction, true);
        assert.equal(client, sql);
        assert.match(query, /FOR UPDATE/);
        consentLocked = true;
        return [{}];
      }
      assert.equal(consentLocked, true);
      assert.equal(client, sql);
      if (query.includes('FOR UPDATE')) {
        leaseLocked = true;
      } else {
        assert.equal(
          leaseLocked,
          true,
          'check clock after acquiring the job lock',
        );
        assert.match(query, /clock_timestamp\(\)/);
      }
      return [{ id: job.id }];
    },
  } as unknown as Database;
  let sends = 0;
  const adapter = {
    configured: true,
    send: async () => {
      assert.equal(inTransaction, true);
      assert.equal(consentLocked && leaseLocked, true);
      sends++;
    },
  } as NotificationAdapter;
  const worker = new NotificationWorker(
    db,
    adapter,
    {
      record: async () => {},
    } as unknown as Audit,
    {
      visible: async () => ({ version: 8, price: '99' }),
    } as unknown as ListingAccess,
  );
  await worker.once();
  assert.equal(sends, 1);
});

test('republish serializes availability and price drop using only last public baseline', async () => {
  const calls: unknown[][] = [];
  const sql = {
    query: async (_query: string, values: unknown[]) => {
      calls.push(values);
      return { rows: [] };
    },
  } as unknown as Sql;
  const change = {
    listingId: '12345678-1234-4234-8234-123456789abc',
    version: 12,
    publicBefore: false,
    publicAfter: true,
    previousPrice: 'private-draft',
    lastPublicPrice: '100.10',
    price: '99.99',
  };
  assert.equal(await enqueueImmediateListingEmails(sql, change), 2);
  assert.deepEqual(calls, [
    [
      change.listingId,
      'availability',
      `listing:${change.listingId}:12:availability`,
      JSON.stringify({ kind: 'availability', available: true }),
      listingSubscriptionConsentVersion,
      12,
    ],
    [
      change.listingId,
      'price_drop',
      `listing:${change.listingId}:12:price_drop`,
      JSON.stringify({
        kind: 'price_drop',
        previousPriceMinor: 10010,
        priceMinor: 9999,
      }),
      listingSubscriptionConsentVersion,
      12,
    ],
  ]);
});

test('worker suppresses stale or nonpublic subscription events and forwards only current strict payload', async () => {
  const Worker = NotificationWorker as unknown as new (
    ...args: unknown[]
  ) => NotificationWorker;
  const current = {
    listingId: '12345678-1234-4234-8234-123456789abc',
    listingVersion: 8,
    subscriptionVersion: 1,
    event: { kind: 'price_drop', previousPriceMinor: 10000, priceMinor: 9900 },
  };
  for (const scenario of [
    { payload: current, visible: { version: 8, price: '99' }, allow: true },
    { payload: current, visible: { version: 9, price: '99' }, allow: false },
    { payload: current, visible: undefined, allow: false },
    { payload: current, visible: { version: 8, price: '98' }, allow: false },
    {
      payload: {
        ...current,
        event: { ...current.event, privateReason: 'secret' },
      },
      visible: { version: 8, price: '99' },
      allow: false,
    },
    {
      payload: {
        listingId: current.listingId,
        subscriptionVersion: 1,
        event: current.event,
      },
      visible: { version: 8, price: '99' },
      allow: false,
    },
  ]) {
    const job = {
      id: 'job',
      user_id: 'user',
      channel: 'email',
      kind: 'subscription.listing.price_drop',
      payload: scenario.payload,
      dedupe_key: 'event',
      attempts: 0,
    };
    const sql = { query: async () => ({ rows: [] }) };
    const db = {
      pool: sql,
      transaction: async (work: (value: unknown) => Promise<unknown>) =>
        work(sql),
      rows: async (query: string) =>
        query.includes('FOR UPDATE SKIP LOCKED')
          ? [job]
          : query.includes('FROM users')
            ? [
                {
                  active: true,
                  email: 'subscriber@example.test',
                  email_enabled: true,
                  email_verified_at: 'now',
                },
              ]
            : [{}],
    } as unknown as Database;
    let sends = 0;
    const worker = new Worker(
      db,
      {
        configured: true,
        send: async () => {
          sends++;
        },
      },
      {} as Audit,
      {
        visible: async (_id: string, client: Sql) => {
          assert.equal(client, sql);
          return scenario.visible;
        },
      },
    );
    let result = '';
    worker.finish = async (_job, state) => {
      result = state;
    };
    await worker.once();
    assert.equal(sends, scenario.allow ? 1 : 0);
    assert.equal(result, scenario.allow ? 'sent' : 'skipped');
  }
});

test('worker refreshes lease after final visibility query before transport', async () => {
  const job = {
    id: 'job',
    user_id: 'user',
    channel: 'email',
    kind: 'subscription.listing.availability',
    attempts: 0,
    payload: {
      listingId: '12345678-1234-4234-8234-123456789abc',
      listingVersion: 8,
      subscriptionVersion: 1,
      event: { kind: 'availability', available: true },
    },
    dedupe_key: 'event',
  };
  const sql = { query: async () => ({ rows: [] }) };
  let visibilityRead = false;
  const db = {
    pool: sql,
    transaction: async (work: (client: unknown) => Promise<unknown>) =>
      work(sql),
    rows: async (query: string) => {
      if (query.includes('FOR UPDATE SKIP LOCKED')) return [job];
      if (query.includes('FROM users'))
        return [
          { active: true, email_enabled: true, email_verified_at: 'now' },
        ];
      if (query.includes('clock_timestamp()') && visibilityRead) return [];
      return [{}];
    },
  } as unknown as Database;
  let sends = 0;
  const worker = new NotificationWorker(
    db,
    {
      configured: true,
      send: async () => {
        sends++;
      },
    } as NotificationAdapter,
    {} as Audit,
    {
      visible: async () => {
        visibilityRead = true;
        return { version: 8, price: '99' };
      },
    } as unknown as ListingAccess,
  );
  worker.finish = async () => {
    throw new Error('Expired lease must remain recoverable, not finalized');
  };
  await worker.once();
  assert.equal(visibilityRead, true);
  assert.equal(sends, 0);
});

test('unavailable events use one neutral authoritative state snapshot without loading listing fields', async () => {
  for (const state of [
    { version: 8, visible: false },
    { version: 8, visible: true },
    { version: 9, visible: false },
  ]) {
    const payload = {
      listingId: '12345678-1234-4234-8234-123456789abc',
      listingVersion: 8,
      subscriptionVersion: 1,
      event: { kind: 'availability', available: false },
    };
    const job = {
      id: 'job',
      user_id: 'user',
      channel: 'email',
      kind: 'subscription.listing.availability',
      attempts: 0,
      dedupe_key: 'event',
      payload,
    };
    const sql = { query: async () => ({ rows: [] }) };
    const db = {
      pool: sql,
      transaction: async (work: (client: unknown) => Promise<unknown>) =>
        work(sql),
      rows: async (query: string) =>
        query.includes('FOR UPDATE SKIP LOCKED')
          ? [job]
          : query.includes('FROM users')
            ? [{ active: true, email_enabled: true, email_verified_at: 'now' }]
            : [{}],
    } as unknown as Database;
    let sends = 0;
    const access = {
      visible: async () => {
        throw new Error('Must not fetch listing fields for unavailable notice');
      },
      currentVisibility: async (id: string, client: Sql) => {
        assert.equal(id, payload.listingId);
        assert.equal(client, sql);
        return state;
      },
    } as unknown as ListingAccess;
    const worker = new NotificationWorker(
      db,
      {
        configured: true,
        send: async (envelope) => {
          sends++;
          assert.deepEqual(envelope.payload, payload);
        },
      } as NotificationAdapter,
      {} as Audit,
      access,
    );
    let result = '';
    worker.finish = async (_job, outcome) => {
      result = outcome;
    };
    await worker.once();
    assert.equal(sends, state.version === 8 && !state.visible ? 1 : 0);
    assert.equal(
      result,
      state.version === 8 && !state.visible ? 'sent' : 'skipped',
    );
  }
});
