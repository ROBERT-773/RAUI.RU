import 'server-only';
import { backendFetch } from './backend';
import { site } from './server';
export const sitemapPageSize = 49999;
export const sitemapCursor =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character]!,
  );
const xml = (name: string, contents: string) => {
  const body = `<?xml version="1.0" encoding="UTF-8"?><${name} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${contents}</${name}>`;
  if (new TextEncoder().encode(body).length > 50 * 1024 * 1024)
    throw new Error('Sitemap size exceeded');
  return body;
};
export function sitemapIndex(cursors: (string | null)[], origin = site) {
  if (
    !cursors.length ||
    cursors.length > 50000 ||
    cursors[0] !== null ||
    new Set(cursors).size !== cursors.length ||
    cursors
      .slice(1)
      .some(
        (cursor) => typeof cursor !== 'string' || !sitemapCursor.test(cursor),
      )
  )
    throw new Error('Sitemap partitions invalid');
  return xml(
    'sitemapindex',
    cursors
      .map(
        (cursor) =>
          `<sitemap><loc>${escape(origin + '/sitemaps/' + (cursor ?? 'start') + '.xml')}</loc></sitemap>`,
      )
      .join(''),
  );
}
export function sitemapPage(
  rows: { id: string; published_at: string }[],
  first: boolean,
  origin = site,
) {
  if (!Array.isArray(rows) || rows.length > sitemapPageSize)
    throw new Error('Sitemap page invalid');
  const listings = rows.map((row) => {
    if (
      !sitemapCursor.test(row.id) ||
      !Number.isFinite(Date.parse(row.published_at))
    )
      throw new Error('Sitemap row invalid');
    return `<url><loc>${escape(origin + '/listings/' + row.id)}</loc><lastmod>${escape(new Date(row.published_at).toISOString())}</lastmod></url>`;
  });
  return xml(
    'urlset',
    (first ? `<url><loc>${escape(origin)}</loc></url>` : '') +
      listings.join(''),
  );
}
export async function sitemapData(
  target: string,
  incoming: Headers,
): Promise<unknown> {
  const response = await backendFetch(target, incoming);
  if (!response.ok) throw new Error('Sitemap unavailable');
  return response.json();
}
export const sitemapResponse = (body: string) =>
  new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
export const unavailableSitemap = () =>
  new Response('Sitemap unavailable', {
    status: 503,
    headers: { 'cache-control': 'no-store' },
  });
