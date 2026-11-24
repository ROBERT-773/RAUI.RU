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
const fixture =
  '<Feed><Feed_Version>2</Feed_Version>' +
  flat('e2e-flat-valid', '9500000') +
  flat('e2e-flat-invalid', 'n/a') +
  '</Feed>';
const context = await Test.createTestingModule({
  imports: [DatabaseModule, ProfessionalImportsModule],
})
  .overrideProvider(FeedFetcher)
  .useValue({
    async fetch(url) {
      if (url !== 'https://xml-fixture.example.test/cian.xml')
        throw new Error('Unknown XML fixture');
      return fixture;
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
