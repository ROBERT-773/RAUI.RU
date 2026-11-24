import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Module,
} from '@nestjs/common';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { Trust, TrustModule } from '../trust/trust';
import { enqueueImmediateListingNotifications } from '../product/subscription-outbox';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { Listings, ListingsModule } from './listings';
import { readListingVisibility, type Listing } from './access';
import {
  PublicationQuotas,
  PublicationQuotaModule,
  type PublicationSeller,
} from './publication-quota';
import { readLastPublicPriceSnapshot } from './public-price-history';

type FeedPublication = {
  listingId: string;
  feedId: string;
  actorId: string;
  runId: string;
  offer?: {
    title: string;
    price: number;
    description: string;
    dealType: Listing['deal_type'];
  };
  mediaChanged?: boolean;
};
type PublicationOrigin =
  | { kind: 'moderation'; actorId: string; caseId: string; reason: string }
  | { kind: 'feed'; actorId: string; feedId: string; runId: string };

@Injectable()
export class ListingPublications {
  constructor(
    private readonly db: Database,
    private readonly listings: Listings,
    private readonly quotas: PublicationQuotas,
    private readonly trust: Trust,
    private readonly audit: Audit,
    private readonly organizations: Organizations,
  ) {}

  /** The caller owns the current transaction, locks and pending moderation case. */
  async approveModerated(
    sql: Sql,
    listing: Listing,
    seller: PublicationSeller,
    actorId: string,
    caseId: string,
    reason: string,
  ) {
    await this.publish(sql, listing, listing, seller, {
      kind: 'moderation',
      actorId,
      caseId,
      reason,
    });
  }

  /** The worker verifies the current source approval under lock and owns the row savepoint. */
  async publishFromFeed(
    sql: Sql,
    input: FeedPublication,
  ): Promise<'published' | 'updated' | 'unchanged'> {
    const [reference] = await this.db.rows<Listing>(
      `SELECT l.* FROM listings l JOIN listing_sources s ON s.id=l.source_id
       JOIN professional_feed_definitions f ON f.id=$2 AND s.metadata->>'feedId'=f.id::text
       JOIN professional_import_runs r ON r.id=$3 AND r.feed_id=f.id AND r.mode='apply' AND r.status='running'
         AND r.requested_by=$4 AND r.source_version=f.version AND r.organization_id IS NOT DISTINCT FROM f.organization_id
       WHERE l.id=$1 AND s.kind='feed' AND f.active AND f.publication_approved_at IS NOT NULL
         AND l.organization_id IS NOT DISTINCT FROM f.organization_id
         AND s.organization_id IS NOT DISTINCT FROM f.organization_id
         AND (f.organization_id IS NOT NULL OR (s.personal_feed_owner_id=f.created_by AND l.seller_id=f.created_by))
       FOR SHARE OF f`,
      [input.listingId, input.feedId, input.runId, input.actorId],
      sql,
    );
    if (!reference)
      throw new ForbiddenException('Feed publication source mismatch');
    const seller = await this.quotas.lockSeller(sql, reference.seller_id);
    if (
      !['agent', 'agency', 'developer'].includes(seller.role) ||
      (!reference.organization_id && seller.role !== 'agent')
    )
      throw new ForbiddenException(
        'Professional seller required for XML publication',
      );
    if (reference.organization_id)
      await this.organizations.permission(
        { ...seller, session_id: '' },
        reference.organization_id,
        false,
        sql,
      );
    await sql.query('SELECT id FROM properties WHERE id=$1 FOR UPDATE', [
      reference.property_id,
    ]);
    const [before] = await this.db.rows<
      Listing & { published_at: Date | null }
    >('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [input.listingId], sql);
    if (
      !before ||
      before.source_id !== reference.source_id ||
      before.property_id !== reference.property_id ||
      before.seller_id !== reference.seller_id ||
      before.organization_id !== reference.organization_id
    )
      throw new ConflictException('Listing identity changed');
    if (before.status !== 'draft' && before.status !== 'published')
      throw new ConflictException('Listing retained its current status');
    if (
      before.status === 'published' &&
      !(await readListingVisibility(sql, before.id))?.visible
    )
      throw new ForbiddenException('Listing is no longer public');
    if (before.status === 'draft') {
      const withdrawal =
        before.published_at ||
        (
          await this.db.rows(
            `SELECT 1 FROM listing_history WHERE listing_id=$1 AND
          (after_data->>'status' IN ('paused','rejected','archived','sold','rented') OR
           (before_data->>'status'='moderation' AND after_data->>'status'='draft')) LIMIT 1`,
            [before.id],
            sql,
          )
        )[0];
      if (withdrawal)
        throw new ConflictException(
          'Previously withdrawn listing requires manual publication',
        );
    }
    const offer = input.offer;
    const [changed] = offer
      ? await this.db.rows<Listing>(
          `UPDATE listings SET title=$2,price=$3,description=$4,deal_type=$5 WHERE id=$1
       AND (title,price,description,deal_type) IS DISTINCT FROM ($2::text,$3::numeric,$4::text,$5::text) RETURNING *`,
          [
            before.id,
            offer.title,
            offer.price,
            offer.description,
            offer.dealType,
          ],
          sql,
        )
      : [];
    if (before.status === 'published' && !changed && !input.mediaChanged)
      return 'unchanged';
    await this.publish(sql, before, changed ?? before, seller, {
      kind: 'feed',
      actorId: input.actorId,
      feedId: input.feedId,
      runId: input.runId,
    });
    return before.status === 'published' ? 'updated' : 'published';
  }

  private async publish(
    sql: Sql,
    before: Listing,
    proposed: Listing,
    seller: PublicationSeller,
    origin: PublicationOrigin,
  ) {
    await this.listings.validate(
      sql,
      proposed,
      { ...seller, session_id: '' },
      origin.kind === 'feed' ? 1 : 5,
    );
    await this.trust.checkPublication(sql, before.id);
    const [clock] = await this.db.rows<{ at: Date }>(
      'SELECT clock_timestamp() AS at',
      [],
      sql,
    );
    const at = clock!.at;
    await this.quotas.assertCapacity(sql, seller, before.id, at);
    const alreadyPublic = before.status === 'published';
    const previous = alreadyPublic
      ? null
      : await readLastPublicPriceSnapshot(sql, before.id);
    await sql.query(
      `UPDATE listings SET status='published',version=version+1,
      published_at=CASE WHEN status='published' THEN published_at ELSE $2 END,updated_at=now() WHERE id=$1`,
      [before.id, at],
    );
    const snapshot = await this.listings.publicPriceSnapshot(
      before.id,
      sql,
      at,
    );
    if (origin.kind === 'feed' && !snapshot)
      throw new ForbiddenException('Listing is no longer public');
    if (snapshot) {
      await enqueueImmediateListingNotifications(sql, {
        listingId: before.id,
        version: snapshot.listingVersion,
        publicBefore: alreadyPublic,
        publicAfter: true,
        previousPrice: alreadyPublic ? before.price! : '',
        lastPublicPrice: previous?.price ?? null,
        price: snapshot.price,
      });
    }
    const event =
      origin.kind === 'moderation'
        ? 'moderation.decided'
        : alreadyPublic
          ? 'professional.feed.publication_updated'
          : 'professional.feed.published';
    await this.audit.history(
      sql,
      origin.actorId,
      before.id,
      event,
      origin.kind === 'moderation'
        ? { status: before.status }
        : {
            status: before.status,
            price: before.price,
            version: before.version,
          },
      {
        status: 'published',
        ...(origin.kind === 'moderation'
          ? { caseId: origin.caseId, reason: origin.reason }
          : { feedId: origin.feedId, runId: origin.runId }),
        ...(snapshot ? { publicPriceSnapshot: snapshot } : {}),
      },
      at,
    );
  }
}

@Module({
  imports: [
    ListingsModule,
    TrustModule,
    PublicationQuotaModule,
    OrganizationsModule,
  ],
  providers: [ListingPublications],
  exports: [ListingPublications],
})
export class ListingPublicationModule {}
