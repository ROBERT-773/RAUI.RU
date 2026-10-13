import { z } from 'zod';
import { Sql } from '../database/database';
import { ListingAccess } from '../listings/access';
import { listingSubscriptionDeliverySchema } from './subscription-contract';
import { priceMinor } from './subscription-events';
export type ListingSubscriptionDelivery = z.infer<
  typeof listingSubscriptionDeliverySchema
>;

/** Caller owns recipient/channel/consent authorization; no row locks or private projections here. */
export async function eligibleListingSubscriptionEvent(
  access: ListingAccess,
  kind: string,
  value: unknown,
  sql?: Sql,
): Promise<ListingSubscriptionDelivery | null> {
  const parsed = listingSubscriptionDeliverySchema.safeParse(value);
  if (
    !parsed.success ||
    kind !== `subscription.listing.${parsed.data.event.kind}`
  )
    return null;
  const payload = parsed.data;
  const event = payload.event;
  if (event.kind === 'availability' && !event.available) {
    const current = await access.currentVisibility(payload.listingId, sql);
    return current &&
      !current.visible &&
      current.version === payload.listingVersion
      ? payload
      : null;
  }
  const visible = await access.visible(payload.listingId, sql);
  if (visible?.version !== payload.listingVersion) return null;
  if (event.kind === 'availability') return payload;
  try {
    return visible.price !== null &&
      priceMinor(visible.price) === event.priceMinor
      ? payload
      : null;
  } catch {
    return null;
  }
}
