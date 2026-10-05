import { Pool } from 'pg';
const url = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !/^\/raui_test_[0-9a-f]{16}$/.test(url.pathname) ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Requires isolated E2E database');
const pool = new Pool({ connectionString: url.toString() });
try {
  await pool.query('DELETE FROM rate_limits');
} finally {
  await pool.end();
}
