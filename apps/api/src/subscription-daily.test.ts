import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailySubscriptionSettings,
  dailyReleaseSlot,
} from './modules/product/subscription-daily';

test('daily operational settings default to Moscow 09:00 and 48h without enabling email', () => {
  assert.deepEqual(dailySubscriptionSettings({}), {
    timeZone: 'Europe/Moscow',
    hour: 9,
    ttlHours: 48,
  });
  assert.throws(() =>
    dailySubscriptionSettings({ LISTING_DAILY_RELEASE_HOUR: '24' }),
  );
  assert.throws(() =>
    dailySubscriptionSettings({ LISTING_DAILY_TIMEZONE: 'Invalid/Zone' }),
  );
  assert.throws(() =>
    dailySubscriptionSettings({ LISTING_DAILY_TTL_HOURS: '0' }),
  );
});
test('daily slot changes at configured local release hour, never process future events', () => {
  const settings = dailySubscriptionSettings({});
  assert.equal(
    dailyReleaseSlot(new Date('2026-10-14T05:59:59Z'), settings),
    '2026-10-13',
  );
  assert.equal(
    dailyReleaseSlot(new Date('2026-10-14T06:00:00Z'), settings),
    '2026-10-14',
  );
  assert.equal(
    dailyReleaseSlot(new Date('2026-01-01T05:59:59Z'), settings),
    '2025-12-31',
  );
  assert.equal(
    dailyReleaseSlot(new Date('2026-10-14T23:59:00Z'), {
      ...settings,
      timeZone: 'UTC',
      hour: 23,
    }),
    '2026-10-14',
  );
});
