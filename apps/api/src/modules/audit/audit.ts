import { listingPublicEligibility } from '../listings/public-policy';
import { enqueueImmediateListingEmails } from '../product/subscription-outbox';
import { z } from 'zod';
import { Global, Injectable, Module } from '@nestjs/common';
import { Database, Sql } from '../database/database';
@Injectable()
export class Audit {
  constructor(private readonly db: Database) {}
  async record(
    sql: Sql,
    actor: string | null,
    action: string,
    type: string,
    id: string,
    data: unknown = {},
  ) {
    await sql.query(
      'INSERT INTO audit_events(actor_id,action,entity_type,entity_id,data) VALUES($1,$2,$3,$4,$5)',
      [actor, action, type, id, JSON.stringify(data)],
    );
  }
  async history(
    sql: Sql,
    actor: string,
    listing: string,
    event: string,
    before: unknown,
    after: unknown,
    createdAt?: Date,
  ) {
    await sql.query(
      'INSERT INTO listing_history(listing_id,actor_id,event,before_data,after_data,created_at) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()))',
      [
        listing,
        actor,
        event,
        JSON.stringify(before),
        JSON.stringify(after),
        createdAt ?? null,
      ],
    );
    await this.record(sql, actor, event, 'listing', listing, after);
    const shape = z.object({
      status: z.string(),
      price: z.string().nullable(),
      version: z.number().int().positive(),
    });
    const prior = shape.safeParse(before),
      next = shape.safeParse(after);
    if (prior.success && next.success) {
      const [eligible] = await this.db.rows(
        `SELECT 1 FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1 AND ${listingPublicEligibility}`,
        [listing],
        sql,
      );
      if (
        prior.data.status === 'published' &&
        next.data.status === 'published' &&
        (!prior.data.price || !next.data.price)
      )
        return;
      if (eligible)
        await enqueueImmediateListingEmails(sql, {
          listingId: listing,
          version: next.data.version,
          publicBefore: prior.data.status === 'published',
          publicAfter: next.data.status === 'published',
          previousPrice: prior.data.price ?? '0',
          price: next.data.price ?? '0',
        });
    }
  }
}
@Global()
@Module({ providers: [Audit], exports: [Audit] })
export class AuditModule {}
