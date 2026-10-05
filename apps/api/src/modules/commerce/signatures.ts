import { createHmac, timingSafeEqual } from 'node:crypto';
/** Reusable gateway signature contract: '<unix-seconds>.<sha256-hex>'.
 * A provider adapter may supply its own protocol through verifyWebhook.
 * Replay IDs are persisted separately in commerce_payment_events. */
export function verifyPaymentSignature(
  signature: string,
  payload: Buffer,
  secret: string,
  now = Date.now(),
) {
  const match = signature.match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (
    secret.length < 32 ||
    !match ||
    Math.abs(now / 1000 - Number(match[1])) > 300
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(match[1] + '.')
    .update(payload)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'));
}
