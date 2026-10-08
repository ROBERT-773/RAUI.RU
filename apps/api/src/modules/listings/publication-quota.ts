import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { Actor, seller } from '../../common/security';
import { Database, Sql } from '../database/database';

export type PublicationQuota = {
  applies: boolean;
  limit: number | null;
  publishedObjects: number | null;
  remaining: number | null;
};
export type PublicationSeller = Pick<
  Actor,
  'id' | 'role' | 'email_verified_at' | 'phone_verified_at'
> & {
  active: boolean;
  registration_approval_state: 'pending' | 'approved' | 'rejected';
};
const limit = 6;

@Injectable()
export class PublicationQuotas {
  constructor(private readonly db: Database) {}

  async own(actor: Actor): Promise<PublicationQuota> {
    // Account eligibility and the informational count share one fresh snapshot.
    const [current] = await this.db.rows<
      PublicationSeller & { published_objects: string | null }
    >(
      `SELECT u.id,u.role,u.active,u.registration_approval_state,
        CASE WHEN u.role='owner' THEN
          (SELECT COUNT(DISTINCT l.property_id) FROM listings l
           WHERE l.seller_id=u.id AND l.status='published')
        ELSE NULL END AS published_objects
       FROM users u WHERE u.id=$1`,
      [actor.id],
    );
    if (!current?.active) throw new UnauthorizedException();
    if (current.registration_approval_state !== 'approved')
      throw new ForbiddenException('Approved registration required');
    if (current.role !== 'owner')
      return {
        applies: false,
        limit: null,
        publishedObjects: null,
        remaining: null,
      };
    const publishedObjects = Number(current.published_objects);
    return {
      applies: true,
      limit,
      publishedObjects,
      remaining: Math.max(0, limit - publishedObjects),
    };
  }

  async lockSeller(sql: Sql, sellerId: string): Promise<PublicationSeller> {
    // Acquire before any property/listing/case locks. NO KEY UPDATE remains
    // compatible with audit/history/idempotency foreign-key KEY SHARE locks.
    const [current] = await this.db.rows<PublicationSeller>(
      `SELECT id,role,active,email_verified_at,phone_verified_at,registration_approval_state
       FROM users WHERE id=$1 FOR NO KEY UPDATE`,
      [sellerId],
      sql,
    );
    if (!current?.active) throw new ConflictException('Seller inactive');
    if (current.registration_approval_state !== 'approved')
      throw new ForbiddenException('Approved registration required');
    seller({ ...current, session_id: '' });
    return current;
  }

  async assertCapacity(
    sql: Sql,
    current: PublicationSeller,
    propertyId: string,
  ): Promise<void> {
    if (current.role !== 'owner') return;
    const [count] = await this.db.rows<{
      published_objects: string;
      already_published: boolean;
    }>(
      `SELECT COUNT(DISTINCT property_id) AS published_objects,
        COALESCE(bool_or(property_id=$2::uuid),false) AS already_published
       FROM listings WHERE seller_id=$1 AND status='published'`,
      [current.id, propertyId],
      sql,
    );
    if (count!.already_published || Number(count!.published_objects) < limit)
      return;
    throw new ConflictException({
      statusCode: 409,
      code: 'OWNER_PUBLICATION_QUOTA_EXCEEDED',
      message:
        'Достигнут лимит: 6 объектов одновременно. Чтобы освободить место, приостановите все опубликованные объявления одного объекта. После освобождения места сотрудник может повторить одобрение текущей заявки.',
    });
  }
}

@Module({ providers: [PublicationQuotas], exports: [PublicationQuotas] })
export class PublicationQuotaModule {}
