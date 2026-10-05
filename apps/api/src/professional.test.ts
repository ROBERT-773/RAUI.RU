import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ProfessionalImports } from './modules/professional/imports';
import {
  publicIPv4,
  validateFeedUrl,
  resolveFeedHost,
} from './modules/professional/feed-fetch';
import { parseFeed } from './modules/professional/feed-parser';
import {
  validateNotificationGatewayUrl,
  resolveNotificationGatewayHost,
} from './modules/professional/notifications';
import {
  importItem,
  cadence,
  nextDue,
  normalizedFingerprint,
} from './modules/professional/contracts';
test('Missing import items fail validation before authorization or persistence', async () => {
  const imports = new ProfessionalImports(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    imports.apply({} as never, 'invalid', 'invalid', {}, 'test-key'),
    BadRequestException,
  );
});
test('Feed SSRF policy rejects private, reserved, link-local, IPv6 and secret-bearing URLs', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.31.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
  assert.equal(
    validateFeedUrl('https://feeds.example/listings', ['feeds.example'])
      .hostname,
    'feeds.example',
  );
  for (const url of [
    'http://feeds.example',
    'https://feeds.example.attacker.test',
    'https://user:secret@feeds.example',
    'https://feeds.example:8443',
    'https://127.0.0.1',
  ])
    assert.throws(() => validateFeedUrl(url, ['feeds.example']));
});
test('JSON, bounded CSV and entity-free XML decode into normalized mapped feeds', () => {
  const map = {
    externalReference: 'ref',
    title: 'name',
    price: 'price',
    dealType: 'deal',
    categoryCode: 'category',
    'address.formatted': 'address',
    'address.locality': 'locality',
    'address.longitude': 'lon',
    'address.latitude': 'lat',
    'attributes.area': 'area',
  };
  const row = {
    ref: '1',
    name: 'Flat',
    price: '100',
    deal: 'sale',
    category: 'apartment',
    address: 'Test address',
    locality: 'Москва',
    lon: '37.6',
    lat: '55.7',
    area: '50',
  };
  const json = parseFeed(JSON.stringify([row]), 'json', map);
  assert.equal(importItem.safeParse(json[0]).success, true);
  const csv = parseFeed(
    Object.keys(row).join(',') + '\n' + Object.values(row).join(','),
    'csv',
    map,
  );
  assert.deepEqual(csv, json);
  const xml = parseFeed(
    '<feed><item>' +
      Object.entries(row)
        .map(([k, v]) => `<${k}>${v}</${k}>`)
        .join('') +
      '</item></feed>',
    'xml',
    map,
  );
  assert.deepEqual(xml, json);
  assert.throws(() =>
    parseFeed(
      '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed/>',
      'xml',
      {},
    ),
  );
  assert.throws(() => parseFeed('[{}]', 'json', { '__proto__.p': 'x' }));
  assert.throws(() => parseFeed('x'.repeat(2_000_001), 'json', {}));
});
test('Only supported UTC schedules and safe normalized fields are accepted', () => {
  assert.equal(cadence('*/15 * * * *'), 15);
  assert.equal(cadence('0 * * * *'), 60);
  assert.equal(cadence('0 0 * * *'), 1440);
  assert.equal(
    nextDue('*/15 * * * *', new Date('2026-10-05T09:07:16Z')).toISOString(),
    '2026-10-05T09:15:00.000Z',
  );
  assert.equal(
    nextDue('0 0 * * *', new Date('2026-10-05T09:07:16Z')).toISOString(),
    '2026-10-06T00:00:00.000Z',
  );
  assert.throws(() => cadence('* * * * *'));
  assert.throws(() => cadence('*/7 * * * *'));
  assert.equal(
    importItem.safeParse({ price: -1, status: 'published' }).success,
    false,
  );
});

test('Import fingerprints ignore JSON key ordering but preserve changed values', () => {
  assert.equal(
    normalizedFingerprint({ a: 1, attributes: { area: 50, x: true } }),
    normalizedFingerprint({ attributes: { x: true, area: 50 }, a: 1 }),
  );
  assert.notEqual(
    normalizedFingerprint({ a: 1 }),
    normalizedFingerprint({ a: 2 }),
  );
});

test('Feed DNS deadline and mixed private/public DNS answers fail closed', async () => {
  await assert.rejects(
    resolveFeedHost('feeds.example', async () => new Promise(() => {}), 10),
    /Feed DNS deadline/,
  );
  await assert.rejects(
    resolveFeedHost('feeds.example', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /Feed address rejected/,
  );
  const addresses = await resolveFeedHost('feeds.example', async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(addresses[0]!.address, '8.8.8.8');
});

test('Notification gateway rejects unsafe destinations and DNS rebinding answers', async () => {
  assert.equal(
    validateNotificationGatewayUrl('https://notify.example/v1/send').hostname,
    'notify.example',
  );
  for (const url of [
    'http://notify.example/v1/send',
    'https://user:secret@notify.example/v1/send',
    'https://notify.example:8443/v1/send',
    'https://127.0.0.1/v1/send',
    'https://[::1]/v1/send',
  ])
    assert.throws(() => validateNotificationGatewayUrl(url));

  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '203.0.113.1',
    '::1',
  ])
    await assert.rejects(
      resolveNotificationGatewayHost('notify.example', async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]),
      /notification_gateway_address_rejected/,
    );

  await assert.rejects(
    resolveNotificationGatewayHost('notify.example', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /notification_gateway_address_rejected/,
  );
  const selected = await resolveNotificationGatewayHost(
    'notify.example',
    async () => [{ address: '8.8.8.8', family: 4 }],
  );
  assert.equal(selected.address, '8.8.8.8');
});
