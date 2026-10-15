import { enrichOpenApi } from './common/openapi';
import type { OpenAPIObject } from '@nestjs/swagger';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listingSubscriptionSchema,
  listingSubscriptionDeliverySchema,
  listingSubscriptionDisableSchema,
} from './modules/product/subscription-contract';

const preference = {
  events: ['price_drop'],
  channels: ['email'],
  frequency: 'daily',
  consent: true,
};
test('listing subscription requires explicit consent, events, channel and frequency', () => {
  assert.equal(listingSubscriptionSchema.safeParse(preference).success, true);
  for (const field of Object.keys(preference)) {
    const input: Record<string, unknown> = { ...preference };
    delete input[field];
    assert.equal(listingSubscriptionSchema.safeParse(input).success, false);
  }
  for (const override of [
    { consent: false },
    { events: [] },
    { channels: [] },
    { events: ['price_drop', 'price_drop'] },
    { channels: ['email', 'email'] },
    { channels: ['sms'] },
    { events: ['marketing'] },
    { userId: 'another-account' },
    { frequency: 'weekly' },
  ])
    assert.equal(
      listingSubscriptionSchema.safeParse({ ...preference, ...override })
        .success,
      false,
    );
});
test('subscription disable requires positive version and rejects ownership overrides', () => {
  assert.equal(
    listingSubscriptionDisableSchema.safeParse({ version: 1 }).success,
    true,
  );
  for (const input of [
    {},
    { version: 0 },
    { version: 1.5 },
    { version: 1, userId: 'other' },
  ])
    assert.equal(
      listingSubscriptionDisableSchema.safeParse(input).success,
      false,
    );
});

test('OpenAPI exposes explicit subscription consent and version-protected disable', () => {
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/v1/account/listing-subscriptions/{id}': { post: { responses: {} } },
      '/v1/account/listing-subscriptions/{id}/disable': {
        post: { responses: {} },
      },
    },
  };
  enrichOpenApi(document);
  const subscribe =
    document.paths['/v1/account/listing-subscriptions/{id}']!.post!;
  const disable =
    document.paths['/v1/account/listing-subscriptions/{id}/disable']!.post!;
  const body = JSON.stringify(subscribe.requestBody);
  assert.match(body, /consent/);
  assert.match(body, /price_drop/);
  assert.match(body, /frequency/);
  assert.ok(subscribe.security?.length);
  assert.ok(disable.responses['409']);
  assert.match(JSON.stringify(disable.requestBody), /version/);
  assert.match(
    JSON.stringify(disable.responses['201']),
    /no new transport attempts for the previous subscription/,
  );
  assert.match(
    JSON.stringify(disable.responses['201']),
    /already accepted by the provider cannot be recalled/,
  );
});

test('internal delivery envelope requires strict current-state provenance and safe exact event values', () => {
  const base = {
    listingId: '12345678-1234-4234-8234-123456789abc',
    listingVersion: 8,
    subscriptionVersion: 1,
    event: {
      kind: 'price_drop',
      previousPriceMinor: Number.MAX_SAFE_INTEGER,
      priceMinor: Number.MAX_SAFE_INTEGER - 1,
    },
  };
  assert.equal(listingSubscriptionDeliverySchema.safeParse(base).success, true);
  for (const listingVersion of [
    undefined,
    null,
    0,
    -1,
    1.5,
    '8',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(
      listingSubscriptionDeliverySchema.safeParse({ ...base, listingVersion })
        .success,
      false,
    );
  for (const event of [
    { ...base.event, priceMinor: 0 },
    { ...base.event, priceMinor: 1.001 },
    { ...base.event, priceMinor: '1e2' },
    { ...base.event, previousPriceMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...base.event, priceMinor: Number.MAX_SAFE_INTEGER },
    { ...base.event, privateReason: 'hidden' },
    { kind: 'availability', available: 'false' },
    { kind: 'availability', available: false, title: 'hidden' },
  ])
    assert.equal(
      listingSubscriptionDeliverySchema.safeParse({ ...base, event }).success,
      false,
    );
  assert.equal(
    listingSubscriptionDeliverySchema.safeParse({ ...base, title: 'hidden' })
      .success,
    false,
  );
  assert.equal(
    listingSubscriptionDeliverySchema.safeParse({
      ...base,
      event: { kind: 'availability', available: false },
    }).success,
    true,
  );
});
