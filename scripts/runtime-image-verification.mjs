import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { readdirSync, readlinkSync, readFileSync } from 'node:fs';

// Exact immutable migration set in this source revision; update only when a new
// migration is added. A truncated manifest must not bless an incomplete image.
export const migrationNames = [
  '001_core.sql',
  '002_search_product.sql',
  '003_commerce.sql',
  '004_commerce_reconciliation.sql',
  '005_professional_integrations.sql',
  '006_professional_workflows.sql',
  '007_partner_clients.sql',
  '008_professional_operations.sql',
  '009_ai_trust_analytics.sql',
  '010_analytics_identity_and_trust_geo.sql',
  '011_ai_reported_cost.sql',
  '012_search_queue_observability.sql',
  '013_region_search.sql',
  '014_user_public_id.sql',
  '015_staff_permissions.sql',
  '016_registration_approval.sql',
  '017_phone_otp.sql',
];
export async function verifyMigrationPackage(root) {
  const directory = resolve(root, 'apps/api/migrations');
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort(),
    migrationNames,
    'Complete migration SQL package required',
  );
  const rows = (await readFile(resolve(root, 'migration-sha256.txt'), 'utf8'))
    .trim()
    .split('\n');
  const files = [];
  for (const row of rows) {
    const match = row.match(
      /^([a-f0-9]{64})\s+(apps\/api\/migrations\/\d+_[a-z0-9_]+\.sql)$/,
    );
    assert.ok(match, 'Invalid migration checksum manifest');
    const [, hash, file] = match;
    files.push(file.replace('apps/api/migrations/', ''));
    assert.equal(
      createHash('sha256')
        .update(await readFile(resolve(root, file)))
        .digest('hex'),
      hash,
      'Migration checksum mismatch',
    );
  }
  assert.deepEqual(
    files.sort(),
    migrationNames,
    'Complete nonduplicate migration checksum manifest required',
  );
}
export async function assertLocalPortsFree(ports) {
  const reserved = [];
  try {
    for (const port of ports) {
      const server = createServer();
      await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', done);
      });
      reserved.push(server);
    }
  } catch {
    throw Error(
      'Local runtime ports unavailable; do not start fixtures against existing services',
    );
  } finally {
    await Promise.all(
      reserved.map((server) => new Promise((done) => server.close(done))),
    );
  }
}
export async function cleanupRuntimeResources(actions) {
  const failures = [];
  for (const [name, action] of actions) {
    try {
      await action();
    } catch {
      failures.push(name);
    }
  }
  if (failures.length)
    throw Error(`Runtime cleanup failed: ${failures.join(', ')}`);
}

export function ownsListeningPort(port, pid = 1) {
  try {
    const inodes = new Set(
      readdirSync(`/proc/${pid}/fd`).flatMap((name) => {
        try {
          return [
            readlinkSync(`/proc/${pid}/fd/${name}`).match(
              /^socket:\[(\d+)\]$/,
            )?.[1],
          ];
        } catch {
          return [];
        }
      }),
    );
    return readFileSync('/proc/net/tcp', 'utf8')
      .split('\n')
      .slice(1)
      .map((row) => row.trim().split(/\s+/))
      .some(
        (row) =>
          row[3] === '0A' &&
          parseInt(row[1]?.split(':')[1], 16) === port &&
          inodes.has(row[9]),
      );
  } catch {
    return false;
  }
}
