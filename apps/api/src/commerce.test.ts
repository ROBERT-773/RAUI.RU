import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertPaymentTransition,
  assertPromotionActivationTransition,
  attachPaidPlacementSignals,
  normalizeIdempotencyKey,
  normalizePaymentEventKey,
  promotionWindow,
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

test('payment event keys reject malformed replay identifiers', () => {
  assert.equal(
    normalizePaymentEventKey('provider:event-123'),
    'provider:event-123',
  );
  for (const value of ['', 'short', 'contains spaces', undefined])
    assert.throws(() => normalizePaymentEventKey(value), BadRequestException);
});

test('promotion windows are deterministic from an explicit start time', () => {
  const window = promotionWindow('2026-10-05T10:00:00.000Z', 24);
  assert.equal(window.startsAt, '2026-10-05T10:00:00.000Z');
  assert.equal(window.endsAt, '2026-10-06T10:00:00.000Z');
  assert.throws(() => promotionWindow('not-a-date', 24), BadRequestException);
  assert.throws(
    () => promotionWindow('2026-10-05T10:00:00.000Z', 0),
    BadRequestException,
  );
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
    () => validatePromotionProduct({ ...product, priceMinor: -1 }),
    BadRequestException,
  );
  assert.throws(
    () => validatePromotionProduct({ ...product, version: 0 }),
    BadRequestException,
  );
});

test('promotion activation lifecycle blocks invalid terminal transitions', () => {
  assertPromotionActivationTransition('scheduled', 'active');
  assertPromotionActivationTransition('active', 'expired');
  assertPromotionActivationTransition('active', 'cancelled');
  assert.throws(
    () => assertPromotionActivationTransition('expired', 'active'),
    ConflictException,
  );
  assert.throws(
    () => assertPromotionActivationTransition('cancelled', 'active'),
    ConflictException,
  );
});

test('paid placement metadata never reorders organic search results', () => {
  const organic = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const result = attachPaidPlacementSignals(organic, [
    {
      listingId: 'c',
      code: 'vip_24h',
      kind: 'vip',
      priority: 999,
      endsAt: '2026-10-06T10:00:00.000Z',
    },
  ]);
  assert.deepEqual(
    result.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(result[2]!.paidPlacement?.priority, 999);
  assert.equal(result[0]!.paidPlacement, null);
});

test('highest paid signal wins independently of input order and currency amounts stay exact', () => {
  const high = {
      listingId: 'a',
      code: 'vip',
      kind: 'vip' as const,
      priority: 100,
      endsAt: '2026-10-06T10:00:00.000Z',
    },
    low = { ...high, code: 'highlighted', priority: 10 };
  for (const signals of [
    [high, low],
    [low, high],
  ])
    assert.equal(
      attachPaidPlacementSignals([{ id: 'a' }], signals)[0]!.paidPlacement!
        .priority,
      100,
    );
  assert.throws(
    () =>
      validatePromotionProduct({
        code: 'vip_24h',
        kind: 'vip',
        priceMinor: Number.MAX_SAFE_INTEGER + 1,
        currency: 'RUB',
        durationHours: 24,
        priority: 1,
        enabled: true,
        version: 1,
      }),
    BadRequestException,
  );
  assert.throws(
    () => promotionWindow(undefined, Number.MAX_SAFE_INTEGER),
    BadRequestException,
  );
});
