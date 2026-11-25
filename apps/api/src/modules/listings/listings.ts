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
  Header,
  HttpCode,
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
import { visibleProfessionals } from '../professional/public-profile-visibility';
import { Audit } from '../audit/audit';
import {
  Listing,
  ListingState,
  ListingAccess,
  ListingAccessModule,
} from './access';
import {
  createSchema as propertySchema,
  Properties,
  PropertiesModule,
} from '../properties/properties';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { buildPublicPriceSnapshot } from './public-price-history';
import { Media, MediaModule } from '../media/media';
import {
  ListingContacts,
  ListingContactController,
  publicListingContact,
  lockContactSeller,
  requirePublicationContact,
} from './contact-settings';
import { enqueueImmediateListingNotifications } from '../product/subscription-outbox';
import {
  ListingFormDraftController,
  ListingFormDrafts,
  listingFormReference,
} from './form-drafts';
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
  terms: z
    .record(
      z.string().max(50),
      z.union([z.string().max(1000), z.number(), z.boolean()]),
    )
    .refine(
      (terms) =>
        terms.guestCapacity === undefined ||
        z.number().int().min(1).max(9999).safeParse(terms.guestCapacity)
          .success,
      { path: ['guestCapacity'], message: 'Invalid guest capacity' },
    )
    .refine(
      ({ availableFrom, availableUntil }) =>
        (availableFrom === undefined && availableUntil === undefined) ||
        (typeof availableFrom === 'string' &&
          typeof availableUntil === 'string' &&
          z.iso.date().safeParse(availableFrom).success &&
          z.iso.date().safeParse(availableUntil).success &&
          availableFrom < availableUntil),
      { path: ['availableUntil'], message: 'Invalid availability period' },
    ),
};
const createFields = {
  dealType: z.enum(['sale', 'long_rent', 'short_rent']),
  title: fields.title.default(''),
  price: fields.price.optional(),
  description: fields.description.default(''),
  terms: fields.terms.default({}),
};
export const createListingSchema = z.union([
  z.object({ propertyId: uuid, ...createFields }).strict(),
  z
    .object({
      property: propertySchema,
      ...createFields,
      formDraft: listingFormReference,
    })
    .strict(),
]);

const cabinetListings = `
  SELECT l.* FROM listings l WHERE l.organization_id IS NULL AND l.seller_id=$1
  UNION ALL
  SELECT l.* FROM memberships m
  JOIN organizations o ON o.id=m.organization_id
  JOIN listings l ON l.organization_id=o.id
  WHERE m.user_id=$1 AND m.active AND o.active`;

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
  /** Internal capture at the authoritative public-policy query, in caller's transaction. */
  async publicPriceSnapshot(id: string, sql: Sql, capturedAt: Date) {
    const listing = await this.access.visible(id, sql);
    if (!listing) return null;
    if (listing.price === null)
      throw new Error('Invalid public price snapshot');
    return buildPublicPriceSnapshot({
      price: listing.price,
      currency: 'RUB',
      listingVersion: listing.version,
      capturedAt,
    });
  }
  async create(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(createListingSchema, body);
    return this.idem.run(
      actor,
      'listing.create',
      key,
      input,
      async (sql) => {
        if ('formDraft' in input) {
          const [draft] = await this.db.rows<{
            version: number;
            listing_id: string | null;
          }>(
            'SELECT version,listing_id FROM listing_form_drafts WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [input.formDraft.id, actor.id],
            sql,
          );
          if (!draft)
            throw new NotFoundException('Listing form draft not found');
          if (draft.listing_id || draft.version !== input.formDraft.version)
            throw new ConflictException(
              'Listing form draft is stale or already completed',
            );
        }
        const property =
          'propertyId' in input
            ? await this.properties.access(actor, input.propertyId, sql, true)
            : await this.properties.createWithSql(actor, input.property, sql);
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
        if ('formDraft' in input)
          await sql.query(
            'UPDATE listing_form_drafts SET listing_id=$2,form=NULL,updated_at=now() WHERE id=$1',
            [input.formDraft.id, listing!.id],
          );
        return listing!;
      },
      async (sql) => {
        if ('propertyId' in input)
          await this.properties.access(actor, input.propertyId, sql);
        else if (input.property.organizationId)
          await this.orgs.permission(
            actor,
            input.property.organizationId,
            false,
            sql,
          );
      },
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
    const [contact, media, professionals] = await Promise.all([
      publicListingContact(this.db.pool, id),
      this.media.publicAssets(this.db.pool, id),
      this.db.rows<{
        id: string;
        name: string;
        kind: 'agent' | 'agency';
        imageId: string | null;
      }>(
        `SELECT DISTINCT p.id, p.display_name AS name, p.image_id AS "imageId",
                CASE WHEN p.agent_id IS NULL THEN 'agency' ELSE 'agent' END AS kind
         ${visibleProfessionals}
         AND (p.agent_id = $1 OR p.agency_id = $2)
         ORDER BY kind, p.id`,
        [listing.seller_id, listing.organization_id],
      ),
    ]);
    return {
      id: listing.id,
      title: listing.title,
      price: listing.price,
      dealType: listing.deal_type,
      description: listing.description,
      sellerType: listing.seller_type,
      rentalTerms: publicRentalTerms(listing.deal_type, listing.terms),
      contact,
      professionals,
      property,
      media,
    };
  }
  async mine(actor: Actor, query: unknown) {
    const input = parse(
      z.object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        q: z.string().trim().max(200).optional(),
        deal: z.enum(['sale', 'rent']).optional(),
        status: z
          .enum(Object.keys(transitions) as [ListingState, ...ListingState[]])
          .optional(),
      }),
      query,
    );
    return this.db.rows(
      `SELECT l.*, a.formatted AS address, p.attributes->>'area' AS area, p.attributes->>'floor' AS floor
       FROM (${cabinetListings}) AS l JOIN properties p ON p.id=l.property_id
       JOIN addresses a ON a.id=p.address_id
       WHERE ($2::uuid IS NULL OR l.id>$2)
         AND ($4::text IS NULL OR l.status::text=$4)
         AND ($5::text IS NULL OR ($5='sale' AND l.deal_type='sale') OR ($5='rent' AND l.deal_type IN ('long_rent','short_rent')))
         AND ($6::text IS NULL OR l.id::text=lower($6) OR strpos(lower(l.title),lower($6))>0 OR strpos(lower(a.formatted),lower($6))>0)
       ORDER BY l.id LIMIT $3`,
      [
        actor.id,
        input.after ?? null,
        input.limit,
        input.status ?? null,
        input.deal ?? null,
        input.q || null,
      ],
    );
  }
  async summary(actor: Actor) {
    seller(actor);
    const [counts] = await this.db.rows<{
      total: number;
      sale: number;
      rent: number;
    }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE deal='sale'))::int AS sale,
              (count(*) FILTER (WHERE deal IN ('long_rent','short_rent')))::int AS rent
       FROM (
         SELECT l.deal_type::text AS deal FROM (${cabinetListings}) AS l
         UNION ALL
         SELECT form->>'deal' FROM listing_form_drafts
         WHERE owner_id=$1 AND listing_id IS NULL
       ) AS offers`,
      [actor.id],
    );
    return counts!;
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
  async validate(
    sql: Sql,
    listing: Listing,
    actor: Actor,
    minimumPhotos: 1 | 5 = 5,
  ) {
    if (listing.description.trim().length < 15)
      throw new BadRequestException(
        'Description must contain at least 15 characters',
      );
    const property = await this.properties.access(
      actor,
      listing.property_id,
      sql,
    );
    await this.properties.complete(property, sql);
    if (
      listing.title.trim().length < 3 ||
      !Number.isFinite(Number(listing.price)) ||
      Number(listing.price) <= 0
    )
      throw new BadRequestException('Title and price required for publication');
    await requirePublicationContact(sql, listing);
    await this.media.ready(sql, listing.id, minimumPhotos);
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
        if (input.status === 'moderation') await lockContactSeller(sql, id);
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
        const publicBefore =
          listing.status === 'published'
            ? await this.access.visible(id, sql)
            : null;
        const [updated] = await this.db.rows<Listing>(
          'UPDATE listings SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [id, input.status],
          sql,
        );
        if (publicBefore) {
          await enqueueImmediateListingNotifications(sql, {
            listingId: id,
            version: updated!.version,
            publicBefore: true,
            publicAfter: false,
            previousPrice: '',
            price: '',
          });
        }
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
      `SELECT * FROM (
        SELECT * FROM listing_history WHERE listing_id=$1 ORDER BY id DESC LIMIT 200
      ) AS recent ORDER BY id`,
      [id],
    );
  }
}

export function publicRentalTerms(
  deal: Listing['deal_type'],
  terms: Listing['terms'],
) {
  if (!terms || (deal !== 'long_rent' && deal !== 'short_rent')) return {};
  const deposit = z.number().min(0).max(999999999).safeParse(terms.deposit);
  const result: import('@raui/types/product').PublicRentalTerms = {};
  if (deposit.success) result.deposit = deposit.data;
  if (deal === 'long_rent') {
    const commission = z.number().min(0).max(100).safeParse(terms.commission);
    if (commission.success) result.commission = commission.data;
    if (typeof terms.utilitiesIncluded === 'boolean')
      result.utilitiesIncluded = terms.utilitiesIncluded;
  } else {
    const guests = z
      .number()
      .int()
      .min(1)
      .max(9999)
      .safeParse(terms.guestCapacity);
    const nights = z
      .number()
      .int()
      .min(1)
      .max(365)
      .safeParse(terms.minimumNights);
    if (guests.success) result.guestCapacity = guests.data;
    if (nights.success) result.minimumNights = nights.data;
    const from = z.iso.date().safeParse(terms.availableFrom);
    const until = z.iso.date().safeParse(terms.availableUntil);
    if (from.success && until.success && from.data < until.data) {
      result.availableFrom = from.data;
      result.availableUntil = until.data;
    }
  }
  return result;
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
  @Get('summary') summary(@CurrentActor() actor: Actor) {
    return this.listings.summary(actor);
  }
  @Public()
  @Get(':id/public')
  @Header('Cache-Control', 'private, no-store')
  public(@Param('id') id: string) {
    return this.listings.published(id);
  }
  @Get(':id') get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.listings.privateGet(actor, id);
  }
  @Get(':id/manage')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  async canManage(@CurrentActor() actor: Actor, @Param('id') id: string) {
    seller(actor);
    await this.listings.privateGet(actor, id);
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
  controllers: [
    ListingController,
    ListingFormDraftController,
    ListingContactController,
  ],
  providers: [Listings, ListingFormDrafts, ListingContacts, Idempotency],
  exports: [Listings],
})
export class ListingsModule {}
