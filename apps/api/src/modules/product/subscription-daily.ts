import { z } from 'zod';
import { Database } from '../database/database';
import { ListingAccess } from '../listings/access';
import {
  listingSubscriptionConsentVersion,
  listingSubscriptionDeliverySchema,
} from './subscription-contract';
import { eligibleListingSubscriptionEvent } from './subscription-eligibility';

/** Operational defaults, not a business promise or subscription quota. */
export function dailySubscriptionSettings(
  env: NodeJS.ProcessEnv = process.env,
) {
  const settings = z
    .object({
      LISTING_DAILY_TIMEZONE: z
        .string()
        .default('Europe/Moscow')
        .refine((value) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }),
      LISTING_DAILY_RELEASE_HOUR: z.coerce
        .number()
        .int()
        .min(0)
        .max(23)
        .default(9),
      LISTING_DAILY_TTL_HOURS: z.coerce
        .number()
        .int()
        .min(1)
        .max(168)
        .default(48),
    })
    .parse(env);
  return {
    timeZone: settings.LISTING_DAILY_TIMEZONE,
    hour: settings.LISTING_DAILY_RELEASE_HOUR,
    ttlHours: settings.LISTING_DAILY_TTL_HOURS,
  };
}
export function dailyReleaseSlot(
  now: Date,
  settings: ReturnType<typeof dailySubscriptionSettings>,
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return Number(part('hour')) >= settings.hour
    ? day
    : new Date(Date.parse(day + 'T00:00:00Z') - 86400000)
        .toISOString()
        .slice(0, 10);
}
interface Candidate {
  id: string;
  listing_id: string;
  subscription_version: number;
  listing_version: number;
  kind: string;
  dedupe_key: string;
  payload: unknown;
  fresh: boolean;
}
interface Subscription {
  listing_id: string;
  version: number;
  disabled_at: unknown;
  consent_version: string;
  frequency: string;
  events: string[];
  channels: string[];
}
/** One bounded batch; user -> ordered subscriptions -> run -> candidate. No provider transport. */
export async function releaseDailyInbox(
  db: Database,
  access: ListingAccess,
): Promise<boolean> {
  const settings = dailySubscriptionSettings();
  const [clock] = await db.rows<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  );
  if (!clock) return false;
  const day = dailyReleaseSlot(new Date(clock.now), settings);
  // Unlocked scheduling hint only; every decision is rechecked under recipient mutex.
  const [next] = await db.rows<{ user_id: string }>(
    `SELECT user_id FROM (
       SELECT user_id FROM listing_daily_runs WHERE released_at IS NULL
       UNION
       SELECT c.user_id FROM listing_daily_candidates c
       WHERE c.created_at<=($1::date+make_interval(hours=>$2)) AT TIME ZONE $3
        AND NOT EXISTS(SELECT 1 FROM listing_daily_items i WHERE i.candidate_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM listing_daily_runs r WHERE r.user_id=c.user_id AND r.release_day=$1 AND r.released_at IS NOT NULL)
     ) pending ORDER BY user_id LIMIT 1`,
    [day, settings.hour, settings.timeZone],
  );
  if (!next) return false;
  return db.transaction(async (sql) => {
    const [user] = await db.rows<{ active: boolean }>(
      'SELECT active FROM users WHERE id=$1 FOR NO KEY UPDATE',
      [next.user_id],
      sql,
    );
    if (!user) return false;
    const subscriptions = await db.rows<Subscription>(
      'SELECT listing_id,version,disabled_at,consent_version,frequency,events,channels FROM listing_subscriptions WHERE user_id=$1 ORDER BY listing_id FOR UPDATE',
      [next.user_id],
      sql,
    );
    // Current wall clock and local slot are recomputed after potentially waiting for locks.
    const [lockedClock] = await db.rows<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
      [],
      sql,
    );
    const lockedDay = dailyReleaseSlot(new Date(lockedClock!.now), settings);
    let [run] = await db.rows<{ id: string; cutoff: Date }>(
      'SELECT id,cutoff FROM listing_daily_runs WHERE user_id=$1 AND released_at IS NULL ORDER BY release_day LIMIT 1 FOR UPDATE',
      [next.user_id],
      sql,
    );
    if (!run)
      [run] = await db.rows<{ id: string; cutoff: Date }>(
        `INSERT INTO listing_daily_runs(user_id,release_day,cutoff) VALUES($1,$2,($2::date+make_interval(hours=>$3)) AT TIME ZONE $4) ON CONFLICT(user_id,release_day) DO NOTHING RETURNING id,cutoff`,
        [next.user_id, lockedDay, settings.hour, settings.timeZone],
        sql,
      );
    if (!run) return false; // Another coordinator has already completed this day.
    const [prefs] = await db.rows<{ in_app: boolean }>(
      'SELECT in_app FROM notification_preferences WHERE user_id=$1',
      [next.user_id],
      sql,
    );
    const candidates = await db.rows<Candidate>(
      `SELECT c.*,c.expires_at>clock_timestamp() AS fresh FROM listing_daily_candidates c WHERE c.user_id=$1 AND c.created_at<=$2 AND NOT EXISTS(SELECT 1 FROM listing_daily_items i WHERE i.candidate_id=c.id) ORDER BY c.id LIMIT 100 FOR UPDATE OF c`,
      [next.user_id, run.cutoff],
      sql,
    );
    for (const candidate of candidates) {
      const parsed = listingSubscriptionDeliverySchema.safeParse(
        candidate.payload,
      );
      const sub = subscriptions.find(
        (s) => s.listing_id === candidate.listing_id,
      );
      let notificationId: string | null = null;
      if (
        candidate.fresh &&
        user.active &&
        (prefs?.in_app ?? true) &&
        parsed.success &&
        parsed.data.listingId === candidate.listing_id &&
        parsed.data.subscriptionVersion === candidate.subscription_version &&
        parsed.data.listingVersion === candidate.listing_version &&
        sub?.disabled_at === null &&
        sub.version === candidate.subscription_version &&
        sub.consent_version === listingSubscriptionConsentVersion &&
        sub.frequency === 'daily' &&
        sub.channels.includes('in_app') &&
        sub.events.includes(parsed.data.event.kind) &&
        (await eligibleListingSubscriptionEvent(
          access,
          candidate.kind,
          candidate.payload,
          sql,
        ))
      ) {
        const [item] = await db.rows<{ id: string }>(
          `INSERT INTO notifications(user_id,kind,listing_id,subscription_version,listing_version,dedupe_key,payload,captured_frequency,daily_run_id) SELECT $1,$2,$3,$4,$5,$6,$7,'daily',$8 WHERE EXISTS(SELECT 1 FROM listing_daily_candidates c WHERE c.id=$9 AND c.expires_at>clock_timestamp()) ON CONFLICT(user_id,dedupe_key) WHERE kind IN ('subscription.listing.price_drop','subscription.listing.availability') DO NOTHING RETURNING id::text`,
          [
            next.user_id,
            candidate.kind,
            candidate.listing_id,
            candidate.subscription_version,
            candidate.listing_version,
            candidate.dedupe_key,
            JSON.stringify(candidate.payload),
            run.id,
            candidate.id,
          ],
          sql,
        );
        notificationId = item?.id ?? null;
      }
      await sql.query(
        'INSERT INTO listing_daily_items(run_id,user_id,candidate_id,notification_id,outcome) VALUES($1,$2,$3,$4,$5)',
        [
          run.id,
          next.user_id,
          candidate.id,
          notificationId,
          notificationId ? 'released' : 'skipped',
        ],
      );
    }
    // Atomic visibility switch. Late commits after this statement stay unassigned for next day.
    await sql.query(
      `UPDATE listing_daily_runs r SET released_at=clock_timestamp() WHERE r.id=$1 AND r.cutoff<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM listing_daily_candidates c WHERE c.user_id=r.user_id AND c.created_at<=r.cutoff AND NOT EXISTS(SELECT 1 FROM listing_daily_items i WHERE i.candidate_id=c.id))`,
      [run.id],
    );
    return true;
  });
}
