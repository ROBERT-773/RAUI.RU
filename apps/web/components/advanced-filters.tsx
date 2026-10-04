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
): Pick<
  SearchDefinition,
  'attributes' | 'pricePerM2' | 'district' | 'sellerType' | 'publishedAfter'
> {
  const attributes: NonNullable<SearchDefinition['attributes']> = {};
  for (const [name, value] of data.entries()) {
    if (!name.startsWith('attribute:') || value === '') continue;
    const [, code, part] = name.split(':');
    if (!code) continue;
    if (part === 'min' || part === 'max') {
      const prior = attributes[code];
      attributes[code] = {
        ...(typeof prior === 'object' ? prior : {}),
        [part]: Number(value),
      };
    } else
      attributes[code] = part === 'boolean' ? value === 'true' : String(value);
  }
  return {
    attributes,
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
}: {
  category: string;
  definition: SearchDefinition;
}) {
  const [fields, setFields] = useState<Definition[]>([]);
  useEffect(() => {
    let active = true;
    api<Definition[]>('v1/categories/' + category + '/attributes')
      .then((r) => {
        if (active)
          setFields(r.filter((f) => !['area', 'rooms'].includes(f.code)));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [category]);
  return (
    <details className="advanced-filters">
      <summary>Все фильтры</summary>
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
          <select name="sellerType" defaultValue={definition.sellerType ?? ''}>
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
          const v = definition.attributes?.[f.code];
          return f.kind === 'number' ? (
            <fieldset key={f.code}>
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
            <label key={f.code}>
              {f.name}
              {f.kind === 'boolean' || f.kind === 'enum' ? (
                <select
                  name={'attribute:' + f.code + ':' + f.kind}
                  defaultValue={v === undefined ? '' : String(v)}
                >
                  <option value="">Не важно</option>
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
  );
}
