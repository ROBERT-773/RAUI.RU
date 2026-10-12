import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ListingSubscriptions } from './modules/product/subscriptions';
import { Database } from './modules/database/database';
import { ListingAccess } from './modules/listings/access';
import { Actor } from './common/security';

const actor = { id: '12345678-1234-4234-8234-123456789abc' } as Actor;
const id = '22345678-1234-4234-8234-123456789abc';
const preferences = {
  events: ['price_drop'],
  channels: ['email'],
  frequency: 'immediate',
  version: 0,
  consent: true,
};
test('private listing subscription is rejected before database writes', async () => {
  const service = new ListingSubscriptions(
    {
      rows: async () => {
        throw new Error('Unexpected database write');
      },
    } as unknown as Database,
    { visible: async () => false } as unknown as ListingAccess,
  );
  await assert.rejects(
    service.subscribe(actor, id, preferences),
    NotFoundException,
  );
});
test('subscription writes bind ownership to actor and persist explicit consent', async () => {
  let values: unknown[] = [];
  const service = new ListingSubscriptions(
    {
      rows: async (query: string, args: unknown[]) => {
        if (query.startsWith('SELECT version')) return [];
        values = args;
        return [{ version: 1 }];
      },
      transaction: async (work: (sql: unknown) => Promise<unknown>) =>
        work({ query: async () => ({ rows: [] }) }),
    } as unknown as Database,
    { visible: async () => true } as unknown as ListingAccess,
  );
  await service.subscribe(actor, id, preferences);
  assert.deepEqual(values, [
    actor.id,
    id,
    ['price_drop'],
    ['email'],
    'immediate',
    'listing-updates-v1',
  ]);
});
test('disable rejects another account and stale versions without mutation', async () => {
  for (const current of [[], [{ version: 2 }]]) {
    const db = {
      rows: async (_query: string, args: unknown[]) => {
        assert.deepEqual(args, [actor.id, id]);
        return current;
      },
      transaction: async (work: (sql: unknown) => Promise<unknown>) =>
        work({
          query: async (text: string) => {
            if (text.startsWith('SELECT pg_advisory')) return { rows: [] };
            throw new Error('Unexpected mutation');
          },
        }),
    } as unknown as Database;
    const service = new ListingSubscriptions(db, {} as ListingAccess);
    await assert.rejects(
      service.disable(actor, id, { version: 1 }),
      current.length ? ConflictException : NotFoundException,
    );
  }
});
