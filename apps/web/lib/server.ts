import 'server-only';
import { publicOrigin } from './security';
import { cache } from 'react';
import { headers } from 'next/headers';
import { backendFetch } from './backend';
export const site = publicOrigin(
  process.env.SITE_URL,
  process.env.DEPLOYMENT_ENV === 'production',
);
export interface Detail {
  id: string;
  title: string;
  description: string;
  price: string;
  dealType: string;
  property: {
    attributes: Record<string, unknown>;
    formatted: string;
    locality: string;
    longitude: number;
    latitude: number;
  };
  media: {
    id: string;
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
