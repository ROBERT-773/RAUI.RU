import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
// Destructive test operations are restricted to a newly created local database.
const source = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(source.hostname) ||
  process.env.NODE_ENV === 'production'
)
  throw new Error(
    'Integration requires an explicit local development DATABASE_URL',
  );
for (const testFile of [
  'migration.integration.test.js',
  'core.integration.test.js',
  'staff-permissions.integration.test.js',
  'public-id.integration.test.js',
  'registration-approval.integration.test.js',
  'publication-quota.integration.test.js',
  'phone-otp.integration.test.js',
  'search.integration.test.js',
  'commerce.integration.test.js',
  'professional.integration.test.js',
  'ai-trust.integration.test.js',
]) {
  const name = `raui_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: source.toString() });
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(source);
  target.pathname = `/${name}`;
  const directory = resolve('.cache/integration', name);
  try {
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(
        process.execPath,
        ['--test', '.cache/test/' + testFile],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            OPENSEARCH_ALIAS: name.replaceAll('_', '-'),
            DATABASE_URL: target.toString(),
            TEST_DATABASE_URL: target.toString(),
            LOCAL_PRIVATE_DIR: directory,
            STORAGE_DRIVER: 'local',
          },
        },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolveCode(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }

  if (process.exitCode) break;
}
