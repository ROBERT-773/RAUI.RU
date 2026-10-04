import type { MetadataRoute } from 'next';
import { site } from '../lib/server';
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/account', '/api/', '/search?'],
    },
    sitemap: site + '/sitemap.xml',
  };
}
