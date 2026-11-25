import type { SearchDefinition } from '@raui/types/product';
import { attributeLabels, attributeValue, pricePeriod } from './labels';

const categories: Record<string, string> = {
  apartment: 'Квартиры',
  room: 'Комнаты',
  aparthotel: 'Апартаменты',
  new_build: 'Новостройки',
  secondary: 'Вторичное жильё',
  house: 'Дома',
  townhouse: 'Таунхаусы',
  land: 'Участки',
  commercial: 'Коммерческие',
  parking: 'Паркинг',
};
const deals: Record<string, string> = {
  sale: 'Купить',
  long_rent: 'Снять надолго',
  short_rent: 'Посуточно',
};
const sellers: Record<string, string> = {
  owner: 'Собственник',
  agent: 'Агент',
  agency: 'Агентство',
  developer: 'Застройщик',
  admin: 'Администратор',
};
const sources: Record<string, string> = {
  direct: 'Напрямую',
  agency: 'Агентство',
  developer: 'Застройщик',
  feed: 'Фид',
  api: 'API',
};
const sorts: Record<string, string> = {
  newest: 'Сначала новые',
  price_asc: 'Сначала дешевле',
  price_desc: 'Сначала дороже',
  area_desc: 'Сначала больше площадь',
};
const number = (value: number) => value.toLocaleString('ru-RU');
function range(value: { min?: number; max?: number }, format = number): string {
  const { min, max } = value;
  if (min !== undefined && max !== undefined)
    return min === max ? format(min) : `от ${format(min)} до ${format(max)}`;
  if (min !== undefined) return `от ${format(min)}`;
  if (max !== undefined) return `до ${format(max)}`;
  return '';
}

function calendarDate(value: number | undefined) {
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value));
  if (!parts) return;
  const iso = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const time = Date.parse(iso + 'T00:00:00Z');
  if (Number.isFinite(time) && new Date(time).toISOString().startsWith(iso))
    return { time, label: `${parts[3]}.${parts[2]}.${parts[1]}` };
}

/** Display-only: the stored definition remains the source of reopen and mutation data. */
export function savedSearchSummary(definition: SearchDefinition): string {
  const parts: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) parts.push(`${label}: ${value}`);
  };
  add(
    'Объект',
    definition.category &&
      (categories[definition.category] ?? definition.category),
  );
  add(
    'Сделка',
    definition.dealType && (deals[definition.dealType] ?? definition.dealType),
  );
  add('Поиск', definition.q);
  add('Регион', definition.regionCode);
  add('Город', definition.locality);
  add('Район', definition.district);
  for (const [label, value, unit] of [
    ['Цена', definition.price, '₽' + pricePeriod(definition.dealType ?? '')],
    ['Цена за м²', definition.pricePerM2, '₽/м²'],
  ] as const) {
    const text = value && range(value);
    if (text) add(label, `${text} ${unit}`);
  }
  const attributes = { ...definition.attributes };
  if (definition.dealType === 'short_rent') {
    const from = attributes.rental_available_from;
    const until = attributes.rental_available_until;
    const arrival =
      typeof from === 'object' && from.min === undefined
        ? calendarDate(from.max)
        : undefined;
    const departure =
      typeof until === 'object' && until.max === undefined
        ? calendarDate(until.min)
        : undefined;
    if (arrival && departure && departure.time > arrival.time) {
      add('Заезд', arrival.label);
      add('Выезд', departure.label);
      delete attributes.rental_available_from;
      delete attributes.rental_available_until;
      const nights = attributes.rental_minimum_nights;
      if (
        typeof nights === 'object' &&
        nights.min === undefined &&
        nights.max === (departure.time - arrival.time) / 86400000
      )
        delete attributes.rental_minimum_nights;
    }
    const guests = attributes.guest_capacity;
    if (
      typeof guests === 'object' &&
      guests.min !== undefined &&
      guests.max === undefined
    ) {
      add('Число гостей', number(guests.min));
      delete attributes.guest_capacity;
    }
  }
  for (const [key, value] of Object.entries(attributes)) {
    const date =
      key === 'rental_available_from' || key === 'rental_available_until';
    const format = date
      ? (n: number) => calendarDate(n)?.label ?? String(n)
      : number;
    add(
      attributeLabels[key] ?? key,
      typeof value === 'object' ? range(value, format) : attributeValue(value),
    );
  }
  add('Продавец', definition.sellerType && sellers[definition.sellerType]);
  add('Источник', definition.sourceType && sources[definition.sourceType]);
  add('Опубликовано после', definition.publishedAfter);
  add('Область карты', definition.bounds?.join(', '));
  add(
    'Выбранная область',
    definition.polygon?.map((point) => point.join(', ')).join('; '),
  );
  add('Сортировка', definition.sort && sorts[definition.sort]);
  return parts.join(' · ') || 'Все объекты · Все сделки';
}
