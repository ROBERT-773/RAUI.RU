import type { MetadataRoute } from 'next';
import { apiBase, site } from '../lib/server';
export const dynamic = 'force-dynamic';
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const response = await fetch(apiBase + '/v1/search/sitemap', {
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
