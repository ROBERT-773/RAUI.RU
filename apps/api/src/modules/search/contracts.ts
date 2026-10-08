import { z } from 'zod';
import { regionCodeSchema } from '../geo/regions';
const range = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    'Invalid range',
  );
export const attributeFilters = [
  'rooms',
  'area',
  'floor',
  'floors',
  'building_year',
  'building_type',
  'renovation',
  'bathroom',
  'balcony',
  'loggia',
  'ceiling_height',
  'elevator',
  'parking',
  'furniture',
  'equipment',
  'mortgage',
  'market',
  'metro',
  'okrug',
  'highway',
  'highway_distance',
] as const;
export const searchSchema = z
  .object({
    q: z.string().trim().max(200).default(''),
    category: z.string().max(40).optional(),
    dealType: z.enum(['sale', 'long_rent', 'short_rent']).optional(),
    price: range.optional(),
    pricePerM2: range.optional(),
    regionCode: regionCodeSchema.optional(),
    locality: z.string().max(150).optional(),
    district: z.string().max(150).optional(),
    sellerType: z
      .enum(['owner', 'agent', 'agency', 'developer', 'admin'])
      .optional(),
    sourceType: z
      .enum(['direct', 'agency', 'developer', 'feed', 'api'])
      .optional(),
    publishedAfter: z.iso.datetime().optional(),
    attributes: z
      .partialRecord(
        z.enum(attributeFilters),
        z.union([range, z.string().max(150), z.boolean()]),
      )
      .default({}),
    sort: z
      .enum(['newest', 'price_asc', 'price_desc', 'area_desc'])
      .default('newest'),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(4000).optional(),
    bounds: z
      .tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
      ])
      .refine(
        (b) => b[0] < b[2] && b[1] < b[3],
        'Bounds must not cross antimeridian',
      )
      .optional(),
    polygon: z
      .array(
        z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
      )
      .min(4)
      .max(100)
      .refine(
        (p) => p[0]?.[0] === p.at(-1)?.[0] && p[0]?.[1] === p.at(-1)?.[1],
        'Close polygon',
      )
      .optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof searchSchema>;
export function indexQuery(input: SearchInput) {
  const filter: unknown[] = [{ exists: { field: 'location' } }];
  for (const [key, value] of Object.entries({
    category: input.category,
    deal_type: input.dealType,
    region_code: input.regionCode,
    locality: input.locality,
    district: input.district,
    seller_type: input.sellerType,
    source_type: input.sourceType,
  }))
    if (value !== undefined) filter.push({ term: { [key]: value } });
  for (const [key, value] of Object.entries({
    price: input.price,
    price_per_m2: input.pricePerM2,
  }))
    if (value)
      filter.push({
        range: {
          [key]: {
            ...(value.min !== undefined ? { gte: value.min } : {}),
            ...(value.max !== undefined ? { lte: value.max } : {}),
          },
        },
      });
  if (input.publishedAfter)
    filter.push({ range: { published_at: { gte: input.publishedAfter } } });
  for (const [key, value] of Object.entries(input.attributes)) {
    const typed =
      typeof value === 'object'
        ? 'number'
        : typeof value === 'boolean'
          ? 'boolean'
          : 'keyword';
    const clause =
      typeof value === 'object'
        ? {
            range: {
              ['attributes.' + typed]: {
                ...(value.min !== undefined ? { gte: value.min } : {}),
                ...(value.max !== undefined ? { lte: value.max } : {}),
              },
            },
          }
        : { term: { ['attributes.' + typed]: value } };
    filter.push({
      nested: {
        path: 'attributes',
        query: {
          bool: { filter: [{ term: { 'attributes.code': key } }, clause] },
        },
      },
    });
  }
  if (input.bounds) {
    const [west, south, east, north] = input.bounds;
    filter.push({
      geo_bounding_box: {
        location: {
          top_left: { lon: west, lat: north },
          bottom_right: { lon: east, lat: south },
        },
      },
    });
  }
  if (input.polygon)
    filter.push({
      geo_polygon: {
        location: { points: input.polygon.map(([lon, lat]) => ({ lon, lat })) },
      },
    });
  return {
    bool: {
      filter,
      must: input.q
        ? [
            {
              multi_match: {
                query: input.q,
                fields: ['title^3', 'description', 'address'],
                fuzziness: 'AUTO',
                operator: 'and',
              },
            },
          ]
        : [{ match_all: {} }],
    },
  };
}
export function sortSpec(sort: SearchInput['sort']) {
  const field =
    sort === 'newest'
      ? 'published_at'
      : sort === 'area_desc'
        ? 'area'
        : 'price';
  return [
    {
      [field]: {
        order: sort === 'price_asc' ? 'asc' : 'desc',
        missing: '_last',
      },
    },
    { id: 'asc' },
  ];
}
