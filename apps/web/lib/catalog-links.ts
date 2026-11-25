import type { SearchDefinition } from '@raui/types/product';

export function catalogHref(definition: SearchDefinition) {
  return (
    '/search?' + new URLSearchParams({ definition: JSON.stringify(definition) })
  );
}

export const catalogNavigation = [
  { label: 'Аренда', href: catalogHref({ dealType: 'long_rent' }) },
  { label: 'Посуточно', href: catalogHref({ dealType: 'short_rent' }) },
  { label: 'Продажа', href: catalogHref({ dealType: 'sale' }) },
  { label: 'Новостройки', href: catalogHref({ category: 'new_build' }) },
  { label: 'Дома', href: catalogHref({ category: 'house' }) },
  { label: 'Участки', href: catalogHref({ category: 'land' }) },
  { label: 'Коммерческая', href: catalogHref({ category: 'commercial' }) },
  {
    label: 'Ипотека',
    href: catalogHref({ dealType: 'sale', attributes: { mortgage: true } }),
  },
  { label: 'Сделки', href: '/services#deals' },
  { label: 'Сервисы', href: '/services' },
  { label: 'Мобильная версия', href: '/services#mobile' },
];
