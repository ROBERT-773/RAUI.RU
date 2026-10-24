import { z } from 'zod';
const generation = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
const dependency = z.object({ id: z.uuid(), generation }).strict();
export const visibilityTokenSchema = z
  .object({
    seller: dependency,
    organization: dependency.nullable(),
    membership: z
      .object({ organizationId: z.uuid(), userId: z.uuid(), generation })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.organization === null
        ? value.membership !== null
        : !value.membership ||
          value.membership.organizationId !== value.organization.id ||
          value.membership.userId !== value.seller.id
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid visibility dependency identity',
      });
  });
export type VisibilityToken = z.infer<typeof visibilityTokenSchema>;
export interface VisibilitySnapshot {
  version: number;
  visible: boolean;
  visibilityToken: VisibilityToken | null;
}
export function legacyVisibilityToken(token: VisibilityToken) {
  return (
    token.seller.generation === '0' &&
    (!token.organization || token.organization.generation === '0') &&
    (!token.membership || token.membership.generation === '0')
  );
}
export function availabilityDedupeKey(
  listingId: string,
  version: number,
  token: VisibilityToken,
) {
  const t = visibilityTokenSchema.parse(token);
  return [
    'listing',
    listingId,
    version,
    'availability-v2',
    t.seller.id,
    t.seller.generation,
    t.organization?.id ?? '-',
    t.organization?.generation ?? '-',
    t.membership?.userId ?? '-',
    t.membership?.generation ?? '-',
  ].join(':');
}
export function sameVisibilityToken(
  left: VisibilityToken,
  right: VisibilityToken,
) {
  return (
    availabilityDedupeKey('', 1, left) === availabilityDedupeKey('', 1, right)
  );
}
