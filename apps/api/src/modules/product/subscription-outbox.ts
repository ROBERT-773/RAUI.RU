import { listingSubscriptionConsentVersion } from './subscription-contract';
import { Sql } from '../database/database';
import { listingSubscriptionEvents } from './subscription-events';

/** Call in the same transaction as the authoritative public listing change. */
export async function enqueueImmediateListingEmails(
  sql: Sql,
  change: Parameters<typeof listingSubscriptionEvents>[0],
) {
  const events = listingSubscriptionEvents(change);
  for (const { key, event } of events) {
    const eventName = event.kind;
    if (eventName === 'subscribed') continue;
    await sql.query(
      `INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
       SELECT s.user_id,'email','subscription.listing.'||$2,$3,
         jsonb_build_object('listingId',s.listing_id,'subscriptionVersion',s.version,'event',$4::jsonb)
       FROM listing_subscriptions s JOIN users u ON u.id=s.user_id
       WHERE s.listing_id=$1 AND s.disabled_at IS NULL AND s.frequency='immediate'
         AND s.consent_version=$5 AND 'email'=ANY(s.channels) AND $2=ANY(s.events) AND u.active
       ON CONFLICT(user_id,channel,dedupe_key) DO NOTHING`,
      [
        change.listingId,
        eventName,
        key,
        JSON.stringify(event),
        listingSubscriptionConsentVersion,
      ],
    );
  }
  return events.length;
}
