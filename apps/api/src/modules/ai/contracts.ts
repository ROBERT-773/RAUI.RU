import { z } from 'zod';
import { uuid } from '../../common/security';
import { searchSchema } from '../search/contracts';
export const capabilities = z.enum([
  'search',
  'realtor',
  'description',
  'moderation',
  'duplicates',
  'photo',
  'recommendations',
  'valuation',
  'analytics',
  'support',
]);
export type Capability = z.infer<typeof capabilities>;
export const aiRequest = z
  .object({
    capability: capabilities,
    query: z.string().trim().min(1).max(2000).optional(),
    listingId: uuid.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      ['search', 'realtor', 'support'].includes(value.capability) &&
      !value.query
    )
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'Query required',
      });
    if (
      [
        'description',
        'moderation',
        'duplicates',
        'photo',
        'recommendations',
        'valuation',
      ].includes(value.capability) &&
      !value.listingId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['listingId'],
        message: 'Listing required',
      });
  });
export const flagRequest = z
  .object({ enabled: z.boolean(), version: z.number().int().positive() })
  .strict();
export const providerReply = z
  .object({
    suggestion: z.string().max(4000),
    confidence: z.number().min(0).max(1),
    modelVersion: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    filters: searchSchema.omit({ cursor: true }).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).max(100000),
        outputTokens: z.number().int().min(0).max(10000),
        costMicros: z.number().int().min(0).max(1000000),
      })
      .strict(),
  })
  .strict();
export const PROMPT_VERSION = 'phase4c-v1';
export const RULE_VERSION = 'trust-v1';
