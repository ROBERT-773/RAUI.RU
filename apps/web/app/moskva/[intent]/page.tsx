import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import SearchProduct from '../../../components/search';
import { moscowDefinition, moscowSearch } from '../../../lib/moscow-search';
import { searchCatalog, site } from '../../../lib/server';

type Props = { params: Promise<{ intent: string }> };

function findPage(intent: string) {
  if (!Object.hasOwn(moscowSearch, intent)) notFound();
  return moscowSearch[intent as keyof typeof moscowSearch];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { intent } = await params;
  const { title } = findPage(intent);
  return {
    title: title + ' — RAUI.RU',
    description: title + ': объявления с фильтрами по цене, площади и метро.',
    alternates: { canonical: site + '/moskva/' + intent },
  };
}

export default async function Page({ params }: Props) {
  const { intent } = await params;
  const { title, dealType } = findPage(intent);
  const definition = moscowDefinition(dealType);
  const mapQuery = new URLSearchParams({
    mode: 'map',
    definition: JSON.stringify(definition),
  });
  const initialPage = await searchCatalog(definition);
  return (
    <main id="content">
      <nav
        className="catalog-navigation"
        aria-label="Разделы недвижимости в Москве"
      >
        {Object.entries(moscowSearch).map(([slug, entry]) => (
          <Link
            key={slug}
            href={'/moskva/' + slug}
            aria-current={slug === intent ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        ))}
        <Link href={'/search?' + mapQuery}>На карте</Link>
      </nav>
      <SearchProduct
        title={title}
        initialDefinition={definition}
        initialPage={initialPage}
      />
    </main>
  );
}
