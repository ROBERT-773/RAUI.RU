import { cookies } from 'next/headers';
import type { SearchDefinition } from '@raui/types/product';
import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { Card } from '../components/card';
import { HomeGeography } from '../components/home-geography';
import BetaInvitation from '../components/beta-invitation';
import {
  publicProfessionals,
  publicRegionCounts,
  publicRegions,
  recentListings,
} from '../lib/server';

export const metadata: Metadata = {
  title: 'Недвижимость — RAUI.RU',
  description: 'Поиск квартир и другой недвижимости по городу, метро и карте.',
};

const regionCookie = 'raui_region';

async function saveHomeRegion(form: FormData) {
  'use server';
  const code = form.get('region');
  const regions = await publicRegions();
  if (
    !regions.some((region) => region.code === code) ||
    typeof code !== 'string'
  )
    return;
  const preferences = await cookies();
  preferences.set(regionCookie, code, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.DEPLOYMENT_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ feedback?: string | string[] }>;
}) {
  const [listings, regions, regionCounts] = await Promise.all([
    recentListings(),
    publicRegions(),
    publicRegionCounts(),
  ]);
  const preferences = await cookies();
  const preferred = preferences.get(regionCookie)?.value;
  const current = regions.find((region) => region.code === preferred);
  const regionCode = current?.code ?? 'moscow';
  const professionals = await publicProfessionals(regionCode);
  function regionalSearch(filters: SearchDefinition) {
    return {
      pathname: '/search',
      query: { definition: JSON.stringify({ ...filters, regionCode }) },
    };
  }
  return (
    <main id="content" className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-content">
          <h1 id="home-title">Найдите свою недвижимость</h1>
          {regions.length > 0 && (
            <details className="home-region-picker" key={regionCode}>
              <summary
                aria-label={'Регион поиска: ' + (current?.name ?? 'Москва')}
              >
                {current?.name ?? 'Москва'}
              </summary>
              <form action={saveHomeRegion}>
                <label htmlFor="home-region">Регион поиска</label>
                <select
                  key={regionCode}
                  id="home-region"
                  name="region"
                  defaultValue={regionCode}
                >
                  {regions.map(({ code, name }) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
                <button type="submit">Применить</button>
              </form>
            </details>
          )}
          <div className="home-search-panel">
            <form
              id="home-location-search"
              action="/search"
              method="get"
              className="home-search"
              aria-label="Поиск недвижимости"
            >
              <input type="hidden" name="region" value={regionCode} />
              <span className="home-search-icon" aria-hidden="true" />
              <input
                name="q"
                type="search"
                aria-label="Район, метро или адрес"
                placeholder="Район, метро или адрес"
                maxLength={200}
              />
              <button
                type="submit"
                className="primary home-search-submit"
                aria-label="Найти"
                title="Найти"
              >
                Найти
              </button>
            </form>
            <nav
              className="home-shortcuts"
              aria-label="Быстрый поиск недвижимости"
            >
              <Link
                href={regionalSearch({
                  category: 'apartment',
                  dealType: 'sale',
                })}
              >
                Купить квартиру
              </Link>
              <Link
                href={regionalSearch({
                  category: 'apartment',
                  dealType: 'long_rent',
                })}
              >
                Снять надолго
              </Link>
              <Link href={regionalSearch({ dealType: 'short_rent' })}>
                Снять посуточно
              </Link>
              <Link href={regionalSearch({})}>Все фильтры</Link>
              <button
                className="home-map-action"
                form="home-location-search"
                type="submit"
                name="mode"
                value="map"
              >
                <span className="home-map-pin" aria-hidden="true" />
                На карте
              </button>
            </nav>
          </div>
        </div>
        {regionCode === 'moscow' && (
          <div className="home-hero-image">
            <Image
              src="/raui-moscow-evening.webp"
              alt=""
              fill
              preload
              sizes="100vw"
            />
          </div>
        )}
      </section>
      <BetaInvitation
        initialDismissed={preferences.get('raui_beta_closed')?.value === '1'}
        initialOpen={(await searchParams).feedback === '1'}
      />
      {listings && listings.items.length > 0 && (
        <section
          className="home-preview"
          aria-labelledby="home-preview-heading"
        >
          <div className="home-preview-heading">
            <h2 id="home-preview-heading">Свежие объявления</h2>
            <Link href="/search">Все объявления</Link>
          </div>
          <div className="cards">
            {listings.items.map((listing) => (
              <Card
                key={listing.id}
                listing={listing}
                summary={listing.summary}
              />
            ))}
          </div>
        </section>
      )}
      <section
        className="home-preview"
        aria-labelledby="home-professionals-heading"
      >
        <div className="home-preview-heading">
          <h2 id="home-professionals-heading">Агенты и агентства</h2>
          <Link
            href={{ pathname: '/professionals', query: { region: regionCode } }}
          >
            Каталог специалистов
          </Link>
        </div>
        <div className="home-professional-links">
          {(
            [
              ['agent', 'Агенты', 'Объявления агентов'],
              ['agency', 'Агентства', 'Объявления агентств'],
            ] as const
          ).map(([kind, label, link]) => {
            const profiles = professionals?.items.filter(
              (profile) => profile.kind === kind,
            );
            return (
              <section className="home-professional-group" key={kind}>
                <h3>{label}</h3>
                {!profiles ? (
                  <p>Профили временно недоступны.</p>
                ) : profiles.length ? (
                  <ul>
                    {profiles.map((profile) => (
                      <li key={profile.id}>
                        <Link
                          href={{
                            pathname: '/professionals/' + profile.id,
                            query: { region: regionCode },
                          }}
                        >
                          {profile.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>В этом регионе пока нет опубликованных профилей.</p>
                )}
                <Link href={regionalSearch({ sellerType: kind })}>{link}</Link>
              </section>
            );
          })}
        </div>
      </section>
      <HomeGeography regions={regions} counts={regionCounts} />
    </main>
  );
}
