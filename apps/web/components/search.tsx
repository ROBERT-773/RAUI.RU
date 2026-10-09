'use client';
import { Button } from '@raui/ui';
import { useEffect, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SearchDefinition, SearchPage } from '@raui/types/product';
import { api, track } from '../lib/client';
import AdvancedFilters, { advancedDefinition } from './advanced-filters';
import { Card } from './card';
const MapPanel = dynamic(() => import('./map'), {
  loading: () => <p role="status">Загрузка карты…</p>,
  ssr: false,
});
export default function SearchProduct({
  initialDefinition = { limit: 20 },
  initialMode = 'list',
}: {
  initialDefinition?: SearchDefinition;
  initialMode?: 'list' | 'map';
}) {
  // Next preserves client components during same-route navigation. Reset drafts
  // and result state when the URL-provided definition or mode changes.
  return (
    <SearchView
      key={JSON.stringify([initialDefinition, initialMode])}
      definition={initialDefinition}
      mode={initialMode}
    />
  );
}
function SearchView({
  definition,
  mode,
}: {
  definition: SearchDefinition;
  mode: 'list' | 'map';
}) {
  const router = useRouter();
  const [navigationPending, startNavigation] = useTransition();
  const [requestRevision, setRequestRevision] = useState(0);
  const [page, setPage] = useState<SearchPage | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState<string[] | null>(null),
    [notice, setNotice] = useState(''),
    [filterCategory, setFilterCategory] = useState(
      definition.category ?? 'apartment',
    );
  const [regions, setRegions] = useState<{ code: string; name: string }[]>([]);
  const [regionError, setRegionError] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ items: { code: string; name: string }[] }>('v1/regions')
      .then((result) => {
        if (active) setRegions(result.items);
      })
      .catch(() => {
        if (active) setRegionError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    api<SearchPage>('v1/search', 'POST', definition)
      .then((r) => {
        if (active) {
          setPage(r);
          setError('');
          track({ type: 'search_performed', resultCount: r.total });
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [definition, requestRevision]);
  function update(d: SearchDefinition, nextMode = mode) {
    const next = { ...d, cursor: undefined };
    const query = new URLSearchParams({
      definition: JSON.stringify(next),
      mode: nextMode,
    });
    const target = '/search?' + query.toString();
    if (window.location.pathname + window.location.search !== target)
      startNavigation(() => router.replace(target, { scroll: false }));
    // A retry or selection reset can reuse the current URL definition.
    if (
      JSON.stringify(next) === JSON.stringify(definition) &&
      nextMode === mode
    )
      setRequestRevision((revision) => revision + 1);
    setLoading(true);
    setSelected(null);
    track({ type: 'filter_changed', fields: Object.keys(d) });
  }
  async function save() {
    try {
      await api('v1/account/saved-searches', 'POST', {
        name: definition.q || 'Мой поиск',
        definition,
      });
      setNotice('Поиск сохранён в аккаунте.');
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  return (
    <>
      <h1>Найдите своё место</h1>
      <form
        className="filters"
        key={definition.regionCode ?? 'all'}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          update({
            ...definition,
            ...advancedDefinition(data),
            q: String(data.get('q') ?? ''),
            category: String(data.get('category') || '') || undefined,
            dealType: (String(data.get('dealType') || '') ||
              undefined) as SearchDefinition['dealType'],
            price: {
              ...(data.get('min') ? { min: Number(data.get('min')) } : {}),
              ...(data.get('max') ? { max: Number(data.get('max')) } : {}),
            },
            locality: String(data.get('locality') || '') || undefined,
            attributes: {
              ...advancedDefinition(data).attributes,
              ...Object.fromEntries(
                ['rooms', 'area'].flatMap((attribute) => {
                  const min = data.get(attribute + 'Min');
                  const max = data.get(attribute + 'Max');
                  return min || max
                    ? [
                        [
                          attribute,
                          {
                            ...(min ? { min: Number(min) } : {}),
                            ...(max ? { max: Number(max) } : {}),
                          },
                        ],
                      ]
                    : [];
                }),
              ),
            },
            sort: String(data.get('sort')) as NonNullable<
              SearchDefinition['sort']
            >,
          });
        }}
      >
        <label>
          Регион
          <select
            name="regionCode"
            value={definition.regionCode ?? ''}
            disabled={regionError || regions.length === 0}
            onChange={(event) => {
              const attributes = { ...definition.attributes };
              for (const code of [
                'metro',
                'okrug',
                'highway',
                'highway_distance',
              ])
                delete attributes[code];
              const next = { ...definition };
              delete next.bounds;
              delete next.polygon;
              update({
                ...next,
                regionCode: event.target.value || undefined,
                locality: undefined,
                district: undefined,
                attributes,
              });
            }}
          >
            <option value="">Все регионы</option>
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.name}
              </option>
            ))}
          </select>
        </label>
        {regionError && <p role="alert">Не удалось загрузить регионы.</p>}
        <label>
          Поиск
          <input
            name="q"
            defaultValue={definition.q}
            placeholder="Квартира, район, адрес"
            maxLength={200}
          />
        </label>
        <label>
          Объект
          <select
            name="category"
            defaultValue={definition.category ?? ''}
            onChange={(e) => setFilterCategory(e.target.value || 'apartment')}
          >
            <option value="">Все объекты</option>
            <option value="apartment">Квартиры</option>
            <option value="room">Комнаты</option>
            <option value="aparthotel">Апартаменты</option>
            <option value="new_build">Новостройки</option>
            <option value="secondary">Вторичное жильё</option>
            <option value="house">Дома</option>
            <option value="townhouse">Таунхаусы</option>
            <option value="land">Участки</option>
            <option value="commercial">Коммерческие</option>
            <option value="parking">Паркинг</option>
          </select>
        </label>
        <label>
          Сделка
          <select name="dealType" defaultValue={definition.dealType ?? ''}>
            <option value="">Все сделки</option>
            <option value="sale">Купить</option>
            <option value="long_rent">Снять надолго</option>
            <option value="short_rent">Посуточно</option>
          </select>
        </label>
        <label>
          Цена от
          <input
            name="min"
            defaultValue={definition.price?.min}
            type="number"
            min="0"
          />
        </label>
        <label>
          Цена до
          <input
            name="max"
            defaultValue={definition.price?.max}
            type="number"
            min="0"
          />
        </label>
        <label>
          Город
          <input name="locality" defaultValue={definition.locality} />
        </label>
        <label>
          Комнат от
          <input
            name="roomsMin"
            defaultValue={
              typeof definition.attributes?.rooms === 'object'
                ? definition.attributes.rooms.min
                : undefined
            }
            type="number"
            min="0"
            max="50"
          />
        </label>
        <label>
          Комнат до
          <input
            name="roomsMax"
            defaultValue={
              typeof definition.attributes?.rooms === 'object'
                ? definition.attributes.rooms.max
                : undefined
            }
            type="number"
            min="0"
            max="50"
          />
        </label>
        <label>
          Площадь от, м²
          <input
            name="areaMin"
            defaultValue={
              typeof definition.attributes?.area === 'object'
                ? definition.attributes.area.min
                : undefined
            }
            type="number"
            step="any"
            min="0"
          />
        </label>
        <label>
          Площадь до, м²
          <input
            name="areaMax"
            defaultValue={
              typeof definition.attributes?.area === 'object'
                ? definition.attributes.area.max
                : undefined
            }
            type="number"
            step="any"
            min="0"
          />
        </label>
        <label>
          Сортировка
          <select name="sort" defaultValue={definition.sort ?? 'newest'}>
            <option value="newest">Сначала новые</option>
            <option value="price_asc">Дешевле</option>
            <option value="price_desc">Дороже</option>
            <option value="area_desc">Площадь</option>
          </select>
        </label>
        <AdvancedFilters category={filterCategory} definition={definition} />
        <Button className="primary" type="submit">
          Найти
        </Button>
      </form>
      <div className="toolbar">
        <Button
          aria-pressed={mode === 'list'}
          onClick={() => {
            update({ ...definition }, 'list');
            track({ type: 'mode_changed', mode: 'list' });
          }}
        >
          Список
        </Button>
        <Button
          aria-pressed={mode === 'map'}
          onClick={() => {
            update(
              {
                ...definition,
                bounds: definition.bounds ?? [37.3, 55.5, 37.9, 56.0],
              },
              'map',
            );
            track({ type: 'mode_changed', mode: 'map' });
          }}
        >
          Карта
        </Button>
        <Button onClick={save} disabled={loading || navigationPending}>
          Сохранить поиск
        </Button>
        <Link href="/account">Избранное и аккаунт</Link>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => update({ ...definition })}>Повторить</Button>
        </div>
      )}
      {loading && (
        <div className="skeleton" role="status">
          Загрузка объявлений…
        </div>
      )}
      {mode === 'map' && (
        <MapPanel
          definition={definition}
          onBounds={(bounds, polygon) =>
            update({ ...definition, bounds, polygon })
          }
          onSelect={async (ids) => {
            setSelected(ids);
            try {
              const result = await api<SearchPage>(
                'v1/search/selection',
                'POST',
                { ids, definition },
              );
              setPage(result);
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        />
      )}
      {!loading && !error && page && (
        <>
          <p role="status">Найдено около {page.total} объявлений</p>
          {page.items.length === 0 ? (
            <p>Объявления не найдены. Измените фильтры или область поиска.</p>
          ) : (
            <div className="cards">
              {page.items
                .filter((item) => !selected || selected.includes(item.id))
                .map((item) => (
                  <Card
                    key={item.id}
                    listing={item}
                    actions={
                      <Button
                        onClick={async () => {
                          try {
                            await api(
                              'v1/account/collections/favorite',
                              'POST',
                              { listingId: item.id },
                            );
                            track({
                              type: 'favorite_added',
                              listingId: item.id,
                            });
                            setNotice('Добавлено в избранное.');
                          } catch (e) {
                            setNotice((e as Error).message);
                          }
                        }}
                      >
                        В избранное
                      </Button>
                    }
                  />
                ))}
            </div>
          )}
          {selected && (
            <Button onClick={() => update({ ...definition })}>
              Показать все в области
            </Button>
          )}
          {page.cursor && (
            <Button
              onClick={async () => {
                try {
                  const next = await api<SearchPage>('v1/search', 'POST', {
                    ...definition,
                    cursor: page.cursor,
                  });
                  setPage({ ...next, items: [...page.items, ...next.items] });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Показать ещё
            </Button>
          )}
        </>
      )}
    </>
  );
}
