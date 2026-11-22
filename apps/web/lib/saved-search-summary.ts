import type { SearchDefinition } from '@raui/types/product';
import { attributeLabels, attributeValue } from './labels';

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
function range(value: { min?: number; max?: number }): string {
  const { min, max } = value;
  if (min !== undefined && max !== undefined)
    return min === max ? number(min) : `от ${number(min)} до ${number(max)}`;
  if (min !== undefined) return `от ${number(min)}`;
  if (max !== undefined) return `до ${number(max)}`;
  return '';
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
    ['Цена', definition.price, '₽'],
    ['Цена за м²', definition.pricePerM2, '₽/м²'],
  ] as const) {
    const text = value && range(value);
    if (text) add(label, `${text} ${unit}`);
  }
  for (const [key, value] of Object.entries(definition.attributes ?? {}))
    add(
      attributeLabels[key] ?? key,
      typeof value === 'object' ? range(value) : attributeValue(value),
    );
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
