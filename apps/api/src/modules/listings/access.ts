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
@Injectable()
export class ListingAccess {
  constructor(
    private readonly db: Database,
    private readonly orgs: Organizations,
  ) {}
  async visible(id: string, sql: Sql = this.db.pool) {
    const [listing] = await this.db.rows<Listing>(
      `SELECT l.* FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1 AND l.status='published' AND u.active AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL AND u.role IN ('owner','agent','agency','developer','admin') AND (l.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=l.organization_id AND o.active AND m.user_id=l.seller_id AND m.active))`,
      [parse(uuid, id)],
      sql,
    );
    return listing;
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
