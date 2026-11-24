import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import * as config from './config';
import { BadRequestException } from '@nestjs/common';
import { ProfessionalImports } from './modules/professional/imports';
import {
  xmlFeedMaxBytes,
  xmlFeedMaxItems,
} from './modules/professional/feed-limits';
import { FeedGeocoding } from './modules/professional/feed-geocoding';
import { ConfiguredDelivery } from './modules/auth/delivery';
import {
  publicIPv4,
  validateFeedUrl,
  resolveFeedHost,
  HttpsFeedFetcher,
} from './modules/professional/feed-fetch';
import {
  detectFeedProfile,
  parseFeed,
} from './modules/professional/feed-parser';
import {
  GatewayNotificationAdapter,
  validateNotificationGatewayUrl,
  resolveNotificationGatewayHost,
} from './modules/professional/notifications';
import {
  importItem,
  cadence,
  nextDue,
  normalizedFingerprint,
} from './modules/professional/contracts';
import { ProfessionalPlatform } from './modules/professional/platform';
test('professional preference writers share the user mutex', async () => {
  const calls: { query: string; sql: unknown }[] = [];
  const transactionSql = {
    query: async (query: string) => {
      calls.push({ query, sql: transactionSql });
      return { rows: [] };
    },
  };
  const db = {
    transaction: async (run: (sql: typeof transactionSql) => unknown) =>
      run(transactionSql),
    rows: async (query: string, _values: unknown[], sql: unknown) => {
      calls.push({ query, sql });
      return [
        {
          user_id: '00000000-0000-4000-8000-000000000001',
          email: false,
          push: false,
          transactional: true,
        },
      ];
    },
  };
  const platform = new ProfessionalPlatform(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await platform.setPreferences(
    {
      id: '00000000-0000-4000-8000-000000000001',
      role: 'agency',
    } as never,
    { email: false, push: false, transactional: true },
  );
  assert.match(calls[0]!.query, /users.*FOR NO KEY UPDATE/);
  assert.equal(calls[0]!.sql, transactionSql);
  assert.match(calls[1]!.query, /notification_preferences/);
  assert.equal(calls[1]!.sql, transactionSql);
});
test('XML geocoding uses one exact match in the same locality and caches repeated addresses', async () => {
  const row = {
    address: { locality: 'Москва', formatted: 'ул. Примерная, 2' },
  };
  const point = { latitude: 55.4, longitude: 37.1 };
  const candidate = {
    ...row.address,
    ...point,
    formatted: 'Москва, ул. Примерная, 2',
  };
  let calls = 0;
  const geocoding = new FeedGeocoding({
    lookup: async (query) => {
      assert.equal(query, candidate.formatted);
      calls++;
      return [candidate];
    },
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await geocoding.resolve(row), {
      row: { address: { ...row.address, ...point } },
    });
  const supplied = { address: { ...row.address, ...point } };
  assert.deepEqual(await geocoding.resolve(supplied), { row: supplied });
  assert.equal(calls, 1);
  for (const results of [
    [],
    [candidate, candidate],
    [{ ...candidate, locality: 'Омск' }],
  ]) {
    const rejected = await new FeedGeocoding({
      lookup: async () => results,
    }).resolve(row);
    assert.equal(rejected.row, row);
    assert.match(rejected.message!, /однозначно/);
  }
});
test('Missing import items fail validation before authorization or persistence', async () => {
  const imports = new ProfessionalImports(
    {} as never,
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
const cianXml = `<feed><feed_version>2</feed_version><object>
  <Category>newBuildingFlatSale</Category><ExternalId>001</ExternalId>
  <Address>Москва, улица Тестовая, 1</Address><Coordinates><Lat>55.7</Lat><Lng>37.6</Lng></Coordinates>
  <FloorNumber>4</FloorNumber><FlatRoomsCount>2</FlatRoomsCount><TotalArea>55.3</TotalArea>
  <BargainTerms><Price>9500000</Price><Currency>rub</Currency></BargainTerms>
</object></feed>`;
const avitoXml = `<Ads formatVersion="3" target="Avito.ru"><Ad>
  <Id>002</Id><Category>Квартиры</Category><OperationType>Продам</OperationType><MarketType>Новостройка</MarketType>
  <Price>9600000</Price><City>Казань</City><Address>Казань, улица Тестовая, 2</Address>
  <Latitude>55.8</Latitude><Longitude>49.1</Longitude><Square>55.3</Square><Rooms>2</Rooms>
</Ad></Ads>`;
const yandexXml = `<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06"><offer internal-id="003">
  <type>продажа</type><category>квартира</category><new-flat>да</new-flat>
  <location><locality-name>Омск</locality-name><address>Омск, улица Тестовая, 3</address>
  <latitude>55.0</latitude><longitude>73.4</longitude></location>
  <price><value>9700000</value><currency>RUR</currency></price>
  <area><value>55.3</value><unit>кв. м</unit></area><kitchen-space><value>10</value></kitchen-space>
</offer></realty-feed>`;
const domclickBuilding = (id: string) => `<building><id>${id}</id><flats><flat>
  <flat_id>007</flat_id><apartment>12</apartment><domrf_id>42</domrf_id><floor>3</floor><room>2</room>
  <plan>https://example.test/plan.jpg</plan><price>9800000</price><area>55.3</area>
</flat></flats></building>`;
const domclickXml = `<complexes><complex><id>001</id><name>ЖК Берег</name><address>Пермь, Тестовая улица, 1</address>
  <latitude>58.0</latitude><longitude>56.3</longitude><buildings>${domclickBuilding('01')}${domclickBuilding('02')}</buildings>
  <developer><name>Застройщик</name></developer></complex></complexes>`;
test('provider new-build rows preserve identifiers and normalize the source price, address and area', () => {
  for (const [provider, xml, price, locality] of [
    ['cian', cianXml, 9500000, 'Москва'],
    ['avito', avitoXml, 9600000, 'Казань'],
    ['yandex', yandexXml, 9700000, 'Омск'],
    ['domclick', domclickXml, 9800000, 'Пермь'],
  ] as const) {
    assert.equal(detectFeedProfile(xml), provider);
    const items = parseFeed(xml, 'xml', {}, provider).map((row) =>
      importItem.parse(row),
    );
    for (const item of items) {
      assert.equal(item.dealType, 'sale');
      assert.equal(item.categoryCode, 'new_build');
      assert.equal(item.price, price);
      assert.equal(item.address.locality, locality);
      assert.equal(item.attributes.area, 55.3);
    }
    if (provider === 'domclick') {
      assert.equal(items.length, 2);
      assert.notEqual(items[0]!.externalReference, items[1]!.externalReference);
      const rerun = parseFeed(
        xml.replace('9800000', '9900000'),
        'xml',
        {},
        provider,
      );
      assert.equal(
        importItem.parse(rerun[0]).externalReference,
        items[0]!.externalReference,
      );
    } else {
      assert.equal(
        items[0]!.externalReference,
        { cian: '001', avito: '002', yandex: '003' }[provider],
      );
    }
  }
});
test('selected provider must match the XML envelope; words in comments, other namespaces and unknown wrappers cannot select an adapter', () => {
  assert.throws(() => parseFeed(yandexXml, 'xml', {}, 'cian'));
  assert.throws(() =>
    parseFeed(
      '<realty-feed><offer id="1"/></realty-feed>',
      'xml',
      {},
      'domclick',
    ),
  );
  assert.throws(() =>
    parseFeed(
      yandexXml.replace('webmaster.yandex.ru', 'example.com'),
      'xml',
      {},
      'yandex',
    ),
  );
  assert.throws(() =>
    parseFeed(
      '<!-- <Feed><Object> --> <feed><item>ok</item></feed>',
      'xml',
      {},
      'cian',
    ),
  );
  assert.throws(() =>
    parseFeed(
      avitoXml.replace('target="Avito.ru"', 'target="Example"'),
      'xml',
      {},
      'avito',
    ),
  );
});
test('a foreign currency or an invalid number cannot become a rouble price, while good siblings remain available', () => {
  const bad = yandexXml.replace('RUR', 'USD');
  assert.equal(
    importItem.safeParse(parseFeed(bad, 'xml', {})[0]).success,
    false,
  );
  assert.equal(
    importItem.safeParse(
      parseFeed(yandexXml.replace('9700000', '0x112'), 'xml', {})[0],
    ).success,
    false,
  );
  const xml = cianXml.replace(
    '</feed>',
    cianXml
      .slice(cianXml.indexOf('<object>'), cianXml.indexOf('</feed>'))
      .replace('001', '004')
      .replace('9500000', 'n/a') + '</feed>',
  );
  const rows = parseFeed(xml, 'xml', {});
  assert.deepEqual(
    rows.map((row) => importItem.safeParse(row).success),
    [true, false],
  );
});
test('legacy RAUI YRL carries its external ID, local address and monthly price into the report even without coordinates', () => {
  const legacy = `<?xml version="1.0" encoding="UTF-8"?>
    <realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">
      <generation-date>2020-03-04T12:00:00+03:00</generation-date><offer internal-id="test-003">
      <type>аренда</type><property-type>жилая</property-type><category>квартира</category>
      <location><country>Россия</country><region>Тестовая область</region><district>Центральный</district>
      <locality-name>Калуга</locality-name><address>Примерная улица, 2</address></location>
      <price><value>45000</value><currency>RUR</currency><period>месяц</period></price>
      <rooms>2</rooms><area><value>44</value><unit>кв. м</unit></area><floor>1</floor><floors-total>5</floors-total>
      <kitchen-space><value>9</value><unit>кв. м</unit></kitchen-space></offer></realty-feed>`;
  const [row] = parseFeed(legacy, 'xml', {}, 'yandex');
  assert.partialDeepStrictEqual(row, {
    externalReference: 'test-003',
    dealType: 'long_rent',
    categoryCode: 'apartment',
    price: 45000,
    attributes: { area: 44, kitchen_area: 9, rooms: 2, floor: 1, floors: 5 },
    address: { locality: 'Калуга', formatted: 'Примерная улица, 2' },
  });
  const validation = importItem.safeParse(row);
  assert.equal(validation.success, false);
  assert.deepEqual(
    validation.error?.issues.map((issue) => issue.path.join('.')).sort(),
    ['address.latitude', 'address.longitude'],
  );
});
test('XML has separate size and item limits while JSON and CSV retain their existing bounds', () => {
  const envelope = (count: number) =>
    '<feed>' + '<item>example</item>'.repeat(count) + '</feed>';
  assert.equal(
    parseFeed(envelope(xmlFeedMaxItems), 'xml', {}).length,
    xmlFeedMaxItems,
  );
  assert.throws(
    () => parseFeed(envelope(xmlFeedMaxItems + 1), 'xml', {}),
    BadRequestException,
  );
  const prefix = '<feed><item>',
    suffix = '</item></feed>';
  const maxSize =
    prefix +
    'a'.repeat(xmlFeedMaxBytes - prefix.length - suffix.length) +
    suffix;
  assert.equal(parseFeed(maxSize, 'xml', {}).length, 1);
  assert.throws(() => parseFeed(maxSize + ' ', 'xml', {}), BadRequestException);
  for (const format of ['json', 'csv']) {
    const tooMany =
      format === 'json'
        ? JSON.stringify(Array(1001).fill({}))
        : 'id\n' + '0\n'.repeat(1001);
    assert.throws(() => parseFeed(tooMany, format, {}), BadRequestException);
    assert.throws(
      () => parseFeed('x'.repeat(2_000_001), format, {}),
      BadRequestException,
    );
  }
});
test('Cian mixed-case object tags retain feed order and price per square metre is scaled to the full apartment', () => {
  const lowerCase = cianXml.slice(
    cianXml.indexOf('<object>'),
    cianXml.indexOf('</feed>'),
  );
  const mixed = lowerCase
    .replace('<object>', '<Object>')
    .replace('</object>', '</Object>')
    .replace('001', '007');
  const [first, second, third] = parseFeed(
    cianXml.replace('</feed>', mixed + lowerCase + '</feed>'),
    'xml',
    {},
  ).map((row) => importItem.parse(row));
  assert.deepEqual(
    [
      first?.externalReference,
      second?.externalReference,
      third?.externalReference,
    ],
    ['001', '007', '001'],
  );
  const perMeter = cianXml.replace(
    '<Price>9500000</Price>',
    '<Price>200000</Price><PriceType>squareMeter</PriceType>',
  );
  assert.equal(
    importItem.parse(parseFeed(perMeter, 'xml', {})[0]).price,
    11060000,
  );
});
test('Cian studio layout is not nine rooms and building prices with unsupported units require correction', () => {
  const studio = cianXml.replace(
    '<FlatRoomsCount>2</FlatRoomsCount>',
    '<FlatRoomsCount>9</FlatRoomsCount>',
  );
  const [item] = parseFeed(studio, 'xml', {}).map((row) =>
    importItem.parse(row),
  );
  assert.match(item!.title, /Студия/);
  assert.equal(item!.attributes.rooms, 0);
  assert.equal(
    importItem.safeParse(
      parseFeed(
        yandexXml.replace('<currency>RUR</currency>', ''),
        'xml',
        {},
      )[0],
    ).success,
    false,
  );
  assert.equal(
    importItem.safeParse(
      parseFeed(
        cianXml.replace(
          '<Price>9500000</Price>',
          '<Price>100</Price><PriceType>sotka</PriceType>',
        ),
        'xml',
        {},
      )[0],
    ).success,
    false,
  );
  const rows = domclickXml.replaceAll(
    '<apartment>12</apartment>',
    '<apartment>24</apartment>',
  );
  assert.deepEqual(
    parseFeed(rows, 'xml', {}),
    parseFeed(domclickXml, 'xml', {}),
  );
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

test('Feed transport pins validated IPv4 with Node24-compatible TLS and rejects redirects', async (t) => {
  const previous = process.env.FEED_ALLOWED_HOSTS;
  process.env.FEED_ALLOWED_HOSTS = 'feeds.example';
  t.after(() => {
    if (previous === undefined) delete process.env.FEED_ALLOWED_HOSTS;
    else process.env.FEED_ALLOWED_HOSTS = previous;
  });
  let dnsCalls = 0,
    requests = 0,
    statusCode = 200;
  t.mock.method(dns, 'lookup', async () => {
    dnsCalls++;
    return [{ address: dnsCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  let captured: https.RequestOptions | undefined;
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    requests++;
    captured = options;
    assert.equal(url.hostname, 'feeds.example');
    const req = new EventEmitter();
    return Object.assign(req, {
      destroy() {},
      end() {
        // Node24 autoSelectFamily requests all:true unless the adapter pins IPv4.
        options.lookup!(
          'feeds.example',
          { all: options.family !== 4 },
          (_error, address) => {
            if (options.family !== 4 && !Array.isArray(address)) {
              req.emit(
                'error',
                new Error('Node24 lookup expected address objects'),
              );
              return;
            }
            assert.equal(address, '8.8.8.8');
            const res = Object.assign(new EventEmitter(), {
              statusCode,
              headers: { 'content-type': 'application/json' },
            });
            callback(res);
            if (statusCode === 200) {
              res.emit('data', Buffer.from('[]'));
              res.emit('end');
            }
          },
        );
      },
    });
  }) as never);
  const fetcher = new HttpsFeedFetcher();
  assert.equal(await fetcher.fetch('https://feeds.example/listings'), '[]');
  assert.equal(captured?.family, 4);
  assert.equal(captured?.servername, 'feeds.example');
  assert.equal(captured?.rejectUnauthorized, true);
  assert.equal(captured?.agent, false);
  assert.equal(dnsCalls, 1);
  await assert.rejects(
    fetcher.fetch('https://feeds.example/listings'),
    /Feed address rejected/,
  );
  assert.equal(requests, 1);
  dnsCalls = 0;
  statusCode = 302;
  await assert.rejects(
    fetcher.fetch('https://feeds.example/listings'),
    /Feed response rejected/,
  );
  assert.equal(requests, 2);
});

test('Verification challenge delivery refuses redirects and sanitizes transport failures', async (t) => {
  t.mock.method(config, 'loadConfig', () =>
    config.envSchema.parse({
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      VERIFICATION_GATEWAY_URL: 'https://verify.example/send',
      VERIFICATION_GATEWAY_TOKEN: 'test-only-provider-token',
    }),
  );
  const message = {
    destination: 'fixture@example.test',
    purpose: 'reset' as const,
    token: 'synthetic-private-challenge',
  };
  let forwarded = 0,
    status = 307;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/send') {
      response.writeHead(status, { Location: '/unapproved-destination' });
      response.end();
    } else {
      forwarded++;
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const port = (server.address() as { port: number }).port;
  const nativeFetch = globalThis.fetch;
  // Only the configured HTTPS transport destination is mapped to a controlled
  // loopback fixture; native fetch still executes the actual redirect policy.
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.equal(url, 'https://verify.example/send');
    return nativeFetch(`http://127.0.0.1:${port}/send`, init);
  });
  const delivery = new ConfiguredDelivery();
  for (status of [307, 308]) {
    await assert.rejects(
      delivery.send(message),
      /Verification delivery unavailable/,
    );
    assert.equal(forwarded, 0);
  }
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
    assert.throws(
      () => validateNotificationGatewayUrl(url),
      /notification_gateway_rejected/,
      url,
    );

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

test('Notification transport pins validated DNS, preserves TLS hostname and rejects redirects', async (t) => {
  t.mock.method(config, 'loadConfig', () =>
    config.envSchema.parse({
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      NOTIFICATION_GATEWAY_URL: 'https://notify.example/v1/send',
      NOTIFICATION_GATEWAY_TOKEN: 'test-only-gateway-token',
    }),
  );
  let resolutions = 0;
  t.mock.method(dns, 'lookup', async () => {
    resolutions++;
    return [
      { address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
    ];
  });
  let statusCode = 204;
  let requests = 0;
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: { statusCode: number; destroy(): void }) => void,
  ) => {
    requests++;
    assert.equal(url.hostname, 'notify.example');
    assert.equal(options.servername, 'notify.example');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.family, 4);
    assert.equal(options.signal, signal);
    assert.equal(
      (options.headers as Record<string, string>)['Idempotency-Key'],
      input.idempotencyKey,
    );
    assert.equal(typeof options.lookup, 'function');
    // A second DNS query would rebind to loopback; the transport must use the validated snapshot.
    options.lookup!('notify.example', {}, (_error, address, family) => {
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    return Object.assign(request, {
      end: (body: string) => {
        assert.deepEqual(JSON.parse(body), input);
        callback({ statusCode, destroy() {} });
      },
    });
  }) as never);
  const signal = new AbortController().signal;
  const input = {
    channel: 'email' as const,
    userId: 'test-user',
    kind: 'message',
    payload: {},
    idempotencyKey: 'notification:test',
    destination: 'test@example.com',
  };
  const adapter = new GatewayNotificationAdapter();
  await adapter.send(input, signal);
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);
  // A new delivery must revalidate DNS and reject the changed answer before opening a socket.
  await assert.rejects(
    adapter.send(input, signal),
    /notification_gateway_address_rejected/,
  );
  assert.equal(requests, 1);
  resolutions = 0;
  statusCode = 302;
  await assert.rejects(adapter.send(input, signal), /delivery_failed/);
  assert.equal(requests, 2);
});
