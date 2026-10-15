import type { ListingEmailEvent } from '../professional/email-templates';

export function priceMinor(value: string): number {
  if (!/^[0-9]{1,14}(?:\.[0-9]{1,2})?$/.test(value))
    throw new Error('Invalid subscription price');
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Subscription price out of range');
  return Number(minor);
}

/** Public eligibility must come from the authoritative listing access policy. */
export function listingSubscriptionEvents(input: {
  listingId: string;
  version: number;
  publicBefore: boolean;
  publicAfter: boolean;
  /** Immediately prior public price when publicBefore=true; never a draft fallback. */
  previousPrice: string;
  /** Optional server-owned authoritative last publicly visible price; not client input.
   * Supplying this value requires a trusted baseline; persistence/wiring is separate.
   */
  lastPublicPrice?: string | null;
  price: string;
  /** Internal outbox may omit monetary events outside its safe-integer envelope. */
  omitPriceDrop?: boolean;
}) {
  if (!Number.isSafeInteger(input.version) || input.version <= 0)
    throw new Error('Invalid listing event version');
  const events: { key: string; event: ListingEmailEvent }[] = [];
  if (input.publicBefore !== input.publicAfter)
    events.push({
      key: `listing:${input.listingId}:${input.version}:availability`,
      event: { kind: 'availability', available: input.publicAfter },
    });
  // Never parse prices in a nonpublic after-state. A republish may compare only
  // against the supplied last PUBLIC baseline, never the immediately prior draft.
  const previousPublicPrice = input.publicBefore
    ? input.previousPrice
    : input.lastPublicPrice;
  if (
    input.publicAfter &&
    previousPublicPrice != null &&
    !input.omitPriceDrop
  ) {
    const before = priceMinor(previousPublicPrice);
    const after = priceMinor(input.price);
    if (after < before)
      events.push({
        key: `listing:${input.listingId}:${input.version}:price_drop`,
        event: {
          kind: 'price_drop',
          previousPriceMinor: before,
          priceMinor: after,
        },
      });
  }
  return events;
}
