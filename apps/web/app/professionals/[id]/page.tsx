import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '../../../components/card';
import { publicProfessional, publicRegions } from '../../../lib/server';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ region?: string; page?: string }>;
}) {
  const [{ id }, { region, page }, regions] = await Promise.all([
    params,
    searchParams,
    publicRegions(),
  ]);
  const selected = regions.find(({ code }) => code === region);
  const pageNumber =
    typeof page === 'string' && /^[1-9][0-9]{0,8}$/.test(page)
      ? Number(page)
      : 1;
  const profile = await publicProfessional(id, selected?.code, pageNumber);
  if (!profile) notFound();
  function pageHref(number: number) {
    const query = new URLSearchParams();
    if (selected) query.set('region', selected.code);
    if (number > 1) query.set('page', String(number));
    return '/professionals/' + id + (query.size ? '?' + query : '');
  }
  if (pageNumber > Math.max(1, profile.listingPageCount))
    redirect(pageHref(Math.max(1, profile.listingPageCount)));
  const workRegions = regions.filter(({ code }) =>
    profile.regionCodes.includes(code),
  );

  return (
    <main id="content">
      <Link
        href={{
          pathname: '/professionals',
          query: {
            kind: profile.kind,
            ...(selected ? { region: selected.code } : {}),
          },
        }}
      >
        Агенты и агентства
      </Link>
      <h1>{profile.name}</h1>
      <p>
        {profile.kind === 'agent'
          ? 'Агент по недвижимости'
          : 'Агентство недвижимости'}
      </p>
      <h2>Регионы работы</h2>
      <ul>
        {workRegions.map(({ code, name }) => (
          <li key={code}>{name}</li>
        ))}
      </ul>
      <section aria-labelledby="professional-listings">
        <h2 id="professional-listings">Опубликованные объявления</h2>
        {workRegions.length > 0 && (
          <nav className="toolbar" aria-label="Фильтр объявлений по региону">
            <Link
              href={'/professionals/' + id}
              aria-current={!selected ? 'page' : undefined}
            >
              Все регионы ({profile.listingCount.toLocaleString('ru-RU')})
            </Link>
            {workRegions.map(({ code, name }) => (
              <Link
                key={code}
                href={{
                  pathname: '/professionals/' + id,
                  query: { region: code },
                }}
                aria-current={selected?.code === code ? 'page' : undefined}
              >
                {name} (
                {(profile.listingCountsByRegion[code] ?? 0).toLocaleString(
                  'ru-RU',
                )}
                )
              </Link>
            ))}
          </nav>
        )}
        {profile.listings.length > 0 ? (
          <div className="cards">
            {profile.listings.map((listing) => (
              <Card key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <p>
            {selected
              ? 'В этом регионе пока нет опубликованных объявлений.'
              : 'У этого профиля пока нет опубликованных объявлений.'}
          </p>
        )}
        {profile.listingPageCount > 1 && (
          <nav className="toolbar" aria-label="Страницы объявлений">
            {pageNumber > 1 && (
              <Link href={pageHref(pageNumber - 1)}>Предыдущая</Link>
            )}
            <span>
              Страница {pageNumber} из {profile.listingPageCount}
            </span>
            {pageNumber < profile.listingPageCount && (
              <Link href={pageHref(pageNumber + 1)}>Следующая</Link>
            )}
          </nav>
        )}
      </section>
    </main>
  );
}
