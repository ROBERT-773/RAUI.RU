import type { SearchDefinition } from '@raui/types/product';

type Bounds = NonNullable<SearchDefinition['bounds']>;

// Starting viewports for browsing, not administrative boundaries.
const regionalViewports: Partial<Record<string, Bounds>> = {
  moscow_oblast: [34.9, 54.2, 40.3, 57.0],
  saint_petersburg: [29.4, 59.6, 31.0, 60.3],
  adygea: [38.6, 43.7, 40.9, 45.4],
  altai_republic: [83.8, 49.0, 89.9, 52.7],
  altai_krai: [77.8, 50.0, 87.4, 54.2],
};

export function searchMapBounds(
  regionCode: string | undefined,
  bounds: Bounds | undefined,
): Bounds {
  return (
    bounds ??
    (regionCode && Object.hasOwn(regionalViewports, regionCode)
      ? regionalViewports[regionCode]
      : undefined) ?? [37.3, 55.5, 37.9, 56.0]
  );
}
