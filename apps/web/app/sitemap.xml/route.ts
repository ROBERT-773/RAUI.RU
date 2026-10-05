import {
  sitemapData,
  sitemapIndex,
  sitemapResponse,
  unavailableSitemap,
} from '../../lib/sitemap';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const partitions = (await sitemapData(
      '/v1/search/sitemap/partitions',
      request.headers,
    )) as { pageSize: number; cursors: (string | null)[] };
    if (partitions.pageSize !== 49999 || !Array.isArray(partitions.cursors))
      throw new Error('Sitemap partitions invalid');
    return sitemapResponse(sitemapIndex(partitions.cursors));
  } catch {
    return unavailableSitemap();
  }
}
