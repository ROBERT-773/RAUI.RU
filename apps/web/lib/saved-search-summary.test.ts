import { expect, test } from 'vitest';
import { savedSearchSummary } from './saved-search-summary';

test('summarizes localized active filters without altering the saved definition', () => {
  const definition = {
    category: 'apartment',
    dealType: 'sale' as const,
    locality: 'Москва',
    district: 'Центр',
    q: 'метро & парк',
    price: { min: 0, max: 100 },
    pricePerM2: { max: 50 },
    attributes: {
      rooms: { min: 2, max: 3 },
      area: { min: 40 },
      elevator: false,
      custom: 'Особое',
    },
    sellerType: 'owner' as const,
    sourceType: 'direct' as const,
    publishedAfter: '2026-10-07',
    sort: 'price_asc' as const,
    bounds: [1, 2, 3, 4] as [number, number, number, number],
    polygon: [
      [1, 2],
      [2, 3],
      [3, 1],
    ] as [number, number][],
  };
  const before = JSON.stringify(definition);
  expect(savedSearchSummary(definition)).toEqual(
    [
      'Объект: Квартиры',
      'Сделка: Купить',
      'Поиск: метро & парк',
      'Город: Москва',
      'Район: Центр',
      'Цена: от 0 до 100 ₽',
      'Цена за м²: до 50 ₽/м²',
      'Комнаты: от 2 до 3',
      'Площадь, м²: от 40',
      'Лифт: Нет',
      'custom: Особое',
      'Продавец: Собственник',
      'Источник: Напрямую',
      'Опубликовано после: 2026-10-07',
      'Область карты: 1, 2, 3, 4',
      'Выбранная область: 1, 2; 2, 3; 3, 1',
      'Сортировка: Сначала дешевле',
    ].join(' · '),
  );
  expect(JSON.stringify(definition)).toBe(before);
});

test.each([
  [{ min: 0 }, 'от 0'],
  [{ max: 0 }, 'до 0'],
  [{ min: 2, max: 2 }, '2'],
  [{ min: 2, max: 4 }, 'от 2 до 4'],
])('preserves range meaning %j', (range, text) => {
  expect(savedSearchSummary({ attributes: { rooms: range } })).toBe(
    'Комнаты: ' + text,
  );
});

test('empty ranges and navigation metadata do not appear as filters', () => {
  expect(
    savedSearchSummary({
      price: {},
      attributes: { area: {} },
      cursor: 'page',
      limit: 20,
    }),
  ).toBe('Все объекты · Все сделки');
});

test('future category and attribute values remain visible', () => {
  expect(
    savedSearchSummary({
      category: 'future',
      attributes: { future: 'значение' },
    }),
  ).toBe('Объект: future · future: значение');
});

test('saved region scope distinguishes otherwise identical searches without inventing catalogue names', () => {
  expect(savedSearchSummary({ regionCode: 'moscow', q: 'дом' })).toBe(
    'Поиск: дом · Регион: moscow',
  );
  expect(savedSearchSummary({ regionCode: 'future_region', q: 'дом' })).toBe(
    'Поиск: дом · Регион: future_region',
  );
});
