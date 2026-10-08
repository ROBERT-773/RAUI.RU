import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import {
  NotificationTransport,
  UnconfiguredNotificationTransport,
} from './delivery';
import { z } from 'zod';
import { Actor, CurrentActor, parse, uuid } from '../../common/security';
import { Database, Sql } from '../database/database';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { Search, SearchModule } from '../search/search';
import { searchSchema } from '../search/contracts';
import {
  PublicationQuotaModule,
  PublicationQuotas,
} from '../listings/publication-quota';
const collection = z.enum(['favorite', 'compare', 'recent']);
const page = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const saved = z
  .object({
    name: z.string().trim().min(1).max(100),
    definition: searchSchema
      .omit({ cursor: true })
      .transform((v) => ({ ...v, cursor: undefined })),
  })
  .strict();
const message = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
@Injectable()
export class Product {
  constructor(
    readonly db: Database,
    readonly access: ListingAccess,
    readonly search: Search,
  ) {}
  async collection(actor: Actor, kind: unknown, body: unknown, remove = false) {
    const k = parse(collection, kind),
      id = parse(z.object({ listingId: uuid }).strict(), body).listingId;
    if (remove) {
      await this.db.rows(
        'DELETE FROM account_listings WHERE user_id=$1 AND kind=$2 AND listing_id=$3',
        [actor.id, k, id],
      );
      return { ok: true };
    }
    if (!(await this.access.visible(id))) throw new NotFoundException();
    await this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        actor.id + k,
      ]);
      if (k === 'compare') {
        const counts = await this.db.rows<{ count: string }>(
          'SELECT count(*) FROM account_listings WHERE user_id=$1 AND kind=$2 AND listing_id<>$3',
          [actor.id, k, id],
          sql,
        );
        if (Number(counts[0]!.count) >= 10)
          throw new BadRequestException('Comparison limit is 10');
      }
      await sql.query(
        'INSERT INTO account_listings(user_id,listing_id,kind) VALUES($1,$2,$3) ON CONFLICT(user_id,listing_id,kind) DO UPDATE SET updated_at=now()',
        [actor.id, id, k],
      );
      if (k === 'recent')
        await sql.query(
          "DELETE FROM account_listings WHERE user_id=$1 AND kind='recent' AND listing_id NOT IN (SELECT listing_id FROM account_listings WHERE user_id=$1 AND kind='recent' ORDER BY updated_at DESC,listing_id LIMIT 100)",
          [actor.id],
        );
    });
    return { ok: true };
  }
  async collections(actor: Actor, kind: unknown, query: unknown) {
    const k = parse(collection, kind);
    const q = parse(
      z.object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      query,
    );
    const ids = await this.db.rows<{ listing_id: string }>(
      'SELECT listing_id FROM account_listings WHERE user_id=$1 AND kind=$2 AND ($3::uuid IS NULL OR listing_id>$3) ORDER BY listing_id LIMIT $4',
      [actor.id, k, q.after ?? null, q.limit],
    );
    return {
      items: await this.search.cards(
        await this.search.publicRows(ids.map((r) => r.listing_id)),
      ),
      cursor: ids.length === q.limit ? ids.at(-1)!.listing_id : null,
    };
  }
  async save(actor: Actor, body: unknown, id?: string) {
    const input = parse(saved, body);
    if (input.definition.regionCode)
      this.search.regions.assertConfigured(input.definition.regionCode);
    if (id) {
      const [row] = await this.db.rows(
        'UPDATE saved_searches SET name=$3,definition=$4,version=version+1 WHERE id=$1 AND user_id=$2 RETURNING *',
        [parse(uuid, id), actor.id, input.name, input.definition],
      );
      if (!row) throw new NotFoundException();
      return row;
    }
    return (
      await this.db.rows(
        'INSERT INTO saved_searches(user_id,name,definition) VALUES($1,$2,$3) RETURNING *',
        [actor.id, input.name, input.definition],
      )
    )[0];
  }
  async saved(actor: Actor, query: unknown) {
    const q = parse(
      z.object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      query,
    );
    const items = await this.db.rows(
      'SELECT * FROM saved_searches WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [actor.id, q.after ?? null, q.limit],
    );
    return {
      items,
      cursor: items.length === q.limit ? items.at(-1)!.id : null,
    };
  }
  async deleteSaved(actor: Actor, id: string) {
    const rows = await this.db.rows(
      'DELETE FROM saved_searches WHERE user_id=$1 AND id=$2 RETURNING id',
      [actor.id, parse(uuid, id)],
    );
    if (!rows.length) throw new NotFoundException();
    return { ok: true };
  }
  async thread(actor: Actor, id: string, sql: Sql = this.db.pool) {
    const [row] = await this.db.rows<{
      id: string;
      buyer_id: string;
      seller_id: string;
      listing_id: string;
    }>(
      'SELECT * FROM inquiry_threads WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2)',
      [parse(uuid, id), actor.id],
      sql,
    );
    if (!row) throw new NotFoundException();
    return row;
  }
  async send(actor: Actor, id: string, body: unknown, sql: Sql) {
    const input = parse(message, body);
    const thread = await this.thread(actor, id, sql);
    const recipient =
      thread.buyer_id === actor.id ? thread.seller_id : thread.buyer_id;
    const [row] = await this.db.rows(
      'INSERT INTO inquiry_messages(thread_id,sender_id,body) VALUES($1,$2,$3) RETURNING *',
      [id, actor.id, input.body],
      sql,
    );
    const prefs = (
      await this.db.rows<{
        in_app: boolean;
        email: boolean;
        sms: boolean;
        push: boolean;
      }>(
        'SELECT * FROM notification_preferences WHERE user_id=$1',
        [recipient],
        sql,
      )
    )[0] ?? { in_app: true, email: false, sms: false, push: false };
    if (prefs.in_app || prefs.email || prefs.sms || prefs.push) {
      const [n] = await this.db.rows(
        "INSERT INTO notifications(user_id,thread_id,kind) VALUES($1,$2,'message') RETURNING id",
        [recipient, id],
        sql,
      );
      for (const channel of ['email', 'sms', 'push'] as const)
        if (prefs[channel])
          await sql.query(
            'INSERT INTO notification_outbox(notification_id,channel) VALUES($1,$2)',
            [n!.id, channel],
          );
    }
    return row;
  }
  async reply(actor: Actor, id: string, body: unknown) {
    return this.db.transaction((sql) => this.send(actor, id, body, sql));
  }
  async inquire(actor: Actor, listingId: string, body: unknown) {
    parse(message, body);
    return this.db.transaction(async (sql) => {
      const listing = await this.access.visible(parse(uuid, listingId), sql);
      if (!listing) throw new NotFoundException();
      if (listing.seller_id === actor.id)
        throw new ForbiddenException('Cannot inquire about own listing');
      const [thread] = await this.db.rows<{ id: string }>(
        'INSERT INTO inquiry_threads(listing_id,buyer_id,seller_id) VALUES($1,$2,$3) ON CONFLICT(listing_id,buyer_id) DO UPDATE SET listing_id=EXCLUDED.listing_id RETURNING id',
        [listingId, actor.id, listing.seller_id],
        sql,
      );
      return {
        threadId: thread!.id,
        message: await this.send(actor, thread!.id, body, sql),
      };
    });
  }
  async threads(actor: Actor, query: unknown) {
    const q = parse(
      z.object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      query,
    );
    const items = await this.db.rows(
      'SELECT t.id,t.listing_id,t.created_at FROM inquiry_threads t WHERE (buyer_id=$1 OR seller_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
      [actor.id, q.after ?? null, q.limit],
    );
    return {
      items,
      cursor: items.length === q.limit ? items.at(-1)!.id : null,
    };
  }
  async messages(actor: Actor, id: string, query: unknown) {
    await this.thread(actor, id);
    const q = parse(page, query);
    const items = await this.db.rows(
      'SELECT id,sender_id,body,created_at FROM inquiry_messages WHERE thread_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',
      [id, q.cursor ?? null, q.limit],
    );
    return {
      items,
      cursor: items.length === q.limit ? items.at(-1)!.id : null,
    };
  }
  async notifications(actor: Actor, query: unknown) {
    const q = parse(page, query);
    const items = await this.db.rows(
      'SELECT id,thread_id,kind,read_at,created_at FROM notifications WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',
      [actor.id, q.cursor ?? null, q.limit],
    );
    return {
      items,
      cursor: items.length === q.limit ? items.at(-1)!.id : null,
    };
  }
  async read(actor: Actor, id: string) {
    const [row] = await this.db.rows(
      'UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND id=$2 RETURNING id',
      [actor.id, parse(z.coerce.number().int().positive(), id)],
    );
    if (!row) throw new NotFoundException();
    return { ok: true };
  }
  async preferences(actor: Actor, body?: unknown) {
    if (body === undefined)
      return (
        (
          await this.db.rows(
            'SELECT in_app,email,sms,push FROM notification_preferences WHERE user_id=$1',
            [actor.id],
          )
        )[0] ?? { in_app: true, email: false, sms: false, push: false }
      );
    const p = parse(
      z
        .object({
          in_app: z.boolean(),
          email: z.boolean(),
          sms: z.boolean(),
          push: z.boolean(),
        })
        .strict(),
      body,
    );
    return (
      await this.db.rows(
        'INSERT INTO notification_preferences(user_id,in_app,email,sms,push) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET in_app=$2,email=$3,sms=$4,push=$5 RETURNING in_app,email,sms,push',
        [actor.id, p.in_app, p.email, p.sms, p.push],
      )
    )[0];
  }
}
@Controller('v1/account')
export class ProductController {
  constructor(
    readonly product: Product,
    readonly quotas: PublicationQuotas,
  ) {}
  @Get('publication-quota') publicationQuota(@CurrentActor() actor: Actor) {
    return this.quotas.own(actor);
  }
  @Get('collections/:kind') collections(
    @CurrentActor() a: Actor,
    @Param('kind') k: string,
    @Query() q: unknown,
  ) {
    return this.product.collections(a, k, q);
  }
  @Post('collections/:kind') collection(
    @CurrentActor() a: Actor,
    @Param('kind') k: string,
    @Body() b: unknown,
  ) {
    return this.product.collection(a, k, b);
  }
  @Delete('collections/:kind/:id') remove(
    @CurrentActor() a: Actor,
    @Param('kind') k: string,
    @Param('id') id: string,
  ) {
    return this.product.collection(a, k, { listingId: id }, true);
  }
  @Get('saved-searches') saved(@CurrentActor() a: Actor, @Query() q: unknown) {
    return this.product.saved(a, q);
  }
  @Post('saved-searches') save(@CurrentActor() a: Actor, @Body() b: unknown) {
    return this.product.save(a, b);
  }
  @Patch('saved-searches/:id') update(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.product.save(a, b, id);
  }
  @Delete('saved-searches/:id') deleteSaved(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
  ) {
    return this.product.deleteSaved(a, id);
  }
  @Post('inquiries/:id') inquiry(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.product.inquire(a, id, b);
  }
  @Get('threads') threads(@CurrentActor() a: Actor, @Query() q: unknown) {
    return this.product.threads(a, q);
  }
  @Get('threads/:id/messages') messages(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.product.messages(a, id, q);
  }
  @Post('threads/:id/messages') send(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.product.reply(a, id, b);
  }
  @Get('notifications') notifications(
    @CurrentActor() a: Actor,
    @Query() q: unknown,
  ) {
    return this.product.notifications(a, q);
  }
  @Post('notifications/:id/read') read(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
  ) {
    return this.product.read(a, id);
  }
  @Get('preferences') preferences(@CurrentActor() a: Actor) {
    return this.product.preferences(a);
  }
  @Patch('preferences') prefs(@CurrentActor() a: Actor, @Body() b: unknown) {
    return this.product.preferences(a, b);
  }
}
@Module({
  imports: [ListingAccessModule, SearchModule, PublicationQuotaModule],
  controllers: [ProductController],
  providers: [
    Product,
    {
      provide: NotificationTransport,
      useClass: UnconfiguredNotificationTransport,
    },
  ],
  exports: [Product],
})
export class ProductModule {}
