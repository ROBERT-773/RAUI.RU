import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { Public, parse, hash, uuid } from '../../common/security';
import { Database } from '../database/database';
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
  ) {}
  async publicRows(ids?: string[]) {
    return this.db.rows<PublicRow>(
      'SELECT * FROM public_search_listings' +
        (ids ? ' WHERE id=ANY($1::uuid[])' : ''),
      ids ? [ids] : [],
    );
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
    // One media query for the whole page, rather than one request per card.
    const assets = rows.length
      ? await this.db.rows<{
          listing_id: string;
          id: string;
          variants: Record<string, unknown>;
        }>(
          "SELECT DISTINCT ON(listing_id) listing_id,id,variants FROM media WHERE listing_id=ANY($1::uuid[]) AND state='ready' ORDER BY listing_id,created_at,id",
          [rows.map((r) => r.id)],
        )
      : [];
    return rows.map((source) => {
      const row = { ...source };
      delete row.point;
      return {
        ...row,
        media: assets
          .filter((a) => a.listing_id === row.id)
          .slice(0, 1)
          .map((a) => ({ id: a.id, url: '/v1/media/' + a.id + '/small' })),
      };
    });
  }
  async validatePolygon(input: SearchInput) {
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
          c.expires < Date.now() ||
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
  async map(body: unknown) {
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
    for (const row of rows) {
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
      truncated: hits.total.value > 2000,
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
  async sitemap() {
    return this.db.rows(
      'SELECT id,published_at FROM public_search_listings ORDER BY id LIMIT 50000',
    );
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
  @Public() @Get('sitemap') sitemap() {
    return this.search.sitemap();
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
  controllers: [SearchController],
  providers: [Search, SearchIndex],
  exports: [Search, SearchIndex],
})
export class SearchModule {}
