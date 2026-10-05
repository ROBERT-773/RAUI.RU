import 'server-only';
import { cache } from 'react';
export const apiBase = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
export const site = process.env.SITE_URL ?? 'http://localhost:3000';
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
  const response = await fetch(apiBase + '/v1/listings/' + id + '/public', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Listing unavailable');
  return (await response.json()) as Detail;
});
