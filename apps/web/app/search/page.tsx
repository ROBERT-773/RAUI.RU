import type { Metadata } from 'next';
import SearchProduct from '../../components/search';
export const metadata: Metadata = {
  title: 'Поиск недвижимости — RAUI.RU',
  robots: { index: false, follow: true },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ definition?: string }>;
}) {
  const { definition } = await searchParams;
  let initial: import('@raui/types/product').SearchDefinition = { limit: 20 };
  try {
    if (definition && definition.length <= 4000) {
      const value = JSON.parse(definition);
      if (value && typeof value === 'object' && !Array.isArray(value))
        initial = value;
    }
  } catch {
    /* API validates all filters. */
  }
  return (
    <main id="content">
      <SearchProduct initialDefinition={initial} />
    </main>
  );
}
