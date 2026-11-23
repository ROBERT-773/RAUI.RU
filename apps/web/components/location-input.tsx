'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '../lib/client';
import { metroSuggestions } from '../lib/metro-catalog';

const recent = new Map<string, { items: string[]; expires: number }>();

export default function LocationInput({
  kind,
  name,
  label,
  initial = '',
  region,
  city,
  onValueChange,
}: {
  kind: 'city' | 'metro';
  name: string;
  label?: string;
  initial?: string | undefined;
  region?: string | undefined;
  city?: string | undefined;
  onValueChange?: (value: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const scope =
    kind === 'metro'
      ? JSON.stringify([
          region ?? '',
          city?.trim().toLocaleLowerCase('ru') ?? '',
        ])
      : '';
  const [previousScope, setPreviousScope] = useState(scope);
  if (previousScope !== scope) {
    setPreviousScope(scope);
    setValue('');
  }
  const [active, setActive] = useState(false);
  const [suggestions, setSuggestions] = useState<{
    key: string;
    items: string[];
  }>();
  const params = new URLSearchParams({ kind, q: value.trim().slice(0, 100) });
  if (region) params.set('regionCode', region);
  if (kind === 'metro' && city?.trim()) params.set('locality', city.trim());
  const key = params.toString();
  const items = suggestions?.key === key ? suggestions.items : [];
  const metro = kind === 'metro' ? metroSuggestions(region, city, value) : [];

  useEffect(() => {
    if (!active || kind === 'metro') return;
    let current = true;
    const timer = window.setTimeout(() => {
      const saved = recent.get(key);
      if (saved && saved.expires > Date.now()) {
        setSuggestions({ key, items: saved.items });
        return;
      }
      void api<{ items: string[] }>('v1/search/locations?' + key)
        .then(({ items: names }) => {
          if (recent.size >= 64) {
            const oldest = recent.keys().next().value;
            if (oldest !== undefined) recent.delete(oldest);
          }
          recent.set(key, { items: names, expires: Date.now() + 60_000 });
          if (current) setSuggestions({ key, items: names });
        })
        .catch(() => {
          if (current) setSuggestions(undefined);
        });
    }, 175);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active, key, kind]);

  return (
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setActive(false);
      }}
    >
      <input
        name={name}
        aria-label={label}
        list={kind === 'city' ? id : undefined}
        value={value}
        maxLength={150}
        autoComplete="off"
        onFocus={() => setActive(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setActive(false);
        }}
        onChange={(event) => {
          setValue(event.target.value);
          setActive(true);
          onValueChange?.(event.target.value);
        }}
      />
      {kind === 'city' && (
        <datalist id={id}>
          {items.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      )}
      {kind === 'metro' && active && metro.length > 0 && (
        <ul aria-label="Станции метро" className="metro-suggestions">
          {metro.map(({ id: key, name, line, color }) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => {
                  setValue(name);
                  setActive(false);
                  onValueChange?.(name);
                }}
              >
                <span
                  aria-hidden="true"
                  className="metro-line-dot"
                  style={{ backgroundColor: color }}
                />
                {name} · {line}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
