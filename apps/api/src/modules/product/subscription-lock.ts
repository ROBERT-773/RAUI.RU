import type { Sql } from '../database/database';
/** Shared by preference mutations and delivery through transport completion.
 * A completed unsubscribe prevents any subsequently started send. A send that
 * owns the lock completes first; external delivery cannot be recalled. */
export async function lockListingSubscription(
  sql: Sql,
  user: string,
  listing: string,
) {
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `listing-subscription:${user}:${listing}`,
  ]);
}
