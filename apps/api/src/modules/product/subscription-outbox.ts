import { dailySubscriptionSettings } from './subscription-daily';
import { Sql } from '../database/database';
import { listingSubscriptionConsentVersion } from './subscription-contract';
import { listingSubscriptionEvents } from './subscription-events';

/** Call in the same transaction as the authoritative public listing change. */
export async function enqueueImmediateListingNotifications(
  sql: Sql,
  change: Parameters<typeof listingSubscriptionEvents>[0],
) {
  // Valid database NUMERIC prices may exceed the monetary email envelope.
  // Suppress that optional event only; malformed prices retain strict validation.
  const oversized = (value: string | null | undefined) => {
    if (value == null) return false;
    if (!/^[0-9]{1,14}(?:\.[0-9]{1,2})?$/.test(value))
      throw new Error('Invalid subscription price');
    const [whole, fraction = ''] = value.split('.');
    const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (minor <= 0n) throw new Error('Subscription price out of range');
    return minor > BigInt(Number.MAX_SAFE_INTEGER);
  };
  const baseline = change.publicBefore
    ? change.previousPrice
    : change.lastPublicPrice;
  const previousOversized =
    change.publicAfter && baseline != null ? oversized(baseline) : false;
  const currentOversized =
    change.publicAfter && baseline != null ? oversized(change.price) : false;
  const events = listingSubscriptionEvents({
    ...change,
    omitPriceDrop: previousOversized || currentOversized,
  });
  for (const { key, event } of events) {
    const eventName = event.kind;
    if (eventName === 'subscribed') continue;
    await sql.query(
      `WITH eligible AS MATERIALIZED (
         SELECT s.*,COALESCE(p.in_app,true) AS in_app_enabled
         FROM listing_subscriptions s JOIN users u ON u.id=s.user_id
         LEFT JOIN notification_preferences p ON p.user_id=s.user_id
         WHERE s.listing_id=$1 AND s.disabled_at IS NULL AND s.frequency IN ('immediate','daily')
           AND s.consent_version=$5 AND $2=ANY(s.events) AND u.active
         ORDER BY s.user_id,s.listing_id FOR UPDATE OF s
       ), emails AS (
         INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
         SELECT s.user_id,'email','subscription.listing.'||$2,$3,
           jsonb_build_object('listingId',s.listing_id,'subscriptionVersion',s.version,'listingVersion',$6::integer,'event',$4::jsonb)
         FROM eligible s WHERE s.frequency='immediate' AND 'email'=ANY(s.channels)
         ON CONFLICT(user_id,channel,dedupe_key) DO NOTHING
       ), daily AS (
         INSERT INTO listing_daily_candidates(user_id,listing_id,subscription_version,listing_version,kind,dedupe_key,payload,expires_at)
         SELECT s.user_id,s.listing_id,s.version,$6::integer,'subscription.listing.'||$2,$3,
           jsonb_build_object('listingId',s.listing_id,'subscriptionVersion',s.version,'listingVersion',$6::integer,'event',$4::jsonb),
           clock_timestamp()+make_interval(hours=>$7)
         FROM eligible s WHERE s.frequency='daily' AND 'in_app'=ANY(s.channels) AND s.in_app_enabled
         ON CONFLICT(user_id,dedupe_key) DO NOTHING
       )
       INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload)
       SELECT s.user_id,'subscription.listing.'||$2,s.listing_id,s.version,$6::integer,$3,
         jsonb_build_object('listingId',s.listing_id,'subscriptionVersion',s.version,'listingVersion',$6::integer,'event',$4::jsonb)
       FROM eligible s WHERE s.frequency='immediate' AND 'in_app'=ANY(s.channels) AND s.in_app_enabled
       ON CONFLICT(user_id,dedupe_key) WHERE kind IN ('subscription.listing.price_drop','subscription.listing.availability') DO NOTHING`,
      [
        change.listingId,
        eventName,
        key,
        JSON.stringify(event),
        listingSubscriptionConsentVersion,
        change.version,
        dailySubscriptionSettings().ttlHours,
      ],
    );
  }
  return events.length;
}
