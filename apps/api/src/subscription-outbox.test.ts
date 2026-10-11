import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueImmediateListingEmails } from './modules/product/subscription-outbox';
import { Database, Sql } from './modules/database/database';
import {
  NotificationWorker,
  NotificationAdapter,
} from './modules/professional/notifications';
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
