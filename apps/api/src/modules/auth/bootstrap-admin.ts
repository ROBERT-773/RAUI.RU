import { Pool } from 'pg';
import { loadConfig } from '../../config';
// Deliberate operator command; never an HTTP route or migration default.
async function main() {
  const email = process.argv[2]?.toLowerCase();
  if (!email)
    throw new Error('Usage: bootstrap-admin <existing verified email>');
  const pool = new Pool({ connectionString: loadConfig().DATABASE_URL });
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    const result = await sql.query<{ id: string }>(
      "UPDATE users SET role='admin',updated_at=now() WHERE email=$1 AND active AND email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL RETURNING id",
      [email],
    );
    if (!result.rows[0]) throw new Error('Verified active user required');
    const id = result.rows[0].id;
    await sql.query(
      'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
      [id],
    );
    await sql.query(
      "INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,'operator.admin.bootstrap','user',$2)",
      [id, id],
    );
    await sql.query('COMMIT');
    console.log('Admin granted; sign in again');
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  } finally {
    sql.release();
    await pool.end();
  }
}
void main().catch(() => {
  console.error('Admin bootstrap failed; no changes committed');
  process.exitCode = 1;
});
