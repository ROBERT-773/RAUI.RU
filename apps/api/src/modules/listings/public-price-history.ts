import { z } from 'zod';
import type { Sql } from '../database/database';

const publicPrice = z
  .string()
  .regex(/^[0-9]{1,14}(?:\.[0-9]{1,2})?$/)
  .refine((value) => {
    if (!/^[0-9]{1,14}(?:\.[0-9]{1,2})?$/.test(value)) return false;
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) > 0n;
  });
export const publicPriceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    price: publicPrice,
    currency: z.literal('RUB'),
    listingVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capturedAt: z.iso.datetime({ precision: 3 }).refine((value) => {
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.toISOString() === value;
    }),
  })
  .strict();
export type PublicPriceSnapshot = z.infer<typeof publicPriceSnapshotSchema>;

/** Internal server capture only: eligibility and values come from ListingAccess.
 * This is capture-query evidence, not a claim that a visitor saw the price.
 */
export function buildPublicPriceSnapshot(input: {
  price: string;
  currency: string;
  listingVersion: number;
  capturedAt: Date;
}): PublicPriceSnapshot {
  return publicPriceSnapshotSchema.parse({
    ...input,
    schemaVersion: 1,
    capturedAt: input.capturedAt.toISOString(),
  });
}

/** No historical inference: latest marked record is authoritative or unusable.
 * Legacy records without a marker are ignored; corrupt latest never falls back.
 */
export async function readLastPublicPriceSnapshot(
  sql: Sql,
  listingId: string,
): Promise<PublicPriceSnapshot | null> {
  const { rows } = await sql.query<{ after_data: unknown }>(
    `SELECT after_data FROM listing_history WHERE listing_id=$1
     AND event='moderation.decided' AND after_data ? 'publicPriceSnapshot'
     ORDER BY id DESC LIMIT 1`,
    [listingId],
  );
  const parsed = z
    .object({
      status: z.literal('published'),
      publicPriceSnapshot: publicPriceSnapshotSchema,
    })
    .safeParse(rows[0]?.after_data);
  return parsed.success ? parsed.data.publicPriceSnapshot : null;
}
