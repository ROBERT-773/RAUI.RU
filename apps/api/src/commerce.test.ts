import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertPaymentTransition,
  normalizeIdempotencyKey,
  validatePromotionProduct,
} from './modules/commerce/commerce';

test('payment state machine allows forward settlement and blocks invalid terminal transitions', () => {
  assertPaymentTransition('created', 'pending');
  assertPaymentTransition('pending', 'authorized');
  assertPaymentTransition('authorized', 'captured');
  assertPaymentTransition('captured', 'refunded');
  assert.throws(
    () => assertPaymentTransition('captured', 'pending'),
    ConflictException,
  );
  assert.throws(
    () => assertPaymentTransition('refunded', 'captured'),
    ConflictException,
  );
});

test('idempotency keys are bounded and restricted to transport-safe characters', () => {
  assert.equal(normalizeIdempotencyKey('order:12345678'), 'order:12345678');
  for (const value of ['', 'short', 'contains spaces', 'x'.repeat(129), null])
    assert.throws(() => normalizeIdempotencyKey(value), BadRequestException);
});

test('promotion products require versioned, bounded commercial configuration', () => {
  const product = validatePromotionProduct({
    code: 'vip_24h',
    kind: 'vip',
    priceMinor: 9900,
    currency: 'RUB',
    durationHours: 24,
    priority: 50,
    enabled: true,
    version: 1,
  });
  assert.equal(product.kind, 'vip');
  assert.equal(product.priceMinor, 9900);
  assert.throws(
    () =>
      validatePromotionProduct({
        ...product,
        priceMinor: -1,
      }),
    BadRequestException,
  );
  assert.throws(
    () =>
      validatePromotionProduct({
        ...product,
        version: 0,
      }),
    BadRequestException,
  );
});
