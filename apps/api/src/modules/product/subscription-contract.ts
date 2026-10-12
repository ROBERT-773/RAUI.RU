import { z } from 'zod';

/** Explicit preferences; favorites never imply a subscription or email consent. */
export const listingSubscriptionSchema = z
  .object({
    events: z
      .array(z.enum(['price_drop', 'availability']))
      .min(1)
      .max(2),
    channels: z.array(z.literal('email')).min(1).max(2),
    frequency: z.literal('immediate'),
    version: z.number().int().nonnegative(),
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
