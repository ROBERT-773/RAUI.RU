import type { AccountNotification } from '@raui/types/product';
import { Database, Sql } from '../database/database';
import { ListingAccess } from '../listings/access';
import {
  listingSubscriptionConsentVersion,
  listingSubscriptionDeliverySchema,
} from './subscription-contract';
import { eligibleListingSubscriptionEvent } from './subscription-eligibility';
export interface InboxRow {
  id: string;
  kind: string;
  thread_id: string | null;
  listing_id: string | null;
  listing_version: number | null;
  subscription_version: number | null;
  payload: unknown;
  captured_frequency?: string | null;
  daily_run_id?: string | null;
  daily_released?: boolean;
  read_at: Date | string | null;
  created_at: Date | string;
}
const timestamp = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : value;
/** User -> ordered subscriptions -> optional notification update. No listing locks. */
export async function eligibleInboxRows(
  db: Database,
  access: ListingAccess,
  userId: string,
  rows: InboxRow[],
  sql: Sql,
): Promise<AccountNotification[]> {
  const candidates = rows.filter((row) =>
    row.kind.startsWith('subscription.listing.'),
  );
  let subscriptions: {
    listing_id: string;
    version: number;
    disabled_at: unknown;
    consent_version: string;
    frequency: string;
    events: string[];
    channels: string[];
  }[] = [];
  if (candidates.length) {
    // Compatible with producer INSERT's FK KEY SHARE, unlike FOR UPDATE.
    const [user] = await db.rows<{ active: boolean }>(
      'SELECT active FROM users WHERE id=$1 FOR NO KEY UPDATE',
      [userId],
      sql,
    );
    const [prefs] = await db.rows<{ in_app: boolean }>(
      'SELECT in_app FROM notification_preferences WHERE user_id=$1',
      [userId],
      sql,
    );
    if (user?.active && (prefs?.in_app ?? true)) {
      const ids = [
        ...new Set(
          candidates
            .map((row) => row.listing_id)
            .filter((id): id is string => id !== null),
        ),
      ].sort();
      subscriptions = await db.rows(
        'SELECT listing_id,version,disabled_at,consent_version,frequency,events,channels FROM listing_subscriptions WHERE user_id=$1 AND listing_id=ANY($2::uuid[]) ORDER BY listing_id FOR UPDATE',
        [userId, ids],
        sql,
      );
    }
  }
  const result: AccountNotification[] = [];
  for (const row of rows) {
    const base = {
      id: String(row.id),
      read_at: row.read_at === null ? null : timestamp(row.read_at),
      created_at: timestamp(row.created_at),
    };
    if (row.kind === 'message' && row.thread_id !== null) {
      result.push({ ...base, kind: 'message', thread_id: row.thread_id });
      continue;
    }
    const parsed = listingSubscriptionDeliverySchema.safeParse(row.payload);
    if (
      !parsed.success ||
      parsed.data.listingId !== row.listing_id ||
      parsed.data.listingVersion !== row.listing_version ||
      parsed.data.subscriptionVersion !== row.subscription_version
    )
      continue;
    const s = subscriptions.find((s) => s.listing_id === row.listing_id);
    if (
      !s ||
      s.disabled_at !== null ||
      s.version !== row.subscription_version ||
      s.consent_version !== listingSubscriptionConsentVersion ||
      s.frequency !== (row.captured_frequency ?? 'immediate') ||
      (row.captured_frequency === 'daily' &&
        (!row.daily_run_id || row.daily_released !== true)) ||
      (row.captured_frequency !== 'daily' && row.daily_run_id != null) ||
      !s.channels.includes('in_app') ||
      !s.events.includes(parsed.data.event.kind)
    )
      continue;
    const payload = await eligibleListingSubscriptionEvent(
      access,
      row.kind,
      row.payload,
      sql,
    );
    if (!payload) continue;
    if (payload.event.kind === 'price_drop')
      result.push({
        ...base,
        kind: 'subscription.listing.price_drop',
        listing_id: payload.listingId,
        event: payload.event,
      });
    else
      result.push({
        ...base,
        kind: 'subscription.listing.availability',
        listing_id: payload.listingId,
        event: payload.event,
      });
  }
  return result;
}
