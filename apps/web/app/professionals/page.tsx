import { cookies } from 'next/headers';
import Link from 'next/link';
import { publicProfessionals, publicRegions } from '../../lib/server';

export const metadata = { title: 'Агенты и агентства — RAUI.RU' };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    region?: string;
    kind?: string;
    page?: string;
    q?: string;
  }>;
}) {
  const [query, regions, preferences] = await Promise.all([
    searchParams,
    publicRegions(),
    cookies(),
  ]);
  const preferred = preferences.get('raui_region')?.value;
  const region = [query.region, preferred, 'moscow'].find((code) =>
    regions.some((item) => item.code === code),
  );
  const kind = query.kind === 'agency' ? 'agency' : 'agent';
  const page =
    typeof query.page === 'string' && /^[1-9][0-9]{0,8}$/.test(query.page)
      ? Number(query.page)
      : 1;
  const name = typeof query.q === 'string' ? query.q.trim().slice(0, 120) : '';
  const results = region
    ? await publicProfessionals(region, kind, page, name)
    : null;
  function directoryHref(targetKind: 'agent' | 'agency', targetPage = 1) {
    return {
      pathname: '/professionals',
      query: {
        kind: targetKind,
        region,
        ...(name ? { q: name } : {}),
        ...(targetPage > 1 ? { page: targetPage } : {}),
      },
    };
  }

  return (
    <main id="content">
      <h1>Агенты и агентства</h1>
      <form action="/professionals" method="get" className="toolbar">
        <input name="kind" type="hidden" value={kind} />
        <label>
          Регион
          <select
            key={region}
            name="region"
            defaultValue={region}
            disabled={!region}
          >
            {regions.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Имя или название
          <input
            key={name}
            name="q"
            type="search"
            defaultValue={name}
            maxLength={120}
            placeholder={kind === 'agent' ? 'Имя агента' : 'Название агентства'}
          />
        </label>
        <button type="submit" disabled={!region}>
          Показать
        </button>
      </form>
      <nav className="toolbar" aria-label="Тип специалиста">
        <Link
          href={directoryHref('agent')}
          aria-current={kind === 'agent' ? 'page' : undefined}
        >
          Агенты
          {results && ` (${results.counts.agent.toLocaleString('ru-RU')})`}
        </Link>
        <Link
          href={directoryHref('agency')}
          aria-current={kind === 'agency' ? 'page' : undefined}
        >
          Агентства
          {results && ` (${results.counts.agency.toLocaleString('ru-RU')})`}
        </Link>
      </nav>
      {!results ? (
        <p>Каталог специалистов временно недоступен.</p>
      ) : results.items.length === 0 ? (
        <p>
          {page > 1
            ? 'На этой странице нет профилей.'
            : name
              ? 'По этому запросу ничего не найдено.'
              : 'В этом регионе пока нет опубликованных профилей.'}
        </p>
      ) : (
        <ul>
          {results.items.map((profile) => (
            <li key={profile.id}>
              <Link
                href={{
                  pathname: '/professionals/' + profile.id,
                  query: { region },
                }}
              >
                {profile.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || results?.hasMore) && (
        <nav className="toolbar" aria-label="Страницы специалистов">
          {page > 1 && (
            <Link
              href={directoryHref(kind, results?.items.length ? page - 1 : 1)}
            >
              {results?.items.length ? 'Предыдущая' : 'На первую страницу'}
            </Link>
          )}
          {results?.hasMore && (
            <Link href={directoryHref(kind, page + 1)}>Следующая</Link>
          )}
        </nav>
      )}
    </main>
  );
}
