'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '../lib/client';

const recent = new Map<string, { items: string[]; expires: number }>();

export default function LocationInput({
  kind,
  name,
  initial = '',
  region,
  city,
  onValueChange,
}: {
  kind: 'city' | 'metro';
  name: string;
  initial?: string | undefined;
  region?: string | undefined;
  city?: string | undefined;
  onValueChange?: (value: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [active, setActive] = useState(false);
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    if (!active) return;
    const params = new URLSearchParams({ kind, q: value.trim().slice(0, 100) });
    if (region) params.set('regionCode', region);
    if (kind === 'metro' && city?.trim()) params.set('locality', city.trim());
    const key = params.toString();
    let current = true;
    const timer = window.setTimeout(() => {
      const saved = recent.get(key);
      if (saved && saved.expires > Date.now()) {
        setItems(saved.items);
        return;
      }
      void api<{ items: string[] }>('v1/search/locations?' + key)
        .then(({ items: names }) => {
          if (recent.size >= 64) {
            const oldest = recent.keys().next().value;
            if (oldest !== undefined) recent.delete(oldest);
          }
          recent.set(key, { items: names, expires: Date.now() + 60_000 });
          if (current) setItems(names);
        })
        .catch(() => {
          if (current) setItems([]);
        });
    }, 175);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active, city, kind, region, value]);

  return (
    <>
      <input
        name={name}
        list={id}
        value={value}
        maxLength={150}
        autoComplete="off"
        onFocus={() => setActive(true)}
        onChange={(event) => {
          setValue(event.target.value);
          onValueChange?.(event.target.value);
        }}
      />
      <datalist id={id}>
        {items.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
    </>
  );
}
