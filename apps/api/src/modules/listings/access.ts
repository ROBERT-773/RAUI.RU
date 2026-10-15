import {
  visibilityTokenSchema,
  type VisibilitySnapshot,
} from '../product/subscription-visibility';
import type { ListingStatus, DealType } from '@raui/types/core';
import {
  Injectable,
  Module,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Actor, parse, uuid } from '../../common/security';
import { Database, Sql } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
export type ListingState = ListingStatus;
export interface Listing {
  id: string;
  property_id: string;
  source_id: string;
  seller_id: string;
  organization_id: string | null;
  status: ListingState;
  price: string | null;
  title: string;
  deal_type: DealType;
  version: number;
  description: string;
}
// One authoritative predicate for public data and neutral visibility snapshots.
const publicEligibility = `l.status='published' AND u.active AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL AND u.role IN ('owner','agent','agency','developer','admin') AND (l.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=l.organization_id AND o.active AND m.user_id=l.seller_id AND m.active))`;
export async function readListingVisibility(
  sql: Sql,
  listingId: string,
): Promise<VisibilitySnapshot | null> {
  const [row] = (
    await sql.query(
      `SELECT l.version,(${publicEligibility}) AS visible,
   jsonb_build_object('seller',jsonb_build_object('id',u.id,'generation',gs.generation::text),
    'organization',CASE WHEN l.organization_id IS NULL THEN NULL ELSE jsonb_build_object('id',l.organization_id,'generation',go.generation::text) END,
    'membership',CASE WHEN l.organization_id IS NULL THEN NULL ELSE jsonb_build_object('organizationId',l.organization_id,'userId',l.seller_id,'generation',gm.generation::text) END) AS token
   FROM listings l JOIN users u ON u.id=l.seller_id
   LEFT JOIN subscription_visibility_generations gs ON gs.kind='seller' AND gs.identity=u.id::text
   LEFT JOIN subscription_visibility_generations go ON go.kind='organization' AND go.identity=l.organization_id::text
   LEFT JOIN subscription_visibility_generations gm ON gm.kind='membership' AND gm.identity=l.organization_id::text||':'||l.seller_id::text
   WHERE l.id=$1`,
      [parse(uuid, listingId)],
    )
  ).rows;
  if (!row) return null;
  const token = visibilityTokenSchema.safeParse(row.token);
  return {
    version: row.version,
    visible: row.visible,
    visibilityToken: token.success ? token.data : null,
  };
}
@Injectable()
export class ListingAccess {
  constructor(
    private readonly db: Database,
    private readonly orgs: Organizations,
  ) {}
  async visible(id: string, sql: Sql = this.db.pool) {
    const [listing] = await this.db.rows<Listing>(
      `SELECT l.* FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1 AND ${publicEligibility}`,
      [parse(uuid, id)],
      sql,
    );
    return listing;
  }
  /** Neutral state and dependency token share exactly one authoritative SQL snapshot. */
  async currentVisibility(id: string, sql: Sql = this.db.pool) {
    return readListingVisibility(sql, parse(uuid, id));
  }
  async get(
    actor: Actor,
    id: string,
    sql: Sql = this.db.pool,
    lock = false,
  ): Promise<Listing> {
    const [row] = await this.db.rows<Listing>(
      `SELECT * FROM listings WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [parse(uuid, id)],
      sql,
    );
    if (!row) throw new NotFoundException();
    if (row.organization_id)
      await this.orgs.permission(actor, row.organization_id, false, sql);
    else if (row.seller_id !== actor.id && actor.role !== 'admin')
      throw new ForbiddenException();
    return row;
  }
}
@Module({
  imports: [OrganizationsModule],
  providers: [ListingAccess],
  exports: [ListingAccess],
})
export class ListingAccessModule {}
