import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderListingEmail } from './modules/professional/email-templates';

const base = {
  siteOrigin: 'https://staging.raui.ru',
  listingId: '12345678-1234-1234-1234-123456789abc',
  title: '<script>alert("x")</script>',
};
test('subscription emails escape HTML and provide both text and trusted links', () => {
  const email = renderListingEmail({ ...base, event: { kind: 'subscribed' } });
  assert.ok(email.html.includes('&lt;script&gt;'));
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.text.includes(base.title));
  assert.ok(email.html.includes('https://staging.raui.ru/account'));
  assert.ok(!email.subject.includes(base.title));
});
test('price emails require an actual decrease and exact positive minor units', () => {
  const email = renderListingEmail({
    ...base,
    event: { kind: 'price_drop', previousPriceMinor: 20000, priceMinor: 15000 },
  });
  assert.match(email.text, /200/);
  assert.match(email.text, /150/);
  for (const priceMinor of [
    20000,
    25000,
    -1,
    0,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() =>
      renderListingEmail({
        ...base,
        event: { kind: 'price_drop', previousPriceMinor: 20000, priceMinor },
      }),
    );
});
test('unavailable listing emails do not link to inaccessible listing pages', () => {
  const email = renderListingEmail({
    ...base,
    event: { kind: 'availability', available: false },
  });
  assert.ok(!email.html.includes('/listings/'));
  assert.match(email.text, /сейчас недоступно/);
});
test('email renderer rejects injected titles, identifiers and unsafe origins', () => {
  for (const siteOrigin of [
    'http://staging.raui.ru',
    'https://user:pass@staging.raui.ru',
    'https://staging.raui.ru/?x=1',
  ])
    assert.throws(() =>
      renderListingEmail({
        ...base,
        siteOrigin,
        event: { kind: 'subscribed' },
      }),
    );
  assert.throws(() =>
    renderListingEmail({
      ...base,
      title: 'Title\r\nBcc: attacker',
      event: { kind: 'subscribed' },
    }),
  );
  assert.throws(() =>
    renderListingEmail({
      ...base,
      listingId: '../account',
      event: { kind: 'subscribed' },
    }),
  );
});
test('large safe price-drop values preserve exact cents in both email formats', () => {
  const email = renderListingEmail({
    ...base,
    event: {
      kind: 'price_drop',
      previousPriceMinor: 9007199254740991,
      priceMinor: 9007199254740987,
    },
  });
  assert.ok(email.text.replace(/\s/g, ' ').includes('90 071 992 547 409,87 ₽'));
  assert.ok(email.html.replace(/\s/g, ' ').includes('90 071 992 547 409,87 ₽'));
});
