import 'reflect-metadata';
import { test } from 'node:test';
import { Audit } from './modules/audit/audit';
import assert from 'node:assert/strict';
import {
  PublicationQuotas,
  PublicationSeller,
} from './modules/listings/publication-quota';
import { Database, Sql } from './modules/database/database';
const owner = { id: 'fixture', role: 'owner' } as PublicationSeller;
const sql = {} as Sql;
const decisionAt = new Date('2026-10-31T21:00:00Z');
function quotas(active: number, monthly: number, same = false) {
  return new PublicationQuotas({
    rows: async () => [
      {
        published_objects: String(active),
        monthly_publications: String(monthly),
        already_published: same,
      },
    ],
  } as unknown as Database);
}
test('v1.1 rejects a second active listing even for the same property', async () => {
  await assert.rejects(
    quotas(1, 1).assertCapacity(sql, owner, 'new-listing', decisionAt),
    /одно активное/,
  );
});
test('v1.1 enforces monthly publication limit after freeing active capacity', async () => {
  await assert.rejects(
    quotas(0, 3).assertCapacity(sql, owner, 'new-listing', decisionAt),
    /три публикации/,
  );
  await quotas(0, 2).assertCapacity(sql, owner, 'new-listing', decisionAt);
});
test('v1.1 quota permits unchanged publication and exempts professional roles', async () => {
  await quotas(1, 3, true).assertCapacity(
    sql,
    owner,
    'current-listing',
    decisionAt,
  );
  await quotas(8, 8).assertCapacity(
    sql,
    { ...owner, role: 'agent' },
    'new-listing',
    decisionAt,
  );
});

test('quota binds one decision timestamp for both Moscow month boundaries', async () => {
  let query = '';
  let bindings: unknown[] = [];
  const quota = new PublicationQuotas({
    rows: async (text: string, values: unknown[]) => {
      query = text;
      bindings = values;
      return [
        {
          published_objects: '0',
          monthly_publications: '2',
          already_published: false,
        },
      ];
    },
  } as unknown as Database);
  await quota.assertCapacity(sql, owner, 'new-listing', decisionAt);
  assert.equal(bindings[2], decisionAt);
  assert.equal(query.includes('clock_timestamp()'), false);
  assert.equal((query.match(/\$3::timestamptz/g) ?? []).length, 2);
});

test('publication history records the exact quota decision timestamp', async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const connection = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
    },
  } as unknown as Sql;
  await new Audit({} as Database).history(
    connection,
    'reviewer',
    'listing',
    'moderation.decided',
    { status: 'moderation' },
    { status: 'published' },
    decisionAt,
  );
  assert.match(calls[0]!.text, /created_at/);
  assert.equal(calls[0]!.values[5], decisionAt);
  calls.length = 0;
  await new Audit({} as Database).history(
    connection,
    'reviewer',
    'listing',
    'changed',
    {},
    {},
  );
  assert.equal(calls[0]!.values[5], null);
});
