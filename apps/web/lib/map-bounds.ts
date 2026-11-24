import type { SearchDefinition } from '@raui/types/product';

type Bounds = NonNullable<SearchDefinition['bounds']>;
const allLocations: Bounds = [-180, -90, 180, 90];
const countryOverview: Bounds = [19, 41, 180, 82];
// Familiar starting views for an empty catalogue, never geographic search filters.
const emptyViewports: Partial<Record<string, Bounds>> = {
  moscow: [37.3, 55.5, 37.9, 56.0],
  moscow_oblast: [34.9, 54.2, 40.3, 57.0],
  saint_petersburg: [29.4, 59.6, 31.0, 60.3],
  adygea: [38.6, 43.7, 40.9, 45.4],
  altai_republic: [83.8, 49.0, 89.9, 52.7],
  altai_krai: [77.8, 50.0, 87.4, 54.2],
};

export function emptyMapBounds(regionCode: string | undefined): Bounds {
  return regionCode && Object.hasOwn(emptyViewports, regionCode)
    ? emptyViewports[regionCode]!
    : countryOverview;
}

export function constrainViewport([west, south, east, north]: Bounds): Bounds {
  const width = Math.min(360, Math.max(0.00001, east - west));
  const height = Math.min(180, Math.max(0.00001, north - south));
  const left = Math.max(-180, Math.min(180 - width, west));
  const bottom = Math.max(-90, Math.min(90 - height, south));
  return [left, bottom, left + width, bottom + height];
}

export function searchMapBounds(definition: SearchDefinition): Bounds {
  if (definition.bounds) return definition.bounds;
  if (!definition.polygon?.length) return allLocations;
  const xs = definition.polygon.map(([longitude]) => longitude);
  const ys = definition.polygon.map(([, latitude]) => latitude);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function fitResultExtent([west, south, east, north]: Bounds): Bounds {
  // Give a single address a neighbourhood-sized viewport; keep outlying results visible.
  const dx = Math.max((east - west) * 0.1, 0.012);
  const dy = Math.max((north - south) * 0.1, 0.008);
  return [
    Math.max(-180, west - dx),
    Math.max(-90, south - dy),
    Math.min(180, east + dx),
    Math.min(90, north + dy),
  ];
}
