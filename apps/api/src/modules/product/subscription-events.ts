import type { ListingEmailEvent } from '../professional/email-templates';

function priceMinor(value: string): number {
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
  previousPrice: string;
  price: string;
}) {
  if (!Number.isSafeInteger(input.version) || input.version <= 0)
    throw new Error('Invalid listing event version');
  const events: { key: string; event: ListingEmailEvent }[] = [];
  if (input.publicBefore !== input.publicAfter)
    events.push({
      key: `listing:${input.listingId}:${input.version}:availability`,
      event: { kind: 'availability', available: input.publicAfter },
    });
  // No private/draft price notifications, even if a user previously subscribed.
  if (input.publicBefore && input.publicAfter) {
    const before = priceMinor(input.previousPrice);
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
