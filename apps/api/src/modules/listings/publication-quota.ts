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
  monthlyLimit: number | null;
  monthlyPublications: number | null;
  monthlyRemaining: number | null;
  monthlyResetAt: string | null;
};
export type PublicationSeller = Pick<
  Actor,
  'id' | 'role' | 'email_verified_at' | 'phone_verified_at'
> & {
  active: boolean;
  registration_approval_state: 'pending' | 'approved' | 'rejected';
};
const limit = 1;

@Injectable()
export class PublicationQuotas {
  constructor(private readonly db: Database) {}

  async own(actor: Actor): Promise<PublicationQuota> {
    // Account eligibility and the informational count share one fresh snapshot.
    const [current] = await this.db.rows<
      PublicationSeller & {
        published_objects: string | null;
        monthly_publications: string;
        monthly_reset_at: Date;
      }
    >(
      `SELECT u.id,u.role,u.active,u.registration_approval_state,
        CASE WHEN u.role='owner' THEN
          (SELECT COUNT(*) FROM listings l
           WHERE l.seller_id=u.id AND l.status='published')
        ELSE NULL END AS published_objects
        , (SELECT COUNT(*) FROM listing_history h JOIN listings historical ON historical.id=h.listing_id
          WHERE historical.seller_id=u.id AND h.after_data->>'status'='published'
          AND h.before_data->>'status' IS DISTINCT FROM 'published'
          AND h.created_at >= (date_trunc('month',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')
          AND h.created_at < ((date_trunc('month',now() AT TIME ZONE 'Europe/Moscow') + interval '1 month') AT TIME ZONE 'Europe/Moscow')) AS monthly_publications,
          ((date_trunc('month',now() AT TIME ZONE 'Europe/Moscow') + interval '1 month') AT TIME ZONE 'Europe/Moscow') AS monthly_reset_at
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
        monthlyLimit: null,
        monthlyPublications: null,
        monthlyRemaining: null,
        monthlyResetAt: null,
      };
    const publishedObjects = Number(current.published_objects);
    return {
      applies: true,
      limit,
      publishedObjects,
      remaining: Math.max(0, limit - publishedObjects),
      monthlyLimit: 3,
      monthlyPublications: Number(current.monthly_publications),
      monthlyRemaining: Math.max(0, 3 - Number(current.monthly_publications)),
      monthlyResetAt: current.monthly_reset_at.toISOString(),
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
    listingId: string,
    decisionAt: Date,
  ): Promise<void> {
    if (current.role !== 'owner') return;
    const [count] = await this.db.rows<{
      published_objects: string;
      already_published: boolean;
      monthly_publications: string;
    }>(
      `SELECT COUNT(*) AS published_objects,
        COALESCE(bool_or(id=$2::uuid),false) AS already_published,
        (SELECT COUNT(*) FROM listing_history h
         JOIN listings historical ON historical.id=h.listing_id
         WHERE historical.seller_id=$1
           AND h.after_data->>'status'='published'
           AND h.before_data->>'status' IS DISTINCT FROM 'published'
           AND h.created_at >= (date_trunc('month',$3::timestamptz AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')
           AND h.created_at < (date_trunc('month',$3::timestamptz AT TIME ZONE 'Europe/Moscow') + interval '1 month') AT TIME ZONE 'Europe/Moscow'
        ) AS monthly_publications
       FROM listings WHERE seller_id=$1 AND status='published'`,
      [current.id, listingId, decisionAt],
      sql,
    );
    if (count!.already_published) return;
    if (Number(count!.published_objects) >= limit)
      throw new ConflictException({
        statusCode: 409,
        code: 'OWNER_PUBLICATION_QUOTA_EXCEEDED',
        message:
          'Разрешено одно активное объявление. Приостановите действующее объявление перед новой публикацией.',
      });
    if (Number(count!.monthly_publications) >= 3)
      throw new ConflictException({
        statusCode: 409,
        code: 'OWNER_MONTHLY_PUBLICATION_QUOTA_EXCEEDED',
        message: 'Достигнут лимит: три публикации в календарный месяц.',
      });
  }
}

@Module({ providers: [PublicationQuotas], exports: [PublicationQuotas] })
export class PublicationQuotaModule {}
