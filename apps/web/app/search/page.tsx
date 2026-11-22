import type { Metadata } from 'next';
import SearchProduct from '../../components/search';
export const metadata: Metadata = {
  title: 'Поиск недвижимости — RAUI.RU',
  robots: { index: false, follow: true },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    definition?: string;
    mode?: string;
    q?: string;
    deal?: string;
    city?: string;
    region?: string;
    budget?: string;
  }>;
}) {
  const { definition, mode, q, deal, city, region, budget } =
    await searchParams;
  let initial: import('@raui/types/product').SearchDefinition = { limit: 20 };
  if (deal === 'sale' || deal === 'long_rent' || deal === 'short_rent')
    initial.dealType = deal;
  if (typeof region === 'string' && /^[a-z][a-z0-9_]{0,49}$/.test(region))
    initial.regionCode = region;
  if (city === 'moscow') initial.locality = 'Москва';
  if (typeof q === 'string' && q.trim()) initial.q = q.trim().slice(0, 200);
  else if (deal) initial.locality = 'Москва';
  if (typeof budget === 'string' && /^[1-9][0-9]{0,13}$/.test(budget))
    initial.price = { max: Number(budget) };
  try {
    if (definition && definition.length <= 16000) {
      const value = JSON.parse(definition);
      if (value && typeof value === 'object' && !Array.isArray(value))
        initial = value;
    }
  } catch {
    /* API validates all filters. */
  }
  return (
    <main id="content">
      <SearchProduct
        initialDefinition={initial}
        initialMode={mode === 'map' ? 'map' : 'list'}
      />
    </main>
  );
}
