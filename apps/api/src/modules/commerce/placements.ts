import { Injectable, Module } from '@nestjs/common';
import { Database } from '../database/database';
export type PromotionKind =
  'standard' | 'highlighted' | 'premium' | 'vip' | 'super_vip' | 'top';

export interface PaidPlacementSignal {
  listingId: string;
  code: string;
  kind: PromotionKind;
  priority: number;
  endsAt: string;
}

export function attachPaidPlacementSignals<T extends { id: string }>(
  organic: T[],
  signals: PaidPlacementSignal[],
) {
  const byListing = new Map<string, PaidPlacementSignal>();
  for (const signal of signals) {
    const prior = byListing.get(signal.listingId);
    if (
      !prior ||
      signal.priority > prior.priority ||
      (signal.priority === prior.priority && signal.endsAt > prior.endsAt)
    )
      byListing.set(signal.listingId, signal);
  }
  return organic.map((item) => ({
    ...item,
    paidPlacement: byListing.get(item.id) ?? null,
  }));
}

/** Read-only commercial projection for the batched search-card query.
 * The caller supplies the fixed candidate(listing_id) SQL relation. */
export const paidPlacementProjection = `(SELECT jsonb_build_object('listingId',a.listing_id,'code',p.code,'kind',p.kind,'priority',p.priority,'endsAt',a.ends_at) FROM commerce_promotion_activations a JOIN commerce_promotion_products p ON p.id=a.promotion_product_id WHERE a.listing_id=candidate.listing_id AND a.status='active' AND a.starts_at<=now() AND a.ends_at>now() AND EXISTS(SELECT 1 FROM commerce_feature_flags f WHERE f.code='promotions' AND f.enabled) ORDER BY p.priority DESC,a.ends_at DESC,a.id LIMIT 1)`;
@Injectable()
export class PaidPlacementService {
  constructor(private readonly db: Database) {}

  async signals(listingIds: string[]): Promise<PaidPlacementSignal[]> {
    if (!listingIds.length) return [];
    return this.db.rows<PaidPlacementSignal>(
      `SELECT
         a.listing_id AS "listingId",
         p.code,
         p.kind,
         p.priority,
         a.ends_at AS "endsAt"
       FROM commerce_promotion_activations a
       JOIN commerce_promotion_products p ON p.id=a.promotion_product_id
       WHERE a.listing_id=ANY($1::uuid[])
         AND a.status='active'
         AND a.starts_at<=now()
         AND a.ends_at>now()
         AND EXISTS(SELECT 1 FROM commerce_feature_flags f WHERE f.code='promotions' AND f.enabled)
         AND EXISTS(SELECT 1 FROM public_search_listings s WHERE s.id=a.listing_id)
       ORDER BY a.listing_id,p.priority DESC,a.ends_at DESC`,
      [listingIds],
    );
  }

  attach<T extends { id: string }>(
    organic: T[],
    signals: PaidPlacementSignal[],
  ) {
    return attachPaidPlacementSignals(organic, signals);
  }
}

@Module({ providers: [PaidPlacementService], exports: [PaidPlacementService] })
export class PaidPlacementModule {}
