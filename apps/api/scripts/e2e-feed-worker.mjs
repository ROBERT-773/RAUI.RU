import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../dist/modules/database/database.js';
import {
  ProfessionalImports,
  ProfessionalImportsModule,
} from '../dist/modules/professional/imports.js';
import { FeedFetcher } from '../dist/modules/professional/feed-fetch.js';

const db = new URL(process.env.DATABASE_URL ?? '');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.E2E_XML_FEEDS !== 'true' ||
  !['local', undefined].includes(process.env.DEPLOYMENT_ENV) ||
  !['127.0.0.1', 'localhost'].includes(db.hostname) ||
  !/^\/raui_test_[a-f0-9]{16}$/.test(db.pathname) ||
  process.env.FEED_ALLOWED_HOSTS !== 'xml-fixture.example.test'
) {
  throw new Error(
    'XML browser fixture requires an isolated local test database',
  );
}
function flat(id, price) {
  return `<Object><Category>newBuildingFlatSale</Category><ExternalId>${id}</ExternalId>
  <Title>Квартира в новостройке</Title><Description>Тестовая квартира</Description>
  <Address>Москва, Тестовая улица, 1</Address><City>Москва</City>
  <Coordinates><Lat>55.7</Lat><Lng>37.6</Lng></Coordinates>
  <FloorNumber>4</FloorNumber><Building><FloorsCount>9</FloorsCount></Building>
  <FlatRoomsCount>2</FlatRoomsCount><TotalArea>55.3</TotalArea><KitchenArea>10</KitchenArea>
  <BargainTerms><Price>${price}</Price><Currency>rur</Currency></BargainTerms></Object>`;
}
const cian =
  '<Feed><Feed_Version>2</Feed_Version>' +
  flat('e2e-flat-valid', '9500000') +
  flat('e2e-flat-invalid', 'n/a') +
  '</Feed>';
const fixtures = new Map(
  [
    ['cian', cian],
    [
      'avito',
      `<Ads formatVersion="3" target="Avito.ru"><Ad>
      <Id>01</Id><Category>Квартиры</Category><OperationType>Продам</OperationType><MarketType>Новостройка</MarketType>
      <City>Казань</City><Address>Казань, Тестовая улица, 2</Address><Latitude>55.8</Latitude><Longitude>49.1</Longitude>
      <Square>55</Square><Rooms>2</Rooms><Price>9600000</Price></Ad></Ads>`,
    ],
    [
      'yandex',
      `<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06"><offer internal-id="02">
      <type>продажа</type><category>квартира</category><new-flat>да</new-flat>
      <location><locality-name>Омск</locality-name><address>Омск, Тестовая улица, 3</address>
      <latitude>55.0</latitude><longitude>73.4</longitude></location>
      <area><value>55</value><unit>кв. м</unit></area><price><value>9700000</value><currency>RUR</currency></price>
      </offer></realty-feed>`,
    ],
    [
      'domclick',
      `<complexes><complex><id>03</id><name>ЖК Тестовый</name><address>Пермь, Тестовая улица, 4</address>
      <latitude>58.0</latitude><longitude>56.3</longitude><buildings><building><id>1</id><flats><flat>
      <flat_id>3</flat_id><floor>3</floor><room>2</room><area>55</area><price>9800000</price>
      </flat></flats></building></buildings></complex></complexes>`,
    ],
  ].map(([provider, xml]) => [
    `https://xml-fixture.example.test/${provider}.xml`,
    xml,
  ]),
);
const context = await Test.createTestingModule({
  imports: [DatabaseModule, ProfessionalImportsModule],
})
  .overrideProvider(FeedFetcher)
  .useValue({
    async fetch(url) {
      const xml = fixtures.get(url);
      if (!xml) throw new Error('Unknown XML fixture');
      return xml;
    },
  })
  .compile();
await context.init();
const imports = context.get(ProfessionalImports);
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
try {
  while (!stopping) {
    if (!(await imports.once())) await delay(300);
  }
} finally {
  await context.close();
}
