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
  monthly: {
    limit: number;
    used: number;
    remaining: number;
    resetsAt: string;
  } | null;
};
export type PublicationSeller = Pick<
  Actor,
  'id' | 'role' | 'email_verified_at' | 'phone_verified_at'
> & {
  active: boolean;
  registration_approval_state: 'pending' | 'approved' | 'rejected';
};
const limit = 1;
const monthlyLimit = 3;

function monthlyUsage(at: 'statement_timestamp()' | '$3::timestamptz') {
  const month = `date_trunc('month', ${at} AT TIME ZONE 'Europe/Moscow')`;
  const resetsAt = `((${month} + interval '1 month') AT TIME ZONE 'Europe/Moscow')`;
  const count = `(SELECT COUNT(*) FROM listing_history h
    JOIN listings historical ON historical.id=h.listing_id
    WHERE historical.seller_id=$1
      AND h.after_data->>'status'='published'
      AND h.before_data->>'status' IS DISTINCT FROM 'published'
      AND h.created_at >= (${month} AT TIME ZONE 'Europe/Moscow')
      AND h.created_at < ${resetsAt})`;
  return { count, resetsAt };
}

@Injectable()
export class PublicationQuotas {
  constructor(private readonly db: Database) {}

  async own(actor: Actor): Promise<PublicationQuota> {
    // Account eligibility and the informational count share one fresh snapshot.
    const month = monthlyUsage('statement_timestamp()');
    const [current] = await this.db.rows<
      PublicationSeller & {
        published_objects: string | null;
        monthly_publications: string | null;
        resets_at: Date;
      }
    >(
      `SELECT u.id,u.role,u.active,u.registration_approval_state,
        CASE WHEN u.role='owner' THEN
          (SELECT COUNT(*) FROM listings l
           WHERE l.seller_id=u.id AND l.status='published')
        ELSE NULL END AS published_objects,
        CASE WHEN u.role='owner' THEN ${month.count} END AS monthly_publications,
        ${month.resetsAt} AS resets_at
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
        monthly: null,
      };
    const publishedObjects = Number(current.published_objects);
    const used = Number(current.monthly_publications);
    return {
      applies: true,
      limit,
      publishedObjects,
      remaining: Math.max(0, limit - publishedObjects),
      monthly: {
        limit: monthlyLimit,
        used,
        remaining: Math.max(0, monthlyLimit - used),
        resetsAt: current.resets_at.toISOString(),
      },
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
        ${monthlyUsage('$3::timestamptz').count} AS monthly_publications
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
    if (Number(count!.monthly_publications) >= monthlyLimit)
      throw new ConflictException({
        statusCode: 409,
        code: 'OWNER_MONTHLY_PUBLICATION_QUOTA_EXCEEDED',
        message: 'Достигнут лимит: три публикации в календарный месяц.',
      });
  }
}

@Module({ providers: [PublicationQuotas], exports: [PublicationQuotas] })
export class PublicationQuotaModule {}
