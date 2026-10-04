import {
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Headers,
  Query,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  Public,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import {
  Listing,
  ListingState,
  ListingAccess,
  ListingAccessModule,
} from './access';
import { Properties, PropertiesModule } from '../properties/properties';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { Media, MediaModule } from '../media/media';
export const transitions: Record<ListingState, ListingState[]> = {
  draft: ['processing'],
  processing: ['draft', 'moderation'],
  moderation: ['draft'],
  published: ['paused', 'archived', 'sold', 'rented'],
  paused: ['processing', 'archived', 'sold', 'rented'],
  archived: [],
  sold: [],
  rented: [],
  rejected: ['draft', 'processing'],
};
export function assertTransition(
  from: ListingState,
  to: ListingState,
  deal: string,
) {
  if (!transitions[from].includes(to))
    throw new ConflictException('Invalid listing transition');
  if (
    (to === 'sold' && deal !== 'sale') ||
    (to === 'rented' && deal === 'sale')
  )
    throw new BadRequestException('Deal/status mismatch');
}
export const fields = {
  title: z.string().trim().max(200),
  price: z.number().positive().max(99_999_999_999_999).multipleOf(0.01),
  description: z.string().max(10000),
  terms: z.record(
    z.string().max(50),
    z.union([z.string().max(1000), z.number(), z.boolean()]),
  ),
};
@Injectable()
export class Listings {
  constructor(
    private readonly db: Database,
    private readonly access: ListingAccess,
    private readonly properties: Properties,
    private readonly orgs: Organizations,
    private readonly media: Media,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async create(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(
      z
        .object({
          propertyId: uuid,
          dealType: z.enum(['sale', 'long_rent', 'short_rent']),
          title: fields.title.default(''),
          price: fields.price.optional(),
          description: fields.description.default(''),
          terms: fields.terms.default({}),
        })
        .strict(),
      body,
    );
    return this.idem.run(
      actor,
      'listing.create',
      key,
      input,
      async (sql) => {
        const property = await this.properties.access(
          actor,
          input.propertyId,
          sql,
          true,
        );
        let kind = 'direct';
        if (property.organization_id)
          kind = (
            await this.orgs.permission(
              actor,
              property.organization_id,
              false,
              sql,
            )
          ).kind;
        const [source] = await this.db.rows<{ id: string }>(
          'INSERT INTO listing_sources(kind,organization_id,metadata) VALUES($1,$2,$3) RETURNING id',
          [
            kind,
            property.organization_id,
            JSON.stringify({ createdBy: actor.id }),
          ],
          sql,
        );
        const [listing] = await this.db.rows<Listing>(
          'INSERT INTO listings(property_id,source_id,seller_id,organization_id,deal_type,title,price,description,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            property.id,
            source!.id,
            actor.id,
            property.organization_id,
            input.dealType,
            input.title,
            input.price ?? null,
            input.description,
            JSON.stringify(input.terms),
          ],
          sql,
        );
        await this.audit.history(
          sql,
          actor.id,
          listing!.id,
          'listing.created',
          {},
          listing!,
        );
        return listing!;
      },
      (sql) => this.properties.access(actor, input.propertyId, sql),
    );
  }
  async privateGet(actor: Actor, id: string) {
    return this.access.get(actor, id);
  }
  async published(id: string) {
    const listing = await this.access.visible(id);
    if (!listing) throw new NotFoundException();
    const [property] = await this.db.rows(
      'SELECT p.id,p.category_code,p.attributes,a.formatted,a.locality,ST_X(a.point) AS longitude,ST_Y(a.point) AS latitude FROM properties p JOIN addresses a ON a.id=p.address_id WHERE p.id=$1',
      [listing.property_id],
    );
    const media = await this.media.publicAssets(this.db.pool, id);
    return {
      id: listing.id,
      title: listing.title,
      price: listing.price,
      dealType: listing.deal_type,
      description: listing.description,
      property,
      media,
    };
  }
  async mine(actor: Actor, query: unknown) {
    const input = parse(
      z.object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      query,
    );
    return this.db.rows(
      `SELECT l.* FROM listings l WHERE (l.organization_id IS NULL AND l.seller_id=$1 OR l.organization_id IN (SELECT m.organization_id FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.active AND o.active)) AND ($2::uuid IS NULL OR l.id>$2) ORDER BY l.id LIMIT $3`,
      [actor.id, input.after ?? null, input.limit],
    );
  }
  async patch(actor: Actor, id: string, body: unknown) {
    seller(actor);
    const input = parse(
      z
        .object({
          version: z.number().int().positive(),
          title: fields.title.optional(),
          price: fields.price.optional(),
          description: fields.description.optional(),
          terms: fields.terms.optional(),
        })
        .strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      const listing = await this.access.get(actor, id, sql, true);
      if (listing.version !== input.version)
        throw new ConflictException('Stale listing version');
      if (!['draft', 'paused', 'rejected'].includes(listing.status))
        throw new ConflictException('Pause active listing before editing');
      const [updated] = await this.db.rows<Listing>(
        `UPDATE listings SET title=COALESCE($2,title),price=COALESCE($3,price),description=COALESCE($4,description),terms=COALESCE($5,terms),status='draft',version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          id,
          input.title ?? null,
          input.price ?? null,
          input.description ?? null,
          input.terms ? JSON.stringify(input.terms) : null,
        ],
        sql,
      );
      await this.audit.history(
        sql,
        actor.id,
        id,
        'listing.fields.changed',
        listing,
        updated!,
      );
      return updated!;
    });
  }
  async validate(sql: Sql, listing: Listing, actor: Actor) {
    const property = await this.properties.access(
      actor,
      listing.property_id,
      sql,
    );
    await this.properties.complete(property, sql);
    if (
      listing.title.length < 3 ||
      !listing.price ||
      Number(listing.price) <= 0
    )
      throw new BadRequestException('Title and price required for publication');
    await this.media.ready(sql, listing.id);
  }
  async transition(actor: Actor, id: string, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(
      z
        .object({
          version: z.number().int().positive(),
          status: z.enum([
            'draft',
            'processing',
            'moderation',
            'paused',
            'archived',
            'sold',
            'rented',
          ]),
        })
        .strict(),
      body,
    );
    return this.idem.run(
      actor,
      `listing.transition:${id}`,
      key,
      input,
      async (sql) => {
        const before = await this.access.get(actor, id, sql);
        await this.properties.access(actor, before.property_id, sql, true);
        const listing = await this.access.get(actor, id, sql, true);
        if (listing.version !== input.version)
          throw new ConflictException('Stale listing version');
        assertTransition(listing.status, input.status, listing.deal_type);
        if (input.status === 'moderation') {
          await this.validate(sql, listing, actor);
          await sql.query(
            'INSERT INTO moderation_cases(listing_id,listing_version) VALUES($1,$2)',
            [id, listing.version + 1],
          );
        }
        if (listing.status === 'moderation' && input.status === 'draft')
          await sql.query(
            "UPDATE moderation_cases SET state='cancelled',resolved_at=now(),reason='withdrawn' WHERE listing_id=$1 AND state='pending'",
            [id],
          );
        const [updated] = await this.db.rows<Listing>(
          'UPDATE listings SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [id, input.status],
          sql,
        );
        await this.audit.history(
          sql,
          actor.id,
          id,
          'listing.status.changed',
          { status: listing.status, version: listing.version },
          { status: input.status, version: updated!.version },
        );
        return updated!;
      },
      (sql) => this.access.get(actor, id, sql),
    );
  }
  async source(actor: Actor, id: string) {
    const listing = await this.access.get(actor, id);
    const [source] = await this.db.rows(
      'SELECT * FROM listing_sources WHERE id=$1',
      [listing.source_id],
    );
    return source;
  }
  async history(actor: Actor, id: string) {
    await this.access.get(actor, id);
    return this.db.rows(
      'SELECT * FROM listing_history WHERE listing_id=$1 ORDER BY id LIMIT 200',
      [id],
    );
  }
}
@Controller('v1/listings')
export class ListingController {
  constructor(private readonly listings: Listings) {}
  @Post() create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.listings.create(actor, body, key);
  }
  @Get() mine(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.listings.mine(actor, query);
  }
  @Public() @Get(':id/public') public(@Param('id') id: string) {
    return this.listings.published(id);
  }
  @Get(':id') get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.listings.privateGet(actor, id);
  }
  @Patch(':id') patch(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.listings.patch(actor, id, body);
  }
  @Post(':id/transitions') transition(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.listings.transition(actor, parse(uuid, id), body, key);
  }
  @Get(':id/source') source(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.listings.source(actor, id);
  }
  @Get(':id/history') history(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.listings.history(actor, parse(uuid, id));
  }
}
@Module({
  imports: [
    ListingAccessModule,
    PropertiesModule,
    OrganizationsModule,
    MediaModule,
  ],
  controllers: [ListingController],
  providers: [Listings, Idempotency],
  exports: [Listings],
})
export class ListingsModule {}
