import type { SearchMapResult } from '@raui/types/product';
import {
  paidPlacementProjection,
  PaidPlacementSignal,
} from '../commerce/placements';
import {
  Body,
  Controller,
  Get,
  Query,
  Injectable,
  Module,
  Post,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Patch,
  Param,
} from '@nestjs/common';
import { z } from 'zod';
import { GeoModule } from '../geo/geo';
import { RegionCatalogue, regionCodeSchema } from '../geo/regions';
import {
  CurrentActor,
  type Actor,
  Public,
  parse,
  hash,
  uuid,
} from '../../common/security';
import { Database } from '../database/database';
import {
  PaidPlacementModule,
  PaidPlacementService,
} from '../commerce/placements';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { visibleProfessionals } from '../professional/public-profile-visibility';
import { SearchIndex, listingMapping } from './index';
import {
  searchSchema,
  indexQuery,
  sortSpec,
  SearchInput,
  attributeFilters,
} from './contracts';
export interface PublicRow {
  id: string;
  title: string;
  description: string;
  price: number;
  price_per_m2: number | null;
  deal_type: string;
  category: string;
  address: string;
  locality: string;
  district: string;
  longitude: number;
  latitude: number;
  attributes: Record<string, unknown>;
  published_at: Date;
  seller_type: string;
  source_type: string;
  [key: string]: unknown;
}
export function documentOf(row: PublicRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    address: row.address,
    category: row.category,
    deal_type: row.deal_type,
    price: row.price,
    price_per_m2: row.price_per_m2,
    area: typeof row.attributes.area === 'number' ? row.attributes.area : null,
    region_code: row.region_code ?? null,
    locality: row.locality,
    district: row.district,
    published_at: row.published_at,
    seller_type: row.seller_type,
    source_type: row.source_type,
    location: { lon: row.longitude, lat: row.latitude },
    attributes: Object.entries(row.attributes)
      .filter(
        ([k, v]) =>
          (attributeFilters as readonly string[]).includes(k) &&
          ['number', 'boolean', 'string'].includes(typeof v),
      )
      .map(([code, v]) => ({
        code,
        [typeof v === 'string' ? 'keyword' : typeof v]: v,
      })),
  };
}

@Injectable()
export class Search {
  constructor(
    readonly db: Database,
    readonly index: SearchIndex,
    readonly paidPlacements: PaidPlacementService,
    readonly regions: RegionCatalogue,
    readonly organizations: Organizations,
  ) {}
  async publicRows(ids?: string[]) {
    return this.db.rows<PublicRow>(
      'SELECT * FROM public_search_listings' +
        (ids ? ' WHERE id=ANY($1::uuid[])' : ''),
      ids ? [ids] : [],
    );
  }
  async ownProfessional(actor: Actor, agencyId?: string) {
    if (agencyId) {
      const permission = await this.organizations.permission(
        actor,
        agencyId,
        true,
      );
      if (permission.kind !== 'agency') throw new ForbiddenException();
    } else if (actor.role !== 'agent') throw new ForbiddenException();
    const ownerColumn = agencyId ? 'agency_id' : 'agent_id';
    const [profile] = await this.db.rows(
      `SELECT p.id, p.display_name AS name, p.published_at IS NOT NULL AS published,
              ARRAY(SELECT r.region_code FROM public_professional_regions r WHERE r.profile_id=p.id ORDER BY r.region_code) AS "regionCodes"
       FROM public_professional_profiles p WHERE p.${ownerColumn}=$1`,
      [agencyId ?? actor.id],
    );
    return { profile: profile ?? null };
  }
  async saveProfessional(actor: Actor, body: unknown, agencyId?: string) {
    if (!agencyId && actor.role !== 'agent') throw new ForbiddenException();
    const ownerColumn = agencyId ? 'agency_id' : 'agent_id';
    const input = parse(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          regionCodes: z.array(regionCodeSchema).max(20),
          published: z.boolean(),
        })
        .strict(),
      body,
    );
    const regions = [...new Set(input.regionCodes)];
    for (const region of regions) this.regions.assertConfigured(region);
    if (input.published && !regions.length)
      throw new BadRequestException('Select at least one work region');
    return this.db.transaction(async (sql) => {
      const {
        rows: [user],
      } = await sql.query(
        `SELECT role, active, registration_approval_state, email_verified_at, phone_verified_at
         FROM users WHERE id=$1 FOR UPDATE`,
        [actor.id],
      );
      if (
        !user?.active ||
        (!agencyId && user.role !== 'agent') ||
        (input.published &&
          (user.registration_approval_state !== 'approved' ||
            !user.email_verified_at ||
            !user.phone_verified_at))
      )
        throw new ForbiddenException();
      if (agencyId) {
        const permission = await this.organizations.permission(
          actor,
          agencyId,
          true,
          sql,
        );
        if (permission.kind !== 'agency') throw new ForbiddenException();
      }
      const {
        rows: [profile],
      } = await sql.query<{ id: string }>(
        `INSERT INTO public_professional_profiles(${ownerColumn},display_name,published_at)
         VALUES ($1,$2,CASE WHEN $3 THEN now() END)
         ON CONFLICT (${ownerColumn}) DO UPDATE SET display_name=EXCLUDED.display_name,
           published_at=EXCLUDED.published_at RETURNING id`,
        [agencyId ?? actor.id, input.name, input.published],
      );
      if (!profile) throw new Error('Profile save returned no row');
      await sql.query(
        'DELETE FROM public_professional_regions WHERE profile_id=$1',
        [profile.id],
      );
      await sql.query(
        'INSERT INTO public_professional_regions SELECT $1, unnest($2::text[])',
        [profile.id, regions],
      );
      return {
        id: profile.id,
        name: input.name,
        regionCodes: regions,
        published: input.published,
      };
    });
  }
  async professionals(query: unknown) {
    const { regionCode, kind, page, q } = parse(
      z.object({
        regionCode: regionCodeSchema,
        kind: z.enum(['agent', 'agency']).optional(),
        q: z.string().trim().max(120).default(''),
        page: z
          .string()
          .regex(/^[1-9][0-9]{0,8}$/)
          .transform(Number)
          .default(1),
      }),
      query,
    );
    this.regions.assertConfigured(regionCode);
    const offset = kind ? (page - 1) * 12 : 0;
    const [directory] = await this.db.rows<{
      items: { id: string; name: string; kind: 'agent' | 'agency' }[];
      counts: { agent: number; agency: number };
    }>(
      `WITH visible AS (
        SELECT p.id, p.display_name AS name,
          CASE WHEN p.agent_id IS NOT NULL THEN 'agent' ELSE 'agency' END AS kind
        ${visibleProfessionals} AND r.region_code = $1
          AND ($5::text = '' OR strpos(lower(p.display_name), lower($5)) > 0)
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY kind ORDER BY name, id) AS position
        FROM visible
      ), page_items AS (
        SELECT id, name, kind, position FROM ranked
        WHERE ($2::text IS NULL OR kind = $2)
          AND position > $3::bigint AND position <= $4::bigint
      )
      SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'kind', kind
              ) ORDER BY kind, position), '[]'::jsonb) FROM page_items) AS items,
             jsonb_build_object(
               'agent', count(*) FILTER (WHERE kind = 'agent'),
               'agency', count(*) FILTER (WHERE kind = 'agency')
             ) AS counts
      FROM visible`,
      [regionCode, kind ?? null, offset, offset + 12, q],
    );
    if (!directory)
      throw new Error('Professional directory query returned no result');
    return {
      ...directory,
      hasMore: !!kind && offset + 12 < directory.counts[kind],
    };
  }
  async professional(
    id: string,
    region: unknown = undefined,
    page: unknown = undefined,
  ) {
    const pageNumber = parse(
      z
        .string()
        .regex(/^[1-9][0-9]{0,8}$/)
        .transform(Number)
        .default(1),
      page,
    );
    const pageSize = 12;
    const regionCode = parse(regionCodeSchema.optional(), region);
    if (regionCode) this.regions.assertConfigured(regionCode);
    const [profile] = await this.db.rows<{
      id: string;
      name: string;
      kind: 'agent' | 'agency';
      regionCodes: string[];
      listings: unknown[];
      listingCount: number;
      listingPageCount: number;
      listingCountsByRegion: Record<string, number>;
    }>(
      `WITH profile AS (
        SELECT p.id, p.agent_id, p.agency_id, p.display_name AS name,
              CASE WHEN p.agent_id IS NULL THEN 'agency' ELSE 'agent' END AS kind,
              array_agg(r.region_code ORDER BY r.region_code) AS "regionCodes"
       ${visibleProfessionals} AND p.id = $1
       GROUP BY p.id, p.display_name, p.agent_id, p.agency_id
       ), scoped_listings AS (
         SELECT v.id, v.title, v.price, v.deal_type, v.address,
                v.attributes, v.published_at, v.region_code
         FROM profile
         JOIN listings l ON (profile.agent_id IS NOT NULL AND l.seller_id = profile.agent_id)
                          OR (profile.agency_id IS NOT NULL AND l.organization_id = profile.agency_id)
         JOIN public_search_listings v ON v.id = l.id
       ), counts AS (
         SELECT region_code, count(*) AS total FROM scoped_listings GROUP BY region_code
       )
       SELECT profile.id, profile.name, profile.kind, profile."regionCodes",
              COALESCE(listings.items, '[]'::jsonb) AS listings,
              (SELECT COALESCE(sum(total), 0)::int FROM counts) AS "listingCount",
              (SELECT ceil(COALESCE(sum(total), 0) / $4::int)::int
                 FROM counts WHERE $2::text IS NULL OR region_code = $2) AS "listingPageCount",
              (SELECT COALESCE(jsonb_object_agg(region_code, total)
                FILTER (WHERE region_code IS NOT NULL), '{}'::jsonb) FROM counts) AS "listingCountsByRegion"
       FROM profile
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(item ORDER BY item.published_at DESC, item.id DESC) AS items
         FROM (
           SELECT public.id, public.title, public.price, public.deal_type,
                  public.address, public.attributes, public.published_at,
                  COALESCE((
                    SELECT jsonb_build_array(jsonb_build_object(
                      'id', m.id, 'url', '/v1/media/' || m.id || '/small'
                    ))
                    FROM media m
                    WHERE m.listing_id = public.id AND m.state = 'ready'
                      AND m.kind = 'photo' AND m.variants ? 'small'
                    ORDER BY m.feed_photo_position NULLS LAST, m.created_at, m.id LIMIT 1
                  ), '[]'::jsonb) AS media
           FROM scoped_listings public
           WHERE ($2::text IS NULL OR public.region_code = $2)
           ORDER BY public.published_at DESC, public.id DESC LIMIT $4::int OFFSET $3::bigint
         ) item
       ) listings ON true`,
      [
        parse(z.uuid(), id),
        regionCode ?? null,
        (pageNumber - 1) * pageSize,
        pageSize,
      ],
    );
    if (!profile) throw new NotFoundException();
    return profile;
  }
  async regionCounts() {
    const rows = await this.db.rows<{ region_code: string; total: string }>(
      'SELECT region_code, count(*) AS total FROM public_search_listings WHERE region_code IS NOT NULL GROUP BY region_code',
    );
    const counts = new Map(
      rows.map((row) => [row.region_code, Number(row.total)]),
    );
    return {
      items: this.regions.list().map(({ code }) => ({
        code,
        count: counts.get(code) ?? 0,
      })),
    };
  }
  async recentWithPhotos() {
    const items = await this.db.rows(
      `SELECT l.id,l.title,l.price,l.deal_type,l.address,l.attributes,
              CASE WHEN char_length(btrim(l.description)) > 160
                THEN left(btrim(l.description),157) || '…'
                ELSE btrim(l.description) END AS summary,
              jsonb_build_array(jsonb_build_object(
                'id',photo.id,'url','/v1/media/' || photo.id || '/small'
              )) AS media
       FROM public_search_listings l
       JOIN LATERAL (
         SELECT m.id FROM media m
         WHERE m.listing_id=l.id AND m.state='ready' AND m.kind='photo'
           AND m.variants ? 'small'
         ORDER BY m.feed_photo_position NULLS LAST,m.created_at,m.id LIMIT 1
       ) photo ON true
       WHERE l.published_at >= now() - interval '14 days'
         AND l.published_at <= now()
         AND btrim(l.description) <> ''
       ORDER BY l.published_at DESC,l.id DESC LIMIT 6`,
    );
    return { items };
  }
  async locations(query: unknown) {
    const input = parse(
      z
        .object({
          kind: z.enum(['city', 'metro']),
          q: z.string().trim().max(100).default(''),
          regionCode: regionCodeSchema.optional(),
          locality: z.string().trim().max(150).optional(),
        })
        .strict(),
      query,
    );
    const column = input.kind === 'city' ? 'locality' : "attributes->>'metro'";
    const rows = await this.db.rows<{ name: string }>(
      `SELECT DISTINCT ${column} AS name FROM public_search_listings
       WHERE ($1::text IS NULL OR region_code=$1)
         AND ($2::text IS NULL OR lower(locality)=lower($2))
         AND ${column} <> '' AND strpos(lower(${column}),lower($3))=1
       ORDER BY name LIMIT 12`,
      [input.regionCode ?? null, input.locality || null, input.q],
    );
    return { items: rows.map(({ name }) => name) };
  }
  // Live filter and geographic revalidation ensures stale derived documents never bypass privacy or current filters.
  async eligible(ids: string[], input: SearchInput) {
    const values: unknown[] = [ids];
    const clauses = ['id=ANY($1::uuid[])'];
    const param = (v: unknown) => {
      values.push(v);
      return '$' + values.length;
    };
    for (const [key, value] of Object.entries({
      category: input.category,
      deal_type: input.dealType,
      region_code: input.regionCode,
      locality: input.locality,
      district: input.district,
      seller_type: input.sellerType,
      source_type: input.sourceType,
    }))
      if (value !== undefined) clauses.push(key + '=' + param(value));
    for (const [key, r] of Object.entries({
      price: input.price,
      price_per_m2: input.pricePerM2,
    }))
      if (r) {
        if (r.min !== undefined) clauses.push(key + '>=' + param(r.min));
        if (r.max !== undefined) clauses.push(key + '<=' + param(r.max));
      }
    if (input.publishedAfter)
      clauses.push('published_at>=' + param(input.publishedAfter));
    for (const [key, value] of Object.entries(input.attributes)) {
      const field = 'attributes->>' + param(key);
      if (typeof value === 'object') {
        const numeric =
          'CASE WHEN (' +
          field +
          ") ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (" +
          field +
          ')::float8 END';
        if (value.min !== undefined)
          clauses.push(numeric + '>=' + param(value.min));
        if (value.max !== undefined)
          clauses.push(numeric + '<=' + param(value.max));
      } else clauses.push('(' + field + ')=' + param(String(value)));
    }
    if (input.bounds)
      clauses.push(
        'ST_Intersects(point,ST_MakeEnvelope(' +
          input.bounds.map(param).join(',') +
          ',4326))',
      );
    if (input.polygon) {
      const geo = JSON.stringify({
        type: 'Polygon',
        coordinates: [input.polygon],
      });
      clauses.push(
        'ST_Intersects(point,ST_SetSRID(ST_GeomFromGeoJSON(' +
          param(geo) +
          '),4326))',
      );
    }
    return this.db.rows<PublicRow>(
      'SELECT * FROM public_search_listings WHERE ' + clauses.join(' AND '),
      values,
    );
  }
  async cards(rows: PublicRow[]) {
    // Organic ordering is resolved before paid placement metadata is attached.
    const assets = rows.length
      ? await this.db.rows<{
          listing_id: string;
          id: string | null;
          paidPlacement: PaidPlacementSignal | null;
          variants: Record<string, unknown>;
        }>(
          `SELECT candidate.listing_id,m.id,m.variants,${paidPlacementProjection} AS "paidPlacement" FROM unnest($1::uuid[]) AS candidate(listing_id) LEFT JOIN LATERAL (SELECT id,variants FROM media WHERE listing_id=candidate.listing_id AND state='ready' AND variants ? 'small' ORDER BY (kind='photo') DESC,feed_photo_position NULLS LAST,created_at,id LIMIT 1) m ON true`,
          [rows.map((r) => r.id)],
        )
      : [];
    const organic = rows.map((source) => {
      const row = { ...source };
      delete row.point;
      return {
        ...row,
        media: assets
          .filter((a) => a.listing_id === row.id && a.id !== null)
          .slice(0, 1)
          .map((a) => ({ id: a.id, url: '/v1/media/' + a.id + '/small' })),
      };
    });
    return this.paidPlacements.attach(
      organic,
      assets.flatMap((asset) =>
        asset.paidPlacement ? [asset.paidPlacement] : [],
      ),
    );
  }
  async validatePolygon(input: SearchInput) {
    if (input.regionCode) this.regions.assertConfigured(input.regionCode);
    if (input.polygon) {
      const [row] = await this.db.rows<{ valid: boolean }>(
        'SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1),4326)) AS valid',
        [JSON.stringify({ type: 'Polygon', coordinates: [input.polygon] })],
      );
      if (!row?.valid) throw new BadRequestException('Invalid polygon');
    }
  }
  async results(body: unknown) {
    const input = parse(searchSchema, body);
    await this.validatePolygon(input);
    const fingerprint = hash(JSON.stringify({ ...input, cursor: undefined }));
    let after: unknown[] | undefined;
    if (input.cursor) {
      try {
        const c = JSON.parse(
          Buffer.from(input.cursor, 'base64url').toString(),
        ) as { hash: string; after: unknown[]; expires: number };
        if (
          c.hash !== fingerprint ||
          typeof c.expires !== 'number' ||
          !Number.isSafeInteger(c.expires) ||
          c.expires <= Date.now() ||
          !Array.isArray(c.after) ||
          c.after.length !== 2
        )
          throw Error();
        after = c.after;
      } catch {
        throw new BadRequestException('Invalid or expired cursor');
      }
    }
    const bool = indexQuery(input).bool;
    const response = await this.index.request(
      '/' + this.index.alias + '/_search',
      'POST',
      {
        size: input.limit,
        query: { bool },
        sort: sortSpec(input.sort),
        ...(after ? { search_after: after } : {}),
        track_total_hits: true,
        aggs: {
          category: { terms: { field: 'category', size: 20 } },
          dealType: { terms: { field: 'deal_type', size: 10 } },
        },
        _source: false,
      },
    );
    const hits = response.hits as {
      hits: { _id: string; sort: unknown[] }[];
      total: { value: number };
    };
    const rows = await this.eligible(
      hits.hits.map((h) => h._id),
      input,
    );
    const ordered = hits.hits.flatMap((h) =>
      rows.filter((r) => r.id === h._id),
    );
    const last = hits.hits.at(-1);
    const cursor =
      last && hits.hits.length === input.limit
        ? Buffer.from(
            JSON.stringify({
              hash: fingerprint,
              after: last.sort,
              expires: Date.now() + 900000,
            }),
          ).toString('base64url')
        : null;
    return {
      items: await this.cards(ordered),
      cursor,
      total: hits.total.value,
      totalIsEstimate: true,
      facets: response.aggregations,
    };
  }
  async map(body: unknown): Promise<SearchMapResult> {
    const input = parse(searchSchema, body);
    await this.validatePolygon(input);
    if (!input.bounds && !input.polygon)
      throw new BadRequestException('Map bounds required');
    // Search text/filter selection uses the same index query; all geo matching is repeated by PostGIS.
    const query = indexQuery(input);
    const response = await this.index.request(
      '/' + this.index.alias + '/_search',
      'POST',
      {
        size: 2000,
        query,
        _source: false,
        sort: [{ id: 'asc' }],
        track_total_hits: true,
      },
    );
    const hits = response.hits as {
      hits: { _id: string }[];
      total: { value: number };
    };
    const rows = await this.eligible(
      hits.hits.map((h) => h._id),
      input,
    );
    const b = input.bounds ?? [-180, -90, 180, 90];
    const dx = (b[2] - b[0]) / 12,
      dy = (b[3] - b[1]) / 8;
    const groups = new Map<string, PublicRow[]>();
    const truncated = hits.total.value > 2000;
    const first = rows[0];
    const extent: SearchMapResult['extent'] =
      first && !truncated
        ? [first.longitude, first.latitude, first.longitude, first.latitude]
        : null;
    for (const row of rows) {
      if (extent) {
        extent[0] = Math.min(extent[0], row.longitude);
        extent[1] = Math.min(extent[1], row.latitude);
        extent[2] = Math.max(extent[2], row.longitude);
        extent[3] = Math.max(extent[3], row.latitude);
      }
      const key =
        Math.floor((row.longitude - b[0]) / dx) +
        ':' +
        Math.floor((row.latitude - b[1]) / dy);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return {
      markers: [...groups.values()].map((g) => ({
        id: g[0]!.id,
        count: g.length,
        longitude: g.reduce((n, r) => n + r.longitude, 0) / g.length,
        latitude: g.reduce((n, r) => n + r.latitude, 0) / g.length,
        minPrice: Math.min(...g.map((r) => r.price)),
        listingIds: g.map((r) => r.id),
      })),
      truncated,
      extent,
      matched: rows.length,
    };
  }
  async selection(body: unknown) {
    const input = parse(
      z
        .object({
          ids: z.array(uuid).min(1).max(2000),
          definition: searchSchema,
        })
        .strict(),
      body,
    );
    await this.validatePolygon(input.definition);
    return {
      items: await this.cards(
        (await this.eligible(input.ids, input.definition)).slice(0, 50),
      ),
      cursor: null,
      totalIsEstimate: false,
      total: input.ids.length,
      facets: {},
    };
  }
  async sitemap(query: unknown = {}) {
    const input = parse(z.object({ after: uuid.optional() }).strict(), query);
    return this.db.rows(
      'SELECT id,published_at FROM public_search_listings WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 49999',
      [input.after ?? null],
    );
  }
  async sitemapPartitions() {
    const boundaries = await this.db.rows<{ id: string }>(
      `WITH numbered AS (SELECT id,row_number() OVER(ORDER BY id) AS rn,count(*) OVER() AS total FROM public_search_listings)
       SELECT id FROM numbered WHERE rn % 49999=0 AND rn<total ORDER BY rn`,
    );
    return {
      pageSize: 49999,
      cursors: [null, ...boundaries.map((row) => row.id)],
    };
  }
  async sync(limit = 100, target = this.index.alias) {
    const jobs = await this.db.rows<{ listing_id: string; revision: string }>(
      'SELECT listing_id,revision FROM search_jobs ORDER BY revision LIMIT $1',
      [limit],
    );
    const rows = await this.publicRows(jobs.map((j) => j.listing_id));
    for (const job of jobs) {
      await this.index.write(
        job.listing_id,
        job.revision,
        rows.find((r) => r.id === job.listing_id)
          ? documentOf(rows.find((r) => r.id === job.listing_id)!)
          : null,
        target,
      );
      await this.db.rows(
        'DELETE FROM search_jobs WHERE listing_id=$1 AND revision=$2',
        [job.listing_id, job.revision],
      );
    }
    if (jobs.length)
      await this.index.request('/' + target + '/_refresh', 'POST');
    return jobs.length;
  }
  async reindex() {
    const sql = await this.db.pool.connect();
    try {
      await sql.query('SELECT pg_advisory_lock(734302)');
      const name = this.index.alias + '-v3-' + Date.now();
      await this.index.request('/' + name, 'PUT', listingMapping);
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const rows = await this.db.rows<PublicRow>(
          'SELECT * FROM public_search_listings WHERE id>$1 ORDER BY id LIMIT 100',
          [after],
        );
        if (!rows.length) break;
        for (const row of rows)
          await this.index.write(row.id, '1', documentOf(row), name);
        after = rows.at(-1)!.id;
      }
      await this.index.request('/' + name + '/_refresh', 'POST');
      await this.index.request('/_aliases', 'POST', {
        actions: [
          {
            remove: {
              index: this.index.alias + '-*',
              alias: this.index.alias,
              must_exist: false,
            },
          },
          {
            add: { index: name, alias: this.index.alias, is_write_index: true },
          },
        ],
      });
      await this.reconcile();
      while (await this.sync()) {
        /* Replay changes after copying. */
      }
      return name;
    } finally {
      await sql.query('SELECT pg_advisory_unlock(734302)');
      sql.release();
    }
  }
  async reconcile() {
    await this.db.rows(
      "INSERT INTO search_jobs(listing_id) SELECT id FROM listings ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now()",
    );
    let after: unknown[] | undefined;
    for (;;) {
      const response = await this.index.request(
        '/' + this.index.alias + '/_search',
        'POST',
        {
          size: 500,
          query: { exists: { field: 'location' } },
          sort: [{ id: 'asc' }],
          _source: false,
          ...(after ? { search_after: after } : {}),
        },
      );
      const hits = (
        response.hits as { hits: { _id: string; sort: unknown[] }[] }
      ).hits;
      if (!hits.length) break;
      const ids = hits
        .map((h) => h._id)
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      await this.db.rows(
        "INSERT INTO search_jobs(listing_id) SELECT candidate.id FROM unnest($1::uuid[]) AS candidate(id) WHERE NOT EXISTS(SELECT 1 FROM listings l WHERE l.id=candidate.id) ON CONFLICT(listing_id) DO UPDATE SET revision=nextval('search_revision'),updated_at=now()",
        [ids],
      );
      after = hits.at(-1)!.sort;
    }
  }
}
@Controller('v1/search')
export class SearchController {
  constructor(readonly search: Search) {}
  @Get('professional-profile') ownProfessional(@CurrentActor() actor: Actor) {
    return this.search.ownProfessional(actor);
  }
  @Patch('professional-profile') saveProfessional(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ) {
    return this.search.saveProfessional(actor, body);
  }
  @Get('professional-profile/agency/:id') agencyProfile(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.search.ownProfessional(actor, id);
  }
  @Patch('professional-profile/agency/:id') saveAgencyProfile(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.search.saveProfessional(actor, body, id);
  }
  @Public() @Get('professionals') professionals(@Query() query: unknown) {
    return this.search.professionals(query);
  }
  @Public() @Get('professionals/:id') professional(
    @Param('id') id: string,
    @Query('regionCode') region: unknown,
    @Query('page') page: unknown,
  ) {
    return this.search.professional(id, region, page);
  }
  @Public() @Get('region-counts') regionCounts() {
    return this.search.regionCounts();
  }
  @Public() @Get('recent') recent() {
    return this.search.recentWithPhotos();
  }
  @Public() @Get('locations') locations(@Query() query: unknown) {
    return this.search.locations(query);
  }
  @Public() @Get('sitemap/partitions') partitions() {
    return this.search.sitemapPartitions();
  }
  @Public() @Get('sitemap') sitemap(@Query() query: unknown) {
    return this.search.sitemap(query);
  }
  @Public() @Post() results(@Body() body: unknown) {
    return this.search.results(body);
  }
  @Public() @Post('selection') selection(@Body() body: unknown) {
    return this.search.selection(body);
  }
  @Public() @Post('map') map(@Body() body: unknown) {
    return this.search.map(body);
  }
}
@Module({
  imports: [PaidPlacementModule, GeoModule, OrganizationsModule],
  controllers: [SearchController],
  providers: [Search, SearchIndex],
  exports: [Search, SearchIndex],
})
export class SearchModule {}
