import {
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  parse,
  uuid,
  verified,
} from '../../common/security';
import { Database } from '../database/database';
import { ListingAccess, ListingAccessModule } from '../listings/access';
export const analyticsEvent = z
  .object({
    schemaVersion: z.literal(1),
    eventId: uuid,
    listingId: uuid,
    kind: z.enum(['view', 'contact_reveal']),
  })
  .strict();
export const marketQuery = z
  .object({
    category: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    locality: z.string().trim().min(1).max(150).optional(),
    dealType: z.enum(['sale', 'long_rent', 'short_rent']).optional(),
  })
  .strict();
@Injectable()
export class Analytics {
  constructor(
    readonly db: Database,
    readonly access: ListingAccess,
  ) {}
  async record(actor: Actor, body: unknown) {
    verified(actor);
    const input = parse(analyticsEvent, body);
    return this.db.transaction(async (sql) => {
      const listing = await this.access.visible(input.listingId, sql);
      if (!listing) {
        const { NotFoundException } = await import('@nestjs/common');
        throw new NotFoundException();
      }
      await sql.query(
        'INSERT INTO analytics_daily_keys(day) VALUES(CURRENT_DATE) ON CONFLICT DO NOTHING',
      );
      const [pseudonym] = await this.db.rows<{ hash: string }>(
        "SELECT encode(hmac($1,secret,'sha256'),'hex') AS hash FROM analytics_daily_keys WHERE day=CURRENT_DATE",
        [actor.id],
        sql,
      );
      // Serialize the global event identity even when the daily pseudonym rotates.
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'analytics:' + input.eventId,
      ]);
      const [prior] = await this.db.rows<{
        listing_id: string;
        kind: string;
        actor_matches: boolean;
      }>(
        "SELECT e.listing_id,e.kind,e.actor_hash=encode(hmac($2,k.secret,'sha256'),'hex') AS actor_matches FROM analytics_events e JOIN analytics_daily_keys k ON k.day=e.day WHERE e.event_key=$1",
        [input.eventId, actor.id],
        sql,
      );
      if (prior) {
        if (
          !prior.actor_matches ||
          prior.listing_id !== input.listingId ||
          prior.kind !== input.kind
        )
          throw new ConflictException('Analytics event identity reused');
        return { accepted: true, schemaVersion: 1 };
      }
      await sql.query(
        `INSERT INTO analytics_events(schema_version,event_key,listing_id,actor_hash,kind,promoted) VALUES(1,$1,$2,$3,$4,EXISTS(SELECT 1 FROM commerce_promotion_activations WHERE listing_id=$2 AND status='active' AND starts_at<=now() AND ends_at>now()) AND EXISTS(SELECT 1 FROM commerce_feature_flags WHERE code='promotions' AND enabled)) ON CONFLICT(event_key) DO NOTHING`,
        [input.eventId, input.listingId, pseudonym!.hash, input.kind],
      );
      return { accepted: true, schemaVersion: 1 };
    });
  }
  async listing(actor: Actor, id: string) {
    verified(actor);
    await this.access.get(actor, id);
    const daily = await this.db.rows(
      `SELECT day,count(*) FILTER(WHERE kind='view')::int AS views,count(DISTINCT actor_hash) FILTER(WHERE kind='view')::int AS unique_views,count(*) FILTER(WHERE kind='contact_reveal')::int AS contact_reveals,count(*) FILTER(WHERE promoted AND kind='view')::int AS promoted_views FROM analytics_events WHERE listing_id=$1 AND day>=CURRENT_DATE-13 GROUP BY day ORDER BY day`,
      [id],
    );
    const [totals] = await this.db.rows(
      `SELECT (SELECT count(*)::int FROM account_listings WHERE listing_id=$1 AND kind='favorite') AS favorites,(SELECT count(*)::int FROM inquiry_threads WHERE listing_id=$1) AS leads,(SELECT count(*)::int FROM inquiry_messages m JOIN inquiry_threads t ON t.id=m.thread_id WHERE t.listing_id=$1 AND m.sender_id=t.buyer_id) AS messages`,
      [id],
    );
    const views = daily.reduce((sum, x) => sum + Number(x.views), 0),
      contacts = daily.reduce((sum, x) => sum + Number(x.contact_reveals), 0);
    return {
      schemaVersion: 1,
      windowDays: 14,
      daily,
      totals: { ...totals, views, contactReveals: contacts },
      contactConversion: views ? contacts / views : null,
      privacy: 'aggregate-only; unique views are daily pseudonyms',
      promotionEffect: 'observational counts; no causal uplift claim',
    };
  }
  async market(actor: Actor, query: unknown = {}) {
    verified(actor);
    const input = parse(marketQuery, query);
    const cohorts = await this.db.rows(
      `SELECT v.category,v.locality,v.deal_type,((count(*)/5)*5)::int AS sample_size_floor,percentile_cont(.25) WITHIN GROUP(ORDER BY v.price_per_m2) AS price_per_m2_p25,percentile_cont(.5) WITHIN GROUP(ORDER BY v.price_per_m2) AS price_per_m2_median,percentile_cont(.75) WITHIN GROUP(ORDER BY v.price_per_m2) AS price_per_m2_p75 FROM public_search_listings v JOIN listings l ON l.id=v.id WHERE v.price_per_m2 IS NOT NULL AND ($1::text IS NULL OR v.category=$1) AND ($2::text IS NULL OR v.locality=$2) AND ($3::text IS NULL OR v.deal_type=$3) GROUP BY v.category,v.locality,v.deal_type HAVING count(*)>=5 AND count(DISTINCT l.seller_id)>=3 ORDER BY v.category,v.locality,v.deal_type LIMIT 100`,
      [input.category ?? null, input.locality ?? null, input.dealType ?? null],
    );
    return {
      schemaVersion: 1,
      minimumOffers: 5,
      minimumSellers: 3,
      cohorts,
      notice:
        'Indicative public asking prices, not completed transactions or professional valuation',
    };
  }
  async prune() {
    await this.db.transaction(async (sql) => {
      await sql.query('DELETE FROM analytics_events WHERE day<CURRENT_DATE-90');
      await sql.query(
        'DELETE FROM analytics_daily_keys WHERE day<CURRENT_DATE-90',
      );
    });
  }
}
@Controller('v1/analytics')
class AnalyticsController {
  constructor(readonly analytics: Analytics) {}
  @Post('events') record(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.analytics.record(actor, body);
  }
  @Get('listings/:id') listing(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.analytics.listing(actor, id);
  }
  @Get('market') market(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.analytics.market(actor, query);
  }
}
@Module({
  imports: [ListingAccessModule],
  providers: [Analytics],
  controllers: [AnalyticsController],
  exports: [Analytics],
})
export class AnalyticsModule {}
