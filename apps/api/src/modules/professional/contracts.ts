import { hash } from '../../common/security';
import { z } from 'zod';
import { addressSchema } from '../geo/geo';
import { fields } from '../listings/listings';
import { codeSchema } from '../catalog/catalog';
export const importItem = z
  .object({
    externalReference: z.string().trim().min(1).max(200),
    title: fields.title.min(3),
    price: fields.price,
    dealType: z.enum(['sale', 'long_rent', 'short_rent']),
    categoryCode: codeSchema,
    description: fields.description.default(''),
    attributes: z
      .record(
        z.string().max(50),
        z.union([z.string().max(2000), z.number(), z.boolean()]),
      )
      .default({}),
    address: addressSchema,
  })
  .strict();
export const importInput = z
  .object({ items: z.array(z.unknown()).min(1).max(1000) })
  .strict();
export const feedInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    format: z.enum(['json', 'csv', 'xml']),
    scheduleCron: z.string().max(120).optional(),
    mapping: z.record(z.string().max(80), z.string().max(200)).default({}),
    transport: z
      .object({
        kind: z.enum(['manual', 'https']),
        url: z.string().url().optional(),
      })
      .strict(),
  })
  .strict();
export const feedConfig = z
  .object({ version: z.number().int().positive(), active: z.boolean() })
  .strict();
// Conservative schedule grammar: hourly/minutely cadence, UTC; unsupported cron is rejected.
export function cadence(cron: string) {
  if (cron === '0 * * * *') return 60;
  if (cron === '0 0 * * *') return 1440;
  const m = /^\*\/([0-9]+) \* \* \* \*$/.exec(cron);
  const n = Number(m?.[1]);
  if (n >= 5 && n <= 60 && 60 % n === 0) return n;
  throw new Error(
    'Use */5, */10, */15, */20, */30, */60 minutes, hourly or daily UTC',
  );
}

export function nextDue(cron: string, now = new Date()) {
  const interval = cadence(cron) * 60000;
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}

export function normalizedFingerprint(value: unknown) {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : typeof v === 'object' && v !== null
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return hash(JSON.stringify(canonical(value)));
}
