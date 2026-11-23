import type { SearchDefinition } from '@raui/types/product';

export const moscowSearch = {
  'kupit-kvartiru': {
    title: 'Купить квартиру в Москве',
    label: 'Купить',
    dealType: 'sale',
  },
  'snyat-kvartiru': {
    title: 'Снять квартиру в Москве',
    label: 'Снять',
    dealType: 'long_rent',
  },
} as const;

export function moscowPath(dealType: string) {
  const match = Object.entries(moscowSearch).find(
    ([, page]) => page.dealType === dealType,
  );
  return match ? '/moskva/' + match[0] : null;
}

export function moscowDefinition(
  dealType: 'sale' | 'long_rent',
): SearchDefinition {
  return { category: 'apartment', regionCode: 'moscow', dealType, limit: 20 };
}
