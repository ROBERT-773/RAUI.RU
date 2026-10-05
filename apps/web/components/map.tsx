'use client';
import { Button } from '@raui/ui';
import { useEffect, useState, useMemo } from 'react';
import type { MapMarker, SearchDefinition } from '@raui/types/product';
import MapCanvas from './map-canvas';
import { api } from '../lib/client';
export default function MapPanel({
  definition,
  onBounds,
  onSelect,
}: {
  definition: SearchDefinition;
  onBounds: (
    bounds: [number, number, number, number],
    polygon?: [number, number][],
  ) => void;
  onSelect: (ids: string[]) => void;
}) {
  const [markers, setMarkers] = useState<MapMarker[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [truncated, setTruncated] = useState(false),
    [polygon, setPolygon] = useState('');
  const bounds = useMemo<[number, number, number, number]>(
    () => definition.bounds ?? [37.3, 55.5, 37.9, 56.0],
    [definition.bounds],
  );
  useEffect(() => {
    let active = true;
    api<{ markers: MapMarker[]; truncated: boolean }>('v1/search/map', 'POST', {
      ...definition,
      bounds,
      cursor: undefined,
    })
      .then((r) => {
        if (active) {
          setMarkers(r.markers);
          setTruncated(r.truncated);
          setError('');
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
  }, [definition, bounds]);
  function move(dx: number, dy: number, scale = 1) {
    const [w, s, e, n] = bounds,
      cx = (w + e) / 2 + dx,
      cy = (s + n) / 2 + dy,
      hw = ((e - w) * scale) / 2,
      hh = ((n - s) * scale) / 2;
    onBounds([
      Math.max(-180, cx - hw),
      Math.max(-90, cy - hh),
      Math.min(180, cx + hw),
      Math.min(90, cy + hh),
    ]);
  }
  return (
    <section aria-label="Карта результатов">
      <p>Объявления на карте</p>
      <div className="map-controls">
        <Button
          onClick={() => move(-(bounds[2] - bounds[0]) / 3, 0)}
          aria-label="На запад"
        >
          ←
        </Button>
        <Button
          onClick={() => move(0, (bounds[3] - bounds[1]) / 3)}
          aria-label="На север"
        >
          ↑
        </Button>
        <Button
          onClick={() => move(0, -(bounds[3] - bounds[1]) / 3)}
          aria-label="На юг"
        >
          ↓
        </Button>
        <Button
          onClick={() => move((bounds[2] - bounds[0]) / 3, 0)}
          aria-label="На восток"
        >
          →
        </Button>
        <Button onClick={() => move(0, 0, 0.5)} aria-label="Приблизить">
          +
        </Button>
        <Button onClick={() => move(0, 0, 2)} aria-label="Отдалить">
          −
        </Button>
      </div>
      {loading && <p role="status">Загрузка карты…</p>}
      {error && <p role="alert">{error}</p>}
      {truncated && (
        <p role="status">Приблизьте карту: показана часть результатов.</p>
      )}
      <MapCanvas
        bounds={bounds as [number, number, number, number]}
        markers={markers}
        onBounds={(b) => onBounds(b, definition.polygon)}
        onSelect={onSelect}
        onPolygon={(p) =>
          onBounds(bounds as [number, number, number, number], p)
        }
      />
      <p>{bounds.map((v) => v.toFixed(3)).join(' / ')}</p>
      <details>
        <summary>Область поиска</summary>
        <label>
          Полигон: пары долгота,широта через пробел
          <input
            value={polygon}
            onChange={(e) => setPolygon(e.target.value)}
            placeholder="37.4,55.6 37.8,55.6 37.8,55.9 37.4,55.6"
          />
        </label>
        <Button
          onClick={() => {
            try {
              const points = polygon
                .trim()
                .split(/\s+/)
                .map((v) => v.split(',').map(Number) as [number, number]);
              if (
                points.length < 4 ||
                points.some((p) => p.length !== 2 || !p.every(Number.isFinite))
              )
                throw Error();
              onBounds(bounds as [number, number, number, number], points);
              setError('');
            } catch {
              setError(
                'Укажите минимум четыре пары координат, замкнув контур.',
              );
            }
          }}
        >
          Применить область
        </Button>
        <Button
          onClick={() => onBounds(bounds as [number, number, number, number])}
        >
          Сбросить область
        </Button>
      </details>
    </section>
  );
}
