import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { BadRequestException } from '@nestjs/common';
import { parse } from '../../common/security';
import { importInput } from './contracts';
import { xmlFeedMaxBytes, xmlFeedMaxItems } from './feed-limits';
import { FeedLinkError } from './feed-link-error';

export type FeedProfile = 'yandex' | 'cian' | 'avito' | 'domclick' | 'generic';
type XmlRecord = Record<string, unknown>;
type Provider = Exclude<FeedProfile, 'generic'>;
function record(value: unknown): XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlRecord)
    : {};
}
// Cian explicitly accepts either case for tag names. Preserve raw fields for manual mappings.
function field(row: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    const object = record(row);
    const key = Object.hasOwn(object, part)
      ? part
      : Object.keys(object).find((k) => k.toLowerCase() === part.toLowerCase());
    if (!key) return undefined;
    row = object[key];
  }
  return row;
}
function str(row: unknown, path: string) {
  const value = field(row, path);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function number(row: unknown, path: string) {
  const value = str(row, path);
  if (!value || !/^-?\d+(?:[.,]\d+)?$/.test(value)) return undefined;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}
function repeated(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}
const xmlListingPaths = new Set([
  'realty-feed.offer',
  'Ads.Ad',
  'feed.item',
  'complexes.complex.buildings.building.flats.flat',
]);
function parseXml(text: string) {
  if (
    Buffer.byteLength(text) > xmlFeedMaxBytes ||
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    XMLValidator.validate(text) !== true
  )
    throw new BadRequestException('Некорректный XML или превышен лимит файла.');
  let count = 0;
  const body = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    maxNestedTags: 20,
    parseTagValue: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    isArray: (name) => name === 'item',
    updateTag(name, path) {
      if (typeof path !== 'string') return name;
      const cianRow = /^feed\.object$/i.test(path);
      if ((xmlListingPaths.has(path) || cianRow) && ++count > xmlFeedMaxItems)
        throw new BadRequestException('Превышен лимит объявлений XML.');
      return cianRow || /^feed\.feed_version$/i.test(path)
        ? name.toLowerCase()
        : name;
    },
  }).parse(text) as XmlRecord;
  const names = Object.keys(body);
  if (names.length !== 1)
    throw new BadRequestException('В XML нужен один корневой элемент.');
  const name = names[0]!;
  if (Array.isArray(body[name]))
    throw new BadRequestException('В XML нужен один корневой элемент.');
  const root = record(body[name]);
  let profile: FeedProfile;
  if (
    name === 'realty-feed' &&
    root['@_xmlns'] === 'http://webmaster.yandex.ru/schemas/feed/realty/2010-06'
  )
    profile = 'yandex';
  else if (
    name === 'feed' &&
    Object.hasOwn(root, 'item') &&
    field(root, 'feed_version') === undefined
  )
    profile = 'generic';
  else if (root['@_xmlns'])
    throw new BadRequestException('Неизвестная схема XML.');
  else if (name.toLowerCase() === 'feed' && str(root, 'feed_version') === '2')
    profile = 'cian';
  else if (
    name === 'Ads' &&
    root['@_formatVersion'] === '3' &&
    root['@_target'] === 'Avito.ru'
  )
    profile = 'avito';
  else if (name === 'complexes' && Object.hasOwn(root, 'complex'))
    profile = 'domclick';
  else throw new BadRequestException('Формат XML не поддерживается.');
  return { root, profile };
}
function assertProfile(detected: FeedProfile, hint?: Provider) {
  if (hint && hint !== detected)
    throw new FeedLinkError(
      `feed_provider_mismatch_${detected}`,
      'Формат файла отличается от выбранной площадки.',
    );
  return detected;
}
export function detectFeedProfile(text: string, hint?: Provider): FeedProfile {
  return assertProfile(parseXml(text).profile, hint);
}
function numericAttributes(row: unknown, paths: Record<string, string>) {
  const attributes: Record<string, number> = {};
  for (const [key, path] of Object.entries(paths)) {
    const value = number(row, path);
    if (value !== undefined) attributes[key] = value;
  }
  return attributes;
}
function rubles(
  row: unknown,
  price: string,
  currency: string,
  defaultCurrency?: string,
) {
  const code =
    field(row, currency) === undefined ? defaultCurrency : str(row, currency);
  return code && /^(RUB|RUR)$/i.test(code) ? number(row, price) : undefined;
}
function priceForArea(rate: number | undefined, area: number | undefined) {
  if (rate === undefined || area === undefined || area <= 0) return undefined;
  return Math.round(rate * area * 100) / 100;
}
function localityFromAddress(address?: string) {
  const parts =
    address
      ?.split(',')
      .map((p) => p.trim())
      .filter(Boolean) ?? [];
  const marked = parts
    .map(
      (p) =>
        p.match(
          /^(?:г\.?\s+|город\s+|пос[её]лок\s+|деревня\s+|село\s+)(.+)$/iu,
        )?.[1],
    )
    .find(Boolean);
  if (marked) return marked;
  if (parts.length < 2) return undefined;
  // Only a city-leading address can supply locality. Skip administrative and street components.
  const candidate = parts.find(
    (p) => !/(?:россия|республика|область|край|регион|район|округ)/iu.test(p),
  );
  if (
    candidate &&
    /^[\p{L}][\p{L}\s-]*$/u.test(candidate) &&
    !/(?:улица|проспект|переулок|шоссе|набережная|бульвар|площадь|микрорайон|жилой комплекс)/iu.test(
      candidate,
    )
  )
    return candidate;
  return undefined;
}
function address(
  row: unknown,
  formatted: string,
  latitude: string,
  longitude: string,
  locality?: string,
) {
  const line = str(row, formatted);
  return {
    formatted: line,
    locality:
      (locality ? str(row, locality) : undefined) ?? localityFromAddress(line),
    latitude: number(row, latitude),
    longitude: number(row, longitude),
  };
}
function listingTitle(
  row: unknown,
  area: number | undefined,
  category?: string,
  layout?: string,
) {
  const label =
    layout ??
    (category === 'house'
      ? 'Дом'
      : category === 'room'
        ? 'Комната'
        : 'Квартира');
  return (
    str(row, 'Title') ??
    (area !== undefined ? label + ' · ' + area + ' м²' : label)
  );
}
function dealType(sale: boolean, longRent: boolean, shortRent: boolean) {
  if (sale) return 'sale';
  if (longRent) return 'long_rent';
  if (shortRent) return 'short_rent';
  return undefined;
}
function yandexAddress(row: unknown) {
  const location = address(
    row,
    'location.address',
    'location.latitude',
    'location.longitude',
    'location.locality-name',
  );
  const region = str(row, 'location.region');
  const district = str(row, 'location.district');
  if (
    !location.formatted ||
    (!region && !district) ||
    location.latitude !== undefined ||
    location.longitude !== undefined
  )
    return location;

  // YRL frequently supplies just the street here, with region and district in sibling tags.
  const parts = location.formatted.split(',').map((part) => part.trim());
  const normalize = (value: string) =>
    value.toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim();
  const qualifiers = new Map<string, string>();
  for (const qualifier of [region, district, location.locality]) {
    if (qualifier) qualifiers.set(normalize(qualifier), qualifier);
  }
  const supplied = new Set(parts.map(normalize));
  if ([...qualifiers.keys()].every((key) => supplied.has(key))) return location;
  const rest = parts.filter((part) => !qualifiers.has(normalize(part)));
  return {
    ...location,
    formatted: [...qualifiers.values(), ...rest].join(', '),
  };
}
const yandexCategories = new Map(
  Object.entries({
    дом: 'house',
    house: 'house',
    комната: 'room',
    room: 'room',
  }),
);
function normalizedYandex(row: unknown) {
  const category = str(row, 'category')?.toLowerCase(),
    operation = str(row, 'type')?.toLowerCase();
  const fresh = ['1', 'да', 'true', '+'].includes(
    str(row, 'new-flat')?.toLowerCase() ?? '',
  );
  const categoryCode = ['квартира', 'flat', 'apartment'].includes(
    category ?? '',
  )
    ? fresh
      ? 'new_build'
      : 'apartment'
    : yandexCategories.get(category ?? '');
  const attrs = numericAttributes(row, {
    area: 'area.value',
    kitchen_area: 'kitchen-space.value',
    living_area: 'living-space.value',
    rooms: 'rooms',
    floor: 'floor',
    floors: 'floors-total',
  });
  const period = str(row, 'price.period')?.toLowerCase();
  const sale = ['продажа', 'sale', 'sell'].includes(operation ?? '');
  const rent = ['аренда', 'rent', 'lease'].includes(operation ?? '');
  const daily = ['день', 'сутки', 'day'].includes(period ?? '');
  const monthly = !period || ['месяц', 'month'].includes(period);
  const unit = str(row, 'price.unit')?.replace(/\s/g, '').toLowerCase();
  const areaUnit = str(row, 'area.unit')?.replace(/\s/g, '').toLowerCase();
  const sqm = (unit?: string) =>
    !unit ||
    ['кв.м', 'кв.м.', 'sqm', 'sq.m', 'sq.m.', 'м²', 'm²'].includes(unit);
  const base = rubles(row, 'price.value', 'price.currency');
  const price =
    !sqm(areaUnit) || !sqm(unit)
      ? undefined
      : unit
        ? priceForArea(base, attrs.area)
        : base;
  return {
    externalReference: str(row, '@_internal-id'),
    categoryCode,
    dealType: dealType(sale && !period, rent && monthly, rent && daily),
    price,
    title: listingTitle(row, attrs.area, categoryCode),
    description: str(row, 'description') ?? '',
    attributes: attrs,
    address: yandexAddress(row),
  };
}
function normalizedAvito(row: unknown) {
  const category = str(row, 'Category'),
    operation = str(row, 'OperationType');
  const code =
    category === 'Квартиры'
      ? str(row, 'MarketType') === 'Новостройка'
        ? 'new_build'
        : 'apartment'
      : category === 'Комнаты'
        ? 'room'
        : undefined;
  const attrs = numericAttributes(row, {
    area: 'Square',
    kitchen_area: 'KitchenSpace',
    living_area: 'LivingSpace',
    floor: 'Floor',
    floors: 'Floors',
    rooms: 'Rooms',
  });
  const lease = str(row, 'LeaseType');
  const studio = str(row, 'Rooms')?.toLowerCase() === 'студия';
  if (studio) attrs.rooms = 0;
  return {
    externalReference: str(row, 'Id'),
    categoryCode: code,
    dealType: dealType(
      operation === 'Продам',
      operation === 'Сдам' && lease === 'На длительный срок',
      operation === 'Сдам' && lease === 'Посуточно',
    ),
    title: listingTitle(row, attrs.area, code, studio ? 'Студия' : undefined),
    price: number(row, 'Price'),
    description: str(row, 'Description') ?? '',
    attributes: attrs,
    address: address(row, 'Address', 'Latitude', 'Longitude', 'City'),
  };
}
const cianCategories = new Map(
  Object.entries({
    newbuildingflatsale: 'new_build',
    flatsale: 'apartment',
    flatrent: 'apartment',
    roomsale: 'room',
    roomrent: 'room',
  }),
);
const cianLayouts = new Map([
  [6, 'Многокомнатная квартира'],
  [7, 'Квартира свободной планировки'],
  [9, 'Студия'],
]);
function normalizedCian(row: unknown) {
  const category = str(row, 'Category')?.toLowerCase();
  const code = cianCategories.get(category ?? '');
  const attrs = numericAttributes(row, {
    area: 'TotalArea',
    kitchen_area: 'KitchenArea',
    living_area: 'LivingArea',
    floor: 'FloorNumber',
    floors: 'Building.FloorsCount',
  });
  // Cian uses codes 6, 7 and 9 for layouts rather than exact room counts.
  const rooms = number(row, 'FlatRoomsCount');
  if (
    rooms !== undefined &&
    Number.isInteger(rooms) &&
    rooms >= 1 &&
    rooms <= 5
  )
    attrs.rooms = rooms;
  if (rooms === 9) attrs.rooms = 0;
  const period = str(row, 'BargainTerms.PaymentPeriod')?.toLowerCase();
  const priceType = str(row, 'BargainTerms.PriceType')?.toLowerCase();
  const base = rubles(
    row,
    'BargainTerms.Price',
    'BargainTerms.Currency',
    'rur',
  );
  const price =
    !priceType || priceType === 'all'
      ? base
      : priceType === 'squaremeter'
        ? priceForArea(base, attrs.area)
        : undefined;
  return {
    externalReference: str(row, 'ExternalId'),
    categoryCode: code,
    dealType:
      code &&
      dealType(
        category?.endsWith('sale') === true,
        !period || period === 'monthly',
        period === 'daily',
      ),
    title: listingTitle(
      row,
      attrs.area,
      code,
      rooms !== undefined ? cianLayouts.get(rooms) : undefined,
    ),
    price,
    description: str(row, 'Description') ?? '',
    attributes: attrs,
    address: address(row, 'Address', 'Coordinates.Lat', 'Coordinates.Lng'),
  };
}
function domclickRows(root: XmlRecord, mapped: boolean) {
  const rows: unknown[] = [];
  for (const complex of repeated(root.complex))
    for (const building of repeated(field(complex, 'buildings.building'))) {
      const complexId = str(complex, 'id'),
        buildingId = str(building, 'id'),
        subId = str(building, 'sub_building_id');
      const formatted = str(building, 'address') ?? str(complex, 'address');
      const coordinates =
        field(building, 'latitude') !== undefined ||
        field(building, 'longitude') !== undefined
          ? building
          : complex;
      const location = {
        formatted,
        locality: localityFromAddress(formatted),
        latitude: number(coordinates, 'latitude'),
        longitude: number(coordinates, 'longitude'),
      };
      for (const flat of repeated(field(building, 'flats.flat'))) {
        if (mapped) {
          rows.push(flat);
          continue;
        }
        const flatId = str(flat, 'flat_id'),
          attrs = numericAttributes(flat, {
            area: 'area',
            kitchen_area: 'kitchen_area',
            living_area: 'living_area',
            floor: 'floor',
            rooms: 'room',
          });
        const floors = number(building, 'floors');
        if (floors !== undefined) attrs.floors = floors;
        rows.push({
          externalReference:
            complexId && buildingId && flatId
              ? JSON.stringify([complexId, buildingId, subId ?? null, flatId])
              : undefined,
          categoryCode: 'new_build',
          dealType: 'sale',
          title: listingTitle(
            flat,
            attrs.area,
            'new_build',
            attrs.rooms === 0 ? 'Студия' : undefined,
          ),
          description: str(flat, 'description') ?? '',
          price: number(flat, 'price'),
          attributes: attrs,
          address: location,
        });
      }
    }
  return rows;
}
function readXmlRows(
  text: string,
  mapping: Record<string, string>,
  hint?: Provider,
) {
  const { root, profile } = parseXml(text);
  assertProfile(profile, hint);
  const mapped = Object.keys(mapping).length > 0;
  const tag = {
    cian: 'Object',
    avito: 'Ad',
    yandex: 'offer',
    generic: 'item',
    domclick: 'complex',
  }[profile];
  const rows =
    profile === 'domclick'
      ? domclickRows(root, mapped)
      : repeated(field(root, tag));
  if (!rows.length || rows.length > xmlFeedMaxItems)
    throw new BadRequestException('Проверьте количество объявлений в XML.');
  if (profile === 'domclick' || profile === 'generic' || mapped) return rows;
  return rows.map(
    { avito: normalizedAvito, cian: normalizedCian, yandex: normalizedYandex }[
      profile
    ],
  );
}
export function parseFeed(
  text: string,
  format: string,
  mapping: Record<string, string>,
  profileHint?: Provider,
): unknown[] {
  const limit = format === 'xml' ? xmlFeedMaxBytes : 2_000_000;
  if (Buffer.byteLength(text) > limit)
    throw new BadRequestException('Превышен размер фида.');
  let items: unknown[];
  try {
    if (format === 'xml') items = readXmlRows(text, mapping, profileHint);
    else {
      let rows: unknown;
      if (format === 'json') rows = JSON.parse(text);
      else if (format === 'csv')
        rows = parseCsv(text, {
          columns: true,
          skip_empty_lines: true,
          max_record_size: 20000,
        }) as unknown[];
      else throw new Error('Unsupported format');
      items = parse(importInput, { items: rows }).items;
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Feed decoding failed');
  }
  // Mapping is output dotted field -> input dotted field. No prototype-sensitive paths.
  const forbidden = ['__proto__', 'constructor', 'prototype'];
  for (const [target, source] of Object.entries(mapping))
    if (
      [...target.split('.'), ...source.split('.')].some(
        (x) => forbidden.includes(x) || !x,
      )
    )
      throw new BadRequestException('Unsafe mapping');
  if (!Object.keys(mapping).length) return items;
  return items.map((raw) => {
    const out: Record<string, unknown> = {};
    for (const [target, source] of Object.entries(mapping)) {
      let value: unknown = raw;
      for (const part of source.split('.'))
        value =
          typeof value === 'object' && value !== null
            ? Object.hasOwn(value, part)
              ? (value as Record<string, unknown>)[part]
              : undefined
            : undefined;
      if (value === undefined) continue;
      if (
        [
          'price',
          'address.longitude',
          'address.latitude',
          'attributes.area',
        ].includes(target) &&
        typeof value === 'string'
      )
        value = Number(value);
      const parts = target.split('.');
      let obj = out;
      for (const part of parts.slice(0, -1)) {
        obj[part] ??= {};
        if (typeof obj[part] !== 'object' || obj[part] === null)
          throw new BadRequestException('Conflicting mapping');
        obj = obj[part] as Record<string, unknown>;
      }
      obj[parts.at(-1)!] = value;
    }
    return out;
  });
}
