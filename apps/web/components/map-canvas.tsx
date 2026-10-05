'use client';
import { useEffect, useRef, useEffectEvent } from 'react';
import L from 'leaflet';
import type { MapMarker } from '@raui/types/product';
import { money } from '../lib/client';
export default function MapCanvas({
  bounds,
  markers,
  onBounds,
  onSelect,
  onPolygon,
}: {
  bounds: [number, number, number, number];
  markers: MapMarker[];
  onBounds: (b: [number, number, number, number]) => void;
  onSelect: (ids: string[]) => void;
  onPolygon: (p: [number, number][]) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    layer = useRef<L.LayerGroup | null>(null),
    drawing = useRef<[number, number][]>([]),
    drawingLayer = useRef<L.Polyline | null>(null);
  const moved = useEffectEvent((b: [number, number, number, number]) =>
    onBounds(b),
  );
  const selected = useEffectEvent((ids: string[]) => onSelect(ids));

  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, {
      zoomControl: true,
      worldCopyJump: false,
      minZoom: 2,
      maxZoom: 19,
    });
    instance.setView([55.75, 37.6], 10);
    map.current = instance;
    const tileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL;
    if (tileUrl)
      L.tileLayer(tileUrl, {
        attribution: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? '',
        maxZoom: 19,
      }).addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    instance.on('moveend', () => {
      const b = instance.getBounds();
      moved([
        Math.max(-180, b.getWest()),
        Math.max(-90, b.getSouth()),
        Math.min(180, b.getEast()),
        Math.min(90, b.getNorth()),
      ]);
    });
    instance.on('click', (event: L.LeafletMouseEvent) => {
      if (!drawingLayer.current) return;
      drawing.current.push([event.latlng.lng, event.latlng.lat]);
      drawingLayer.current.setLatLngs(
        drawing.current.map(([lon, lat]) => [lat, lon]),
      );
    });
    return () => {
      instance.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const b = instance.getBounds();
    if (
      !b.isValid() ||
      Math.abs(b.getWest() - bounds[0]) > 0.0001 ||
      Math.abs(b.getSouth() - bounds[1]) > 0.0001 ||
      Math.abs(b.getEast() - bounds[2]) > 0.0001 ||
      Math.abs(b.getNorth() - bounds[3]) > 0.0001
    ) {
      instance.fitBounds(
        [
          [bounds[1], bounds[0]],
          [bounds[3], bounds[2]],
        ],
        { animate: false },
      );
    }
  }, [bounds]);
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    for (const marker of markers) {
      const text =
        (marker.count > 1 ? marker.count + ' · ' : '') + money(marker.minPrice);
      const icon = L.divIcon({
        className: 'price-marker',
        html: '<span data-count="' + marker.count + '">' + text + '</span>',
        iconSize: [150, 44],
        iconAnchor: [75, 22],
      });
      const item = L.marker([marker.latitude, marker.longitude], {
        icon,
        keyboard: true,
        title: text,
        alt: text,
      }).addTo(group);
      item.on('click', () => selected(marker.listingIds));
    }
  }, [markers]);
  return (
    <>
      <div
        ref={element}
        className="leaflet-map"
        aria-label="Карта недвижимости"
      />
      <div className="actions">
        <button
          onClick={() => {
            if (!map.current) return;
            if (drawingLayer.current)
              map.current.removeLayer(drawingLayer.current);
            drawing.current = [];
            drawingLayer.current = L.polyline([], { color: '#07537b' }).addTo(
              map.current,
            );
          }}
        >
          Нарисовать область
        </button>
        <button
          onClick={() => {
            if (drawing.current.length < 3) return;
            const points = [...drawing.current, drawing.current[0]!];
            onPolygon(points);
            if (map.current && drawingLayer.current)
              map.current.removeLayer(drawingLayer.current);
            drawingLayer.current = null;
          }}
        >
          Завершить область
        </button>
      </div>
      <p>
        Перемещайте карту мышью, касанием или клавишами стрелок. Для области
        отметьте минимум три точки и завершите контур.
      </p>
    </>
  );
}
