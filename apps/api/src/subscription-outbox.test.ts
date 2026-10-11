import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueImmediateListingEmails } from './modules/product/subscription-outbox';
import { Database, Sql } from './modules/database/database';
import {
  NotificationWorker,
  NotificationAdapter,
} from './modules/professional/notifications';
import { listingSubscriptionConsentVersion } from './modules/product/subscription-contract';
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
      event: { kind: 'price_drop' },
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
  const worker = new NotificationWorker(db, adapter, {} as Audit);
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
      event: { kind: 'price_drop' },
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
  const worker = new NotificationWorker(db, adapter, {} as Audit);
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
      event: { kind: 'price_drop' },
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
  const worker = new NotificationWorker(db, adapter, {
    record: async () => {},
  } as unknown as Audit);
  await worker.once();
  assert.equal(sends, 1);
});
