import type { MetadataRoute } from 'next';
import { site } from '../lib/server';
import { headers } from 'next/headers';
import { backendFetch } from '../lib/backend';
export const dynamic = 'force-dynamic';
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const response = await backendFetch('/v1/search/sitemap', await headers(), {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Sitemap unavailable');
  const rows = (await response.json()) as {
    id: string;
    published_at: string;
  }[];
  return [
    { url: site },
    ...rows.map((r) => ({
      url: site + '/listings/' + r.id,
      lastModified: r.published_at,
    })),
  ];
}
