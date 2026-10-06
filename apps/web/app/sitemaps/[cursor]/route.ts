import {
  sitemapData,
  sitemapCursor,
  sitemapPage,
  sitemapResponse,
  unavailableSitemap,
} from '../../../lib/sitemap';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ cursor: string }> },
) {
  const { cursor } = await context.params;
  const id = cursor.endsWith('.xml') ? cursor.slice(0, -4) : '';
  if (id !== 'start' && !sitemapCursor.test(id))
    return new Response('Not found', { status: 404 });
  try {
    const rows = (await sitemapData(
      '/v1/search/sitemap' + (id === 'start' ? '' : '?after=' + id),
      request.headers,
    )) as { id: string; published_at: string }[];
    return sitemapResponse(sitemapPage(rows, id === 'start'));
  } catch {
    return unavailableSitemap();
  }
}
