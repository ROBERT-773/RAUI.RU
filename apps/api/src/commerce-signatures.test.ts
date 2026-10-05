import { paymentDeadline } from './modules/commerce/timeout';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaymentSignature } from './modules/commerce/signatures';
test('payment signature binds original bytes and timestamp with a bounded replay window', () => {
  const secret = 'test-only-secret-with-at-least-32-characters',
    timestamp = '1800000000',
    now = Number(timestamp) * 1000,
    payload = Buffer.from('{ "amountMinor": 9900 }');
  const signature =
    timestamp +
    '.' +
    createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(payload)
      .digest('hex');
  assert.equal(verifyPaymentSignature(signature, payload, secret, now), true);
  assert.equal(
    verifyPaymentSignature(
      signature,
      Buffer.from('{"amountMinor":9900}'),
      secret,
      now,
    ),
    false,
  );
  assert.equal(
    verifyPaymentSignature(signature, payload, secret, now + 301000),
    false,
  );
  assert.equal(
    verifyPaymentSignature(signature, payload, secret, now - 301000),
    false,
  );
  for (const value of ['', 'invalid', timestamp + '.' + '0'.repeat(64)])
    assert.equal(verifyPaymentSignature(value, payload, secret, now), false);
  assert.equal(verifyPaymentSignature(signature, payload, 'short', now), false);
});

test('provider deadline cancels slow work and propagates normal provider failures', async () => {
  let aborted = false;
  await assert.rejects(
    paymentDeadline(
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      10,
    ),
    /timed out/,
  );
  assert.equal(aborted, true);
  assert.equal(await paymentDeadline(async () => 42), 42);
  await assert.rejects(
    paymentDeadline(async () => {
      throw new Error('Provider failed');
    }),
    /Provider failed/,
  );
});
