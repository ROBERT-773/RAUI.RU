import 'server-only';
import type {
  ListingCard,
  PublicRentalTerms,
  SearchDefinition,
  SearchPage,
} from '@raui/types/product';
import { publicOrigin } from './security';
import { cache } from 'react';
import { headers } from 'next/headers';
import { backendFetch } from './backend';
export const site = publicOrigin(
  process.env.SITE_URL,
  process.env.DEPLOYMENT_ENV === 'production',
);
export async function publicRegions(): Promise<
  { code: string; name: string }[]
> {
  try {
    const response = await backendFetch('/v1/regions', await headers());
    if (response.ok) return (await response.json()).items;
  } catch {
    // Keep the rest of the homepage available.
  }
  return [];
}
export async function publicProfessional(
  id: string,
  regionCode?: string,
  page = 1,
) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const query = new URLSearchParams({ page: String(page) });
  if (regionCode) query.set('regionCode', regionCode);
  const response = await backendFetch(
    '/v1/search/professionals/' + id + '?' + query,
    await headers(),
  );
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error('Could not load professional profile');
  return (await response.json()) as {
    id: string;
    name: string;
    kind: 'agent' | 'agency';
    regionCodes: string[];
    listingCount: number;
    listingPageCount: number;
    listingCountsByRegion: Record<string, number>;
    listings: Pick<
      ListingCard,
      | 'id'
      | 'title'
      | 'price'
      | 'deal_type'
      | 'address'
      | 'attributes'
      | 'media'
    >[];
  };
}
export async function publicProfessionals(
  regionCode: string,
  kind?: 'agent' | 'agency',
  page = 1,
  name = '',
) {
  try {
    const query = new URLSearchParams({ regionCode });
    if (kind) {
      query.set('kind', kind);
      query.set('page', String(page));
      if (name) query.set('q', name);
    }
    const response = await backendFetch(
      '/v1/search/professionals?' + query,
      await headers(),
    );
    if (response.ok)
      return (await response.json()) as {
        items: { id: string; name: string; kind: 'agent' | 'agency' }[];
        hasMore: boolean;
        counts: { agent: number; agency: number };
      };
  } catch {
    // Keep the homepage available when the directory is unavailable.
  }
  return null;
}
export async function publicRegionCounts(): Promise<Record<string, number>> {
  try {
    const response = await backendFetch(
      '/v1/search/region-counts',
      await headers(),
    );
    if (response.ok) {
      const { items } = (await response.json()) as {
        items: { code: string; count: number }[];
      };
      return Object.fromEntries(items.map(({ code, count }) => [code, count]));
    }
  } catch {
    // Keep regional links available if the counts are unavailable.
  }
  return {};
}
export async function recentListings() {
  try {
    const response = await backendFetch('/v1/search/recent', await headers());
    if (response.ok)
      return (await response.json()) as {
        items: (Pick<
          ListingCard,
          | 'id'
          | 'title'
          | 'price'
          | 'deal_type'
          | 'address'
          | 'attributes'
          | 'media'
        > & { summary: string })[];
      };
  } catch {
    // The homepage search remains available when the feed is unavailable.
  }
  return null;
}
export async function searchCatalog(
  definition: SearchDefinition,
): Promise<SearchPage | null> {
  try {
    const response = await backendFetch('/v1/search', await headers(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    });
    return response.ok ? ((await response.json()) as SearchPage) : null;
  } catch {
    return null;
  }
}
export interface Detail {
  id: string;
  title: string;
  description: string;
  price: string;
  dealType: string;
  rentalTerms?: PublicRentalTerms;
  professionals?: { id: string; name: string; kind: 'agent' | 'agency' }[];
  property: {
    category_code: string;
    attributes: Record<string, unknown>;
    formatted: string;
    locality: string;
    longitude: number;
    latitude: number;
  };
  media: {
    id: string;
    kind: 'photo' | 'floor_plan';
    variants: Record<string, { url: string; width: number; height: number }>;
  }[];
}
export const detail = cache(async (id: string): Promise<Detail | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const response = await backendFetch(
    '/v1/listings/' + id + '/public',
    await headers(),
    {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Listing unavailable');
  return (await response.json()) as Detail;
});
