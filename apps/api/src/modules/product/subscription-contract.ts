import { z } from 'zod';

/** Explicit preferences; favorites never imply a subscription or email consent. */
export const listingSubscriptionSchema = z
  .object({
    events: z
      .array(z.enum(['price_drop', 'availability']))
      .min(1)
      .max(2),
    channels: z
      .array(z.enum(['in_app', 'email']))
      .min(1)
      .max(2),
    frequency: z.enum(['immediate', 'daily']),
    consent: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['events', 'channels'] as const) {
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Duplicate subscription preference',
        });
    }
  });

export const listingSubscriptionDisableSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export const listingSubscriptionConsentVersion = 'listing-updates-v1';

/** Internal server-owned envelope; never accepted from a public job-creation API. */
export const listingSubscriptionDeliverySchema = z
  .object({
    listingId: z.uuid(),
    listingVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    subscriptionVersion: z.number().int().positive(),
    event: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('price_drop'),
          previousPriceMinor: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER),
          priceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict()
        .refine((event) => event.priceMinor < event.previousPriceMinor),
      z
        .object({ kind: z.literal('availability'), available: z.boolean() })
        .strict(),
    ]),
  })
  .strict();
