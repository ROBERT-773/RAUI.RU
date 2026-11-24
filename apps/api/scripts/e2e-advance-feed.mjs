import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

// Only move the test feed's due time. The production scheduler, importer and
// publication service perform every subsequent operation normally.
const url = new URL(process.env.DATABASE_URL ?? '');
const [feedId, key, revision] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.E2E_TRUSTED_FEEDS !== 'true' ||
  !['local', undefined].includes(process.env.DEPLOYMENT_ENV) ||
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !/^\/raui_test_[a-f0-9]{16}$/.test(url.pathname) ||
  !uuid.test(feedId) ||
  !uuid.test(key) ||
  !['price-updated', 'invalid-photo'].includes(revision) ||
  !process.env.LOCAL_PRIVATE_DIR
)
  throw new Error('Requires an isolated trusted XML browser fixture');
const fixtureUrl = 'https://xml-fixture.example.test/trusted-' + key + '.xml';
const pool = new Pool({ connectionString: url.toString() });
try {
  await writeFile(
    join(process.env.LOCAL_PRIVATE_DIR, key + '.' + revision),
    '',
  );
  const result = await pool.query(
    "UPDATE professional_feed_definitions SET next_run_at=now() WHERE id=$1 AND transport->>'url'=$2 AND transport->>'linkSlot'='true' AND active AND publication_approved_at IS NOT NULL",
    [feedId, fixtureUrl],
  );
  if (result.rowCount !== 1)
    throw new Error('Scheduled fixture source not found');
} finally {
  await pool.end();
}
