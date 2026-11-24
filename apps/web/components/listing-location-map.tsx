'use client';

import { Button } from '@raui/ui';
import type { Map as LeafletMap } from 'leaflet';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './listing-location-map.module.css';

type Point = { latitude: number; longitude: number };

function LocationView({ latitude, longitude }: Point) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const tileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL;
  useEffect(() => {
    const container = element.current;
    if (!container) return;
    let disposed = false;
    let map: LeafletMap | undefined;
    async function open() {
      const { default: L } = await import('leaflet');
      if (disposed || !container) return;
      const position: [number, number] = [latitude, longitude];
      map = L.map(container, {
        scrollWheelZoom: false,
        minZoom: 2,
        maxZoom: 19,
      });
      map.setView(position, 16);
      const marker = L.marker(position, {
        keyboard: false,
        interactive: false,
        icon: L.divIcon({
          className: styles.pin,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).addTo(map);
      const icon = marker.getElement();
      icon?.setAttribute('role', 'img');
      icon?.setAttribute('aria-label', 'Метка объекта');
      if (tileUrl) {
        const tiles = L.tileLayer(tileUrl, {
          maxZoom: 19,
          attribution: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? '',
        });
        tiles.on('loading', () => setFailed(false));
        tiles.on('tileerror', () => setFailed(true));
        tiles.addTo(map);
      }
    }
    void open().catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [latitude, longitude, tileUrl]);

  return (
    <>
      <div
        ref={element}
        className={styles.map}
        role="group"
        aria-label="Интерактивная карта объекта"
      />
      <p>
        Широта {latitude}, долгота {longitude}
      </p>
      {(!tileUrl || failed) && (
        <p role="status">
          Фон карты недоступен. Местоположение указано координатами.
        </p>
      )}
    </>
  );
}

export default function ListingLocationMap(point: Point) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <Button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Скрыть карту' : 'Показать объект на карте'}
      </Button>
      <section id={id} aria-label="Карта объекта" hidden={!open}>
        {open && <LocationView {...point} />}
      </section>
    </>
  );
}
