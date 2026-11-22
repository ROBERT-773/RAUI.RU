import Link from 'next/link';
import type { SearchDefinition } from '@raui/types/product';
import geography from '../lib/archived-geography.json';
import districts from '../lib/moscow-districts.json';

function Collection({
  title,
  items,
}: {
  title: string;
  items: {
    name: string;
    filters: SearchDefinition;
    count?: number | undefined;
  }[];
}) {
  const renderLinks = (entries: typeof items) => (
    <ul className="home-geography-links">
      {entries.map(({ name, filters, count }) => (
        <li key={name}>
          <Link
            href={{
              pathname: '/search',
              query: { definition: JSON.stringify({ limit: 20, ...filters }) },
            }}
          >
            {name}
            {count !== undefined && ` (${count.toLocaleString('ru-RU')})`}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <section>
      <h3>{title}</h3>
      {renderLinks(items.slice(0, 8))}
      {items.length > 8 && (
        <details>
          <summary aria-label={`Показать остальные варианты — ${title}`}>
            Показать остальные
          </summary>
          {renderLinks(items.slice(8))}
        </details>
      )}
    </section>
  );
}

export function HomeGeography({
  regions,
  counts,
}: {
  regions: { code: string; name: string }[];
  counts: Record<string, number>;
}) {
  const sortedRegions = [...regions].sort((a, b) =>
    a.name.localeCompare(b.name, 'ru'),
  );
  return (
    <nav className="home-geography" aria-labelledby="home-geography-title">
      <h2 id="home-geography-title">Недвижимость по городам и регионам</h2>
      <Collection
        title="Квартиры у метро Москвы"
        items={geography.moscow.map((name) => ({
          name,
          filters: {
            regionCode: 'moscow',
            category: 'apartment',
            attributes: { metro: name },
          },
        }))}
      />
      <Collection
        title="Квартиры у метро Санкт-Петербурга"
        items={geography.petersburg.map((name) => ({
          name,
          filters: {
            regionCode: 'saint_petersburg',
            category: 'apartment',
            attributes: { metro: name },
          },
        }))}
      />
      <Collection
        title="Квартиры в районах Москвы"
        items={districts.map((name) => ({
          name,
          filters: {
            regionCode: 'moscow',
            category: 'apartment',
            district: name,
          },
        }))}
      />
      <Collection
        title="Недвижимость в Подмосковье"
        items={geography.cities.map((name) => ({
          name,
          filters: { regionCode: 'moscow_oblast', locality: name },
        }))}
      />
      {sortedRegions.length > 0 && (
        <Collection
          title="Объявления по всей России"
          items={sortedRegions.map(({ name, code: regionCode }) => ({
            name,
            filters: { regionCode },
            count: counts[regionCode],
          }))}
        />
      )}
    </nav>
  );
}
