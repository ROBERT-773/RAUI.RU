'use client';
import { useEffect, useState } from 'react';
import type { SearchDefinition } from '@raui/types/product';
import { api } from '../lib/client';
interface Definition {
  code: string;
  name: string;
  kind: 'string' | 'number' | 'enum' | 'boolean';
  options: string[];
}
export function advancedDefinition(
  data: FormData,
  savedAttributes: NonNullable<SearchDefinition['attributes']> = {},
): Pick<
  SearchDefinition,
  'attributes' | 'pricePerM2' | 'district' | 'sellerType' | 'publishedAfter'
> {
  // Unrendered saved filters survive. A rendered blank field is an explicit clear.
  const attributes = new Map(
    Object.entries(savedAttributes).filter(
      ([code]) => !['rooms', 'area'].includes(code),
    ),
  );
  const rendered = new Set<string>();
  for (const [name, value] of data.entries()) {
    if (!name.startsWith('attribute:')) continue;
    const [, code, part] = name.split(':');
    if (!code) continue;
    if (!rendered.has(code)) {
      attributes.delete(code);
      rendered.add(code);
    }
    if (value === '') continue;
    if (part === 'min' || part === 'max') {
      const prior = attributes.get(code);
      attributes.set(code, {
        ...(typeof prior === 'object' ? prior : {}),
        [part]: Number(value),
      });
    } else
      attributes.set(
        code,
        part === 'boolean' ? value === 'true' : String(value),
      );
  }
  return {
    attributes: Object.fromEntries(attributes),
    pricePerM2: {
      ...(data.get('m2min') ? { min: Number(data.get('m2min')) } : {}),
      ...(data.get('m2max') ? { max: Number(data.get('m2max')) } : {}),
    },
    district: String(data.get('district') || '') || undefined,
    sellerType: (String(data.get('sellerType') || '') ||
      undefined) as SearchDefinition['sellerType'],
    publishedAfter: data.get('publishedAfter')
      ? new Date(String(data.get('publishedAfter'))).toISOString()
      : undefined,
  };
}
export default function AdvancedFilters({
  category,
  definition,
  onReadyCategory,
}: {
  category: string;
  definition: SearchDefinition;
  onReadyCategory?: (category: string | null) => void;
}) {
  const [request, setRequest] = useState({ category, revision: 0 });
  // A category round trip must not make an earlier ready result current again.
  // Adjust before commit so stale controls never enter the next category's form.
  if (request.category !== category)
    setRequest({ category, revision: request.revision + 1 });
  const revision = request.revision;
  const [lookup, setLookup] = useState<{
    category: string;
    revision: number;
    fields: Definition[];
    status: 'ready' | 'error';
  } | null>(null);
  const current = lookup?.category === category && lookup.revision === revision;
  const ready = current && lookup.status === 'ready';
  const failed = current && lookup.status === 'error';
  const fields = ready ? lookup.fields : [];
  const sameCategory = category === (definition.category ?? 'apartment');
  useEffect(() => {
    onReadyCategory?.(ready ? category : null);
  }, [ready, category, onReadyCategory]);
  useEffect(() => {
    let active = true;
    api<Definition[]>('v1/categories/' + category + '/attributes')
      .then((r) => {
        if (active)
          setLookup({
            category,
            revision,
            status: 'ready',
            fields: r.filter((f) => !['area', 'rooms'].includes(f.code)),
          });
      })
      .catch(() => {
        if (active)
          setLookup({ category, revision, status: 'error', fields: [] });
      });
    return () => {
      active = false;
    };
  }, [category, revision]);
  return (
    <>
      {!ready && !failed && (
        <p role="status">
          Загрузка дополнительных фильтров… Поиск доступен после загрузки.
        </p>
      )}
      {failed && (
        <div role="alert">
          <p>
            Не удалось загрузить дополнительные фильтры. Повторите загрузку
            перед поиском.
          </p>
          <button
            type="button"
            onClick={() => setRequest({ category, revision: revision + 1 })}
          >
            Повторить загрузку фильтров
          </button>
        </div>
      )}
      {!sameCategory && (
        <p role="status">
          При смене категории фильтры предыдущей категории будут удалены.
          Проверьте новые фильтры перед поиском.
        </p>
      )}
      <details className="advanced-filters">
        <summary>Все фильтры</summary>
        {ready && (
          <input type="hidden" name="advancedCategory" value={category} />
        )}
        <div className="filters">
          <label>
            Цена за м² от
            <input
              name="m2min"
              type="number"
              min="0"
              defaultValue={definition.pricePerM2?.min}
            />
          </label>
          <label>
            Цена за м² до
            <input
              name="m2max"
              type="number"
              min="0"
              defaultValue={definition.pricePerM2?.max}
            />
          </label>
          <label>
            Район
            <input name="district" defaultValue={definition.district} />
          </label>
          <label>
            Продавец
            <select
              name="sellerType"
              defaultValue={definition.sellerType ?? ''}
            >
              <option value="">Любой</option>
              <option value="owner">Собственник</option>
              <option value="agent">Агент</option>
              <option value="agency">Агентство</option>
              <option value="developer">Застройщик</option>
            </select>
          </label>
          <label>
            Опубликовано после
            <input
              name="publishedAfter"
              type="date"
              defaultValue={definition.publishedAfter?.slice(0, 10)}
            />
          </label>
          {fields.map((f) => {
            const v = sameCategory
              ? definition.attributes?.[f.code]
              : undefined;
            return f.kind === 'number' ? (
              <fieldset key={category + ':' + f.code}>
                <legend>{f.name}</legend>
                <label>
                  От
                  <input
                    name={'attribute:' + f.code + ':min'}
                    type="number"
                    step="any"
                    defaultValue={typeof v === 'object' ? v.min : undefined}
                  />
                </label>
                <label>
                  До
                  <input
                    name={'attribute:' + f.code + ':max'}
                    type="number"
                    step="any"
                    defaultValue={typeof v === 'object' ? v.max : undefined}
                  />
                </label>
              </fieldset>
            ) : (
              <label key={category + ':' + f.code}>
                {f.name}
                {f.kind === 'boolean' || f.kind === 'enum' ? (
                  <select
                    name={'attribute:' + f.code + ':' + f.kind}
                    defaultValue={v === undefined ? '' : String(v)}
                  >
                    <option value="">Не важно</option>
                    {f.kind === 'enum' &&
                      v !== undefined &&
                      !f.options.includes(String(v)) && (
                        <option value={String(v)}>
                          {String(v)} — сохранённое значение
                        </option>
                      )}
                    {(f.kind === 'boolean' ? ['true', 'false'] : f.options).map(
                      (option) => (
                        <option key={option} value={option}>
                          {option === 'true'
                            ? 'Да'
                            : option === 'false'
                              ? 'Нет'
                              : option}
                        </option>
                      ),
                    )}
                  </select>
                ) : (
                  <input
                    name={'attribute:' + f.code + ':string'}
                    defaultValue={typeof v === 'string' ? v : ''}
                    maxLength={150}
                  />
                )}
              </label>
            );
          })}
        </div>
      </details>
    </>
  );
}
