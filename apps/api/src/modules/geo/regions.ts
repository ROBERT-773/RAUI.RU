import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { Public } from '../../common/security';

export const regionCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
const entitySchema = z.enum([
  'okrug',
  'district',
  'metro',
  'street',
  'house',
  'locality',
  'direction',
]);
const boundsSchema = z
  .object({
    min_lat: z.number().finite().min(-90).max(90),
    max_lat: z.number().finite().min(-90).max(90),
    min_lon: z.number().finite().min(-180).max(180),
    max_lon: z.number().finite().min(-180).max(180),
  })
  .strict()
  .refine((b) => b.min_lat < b.max_lat && b.min_lon < b.max_lon);
const regionSchema = z
  .object({
    code: regionCodeSchema,
    name: z.string().trim().min(1).max(100),
    type: z.enum(['city', 'oblast']),
    search_entities: z
      .array(entitySchema)
      .min(1)
      .max(7)
      .refine((items) => new Set(items).size === items.length),
    metro_available: z.boolean(),
    directions_available: z.boolean(),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('ru', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    currency: z.literal('RUB'),
    geo_bounds: boundsSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (r) =>
      r.search_entities.includes('metro') === r.metro_available &&
      r.search_entities.includes('direction') === r.directions_available,
  );
type Region = z.infer<typeof regionSchema>;
const invalid = () => new Error('Invalid region configuration');

export function loadRegionDocuments(directory: string): string[] {
  try {
    const names = readdirSync(directory)
      .filter((name) => name.endsWith('.yaml'))
      .sort();
    if (names.length < 1 || names.length > 100) throw invalid();
    return names.map((name) => {
      if (!/^[a-z][a-z0-9_]{0,49}\.yaml$/.test(name)) throw invalid();
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 65536) throw invalid();
      return readFileSync(path, 'utf8');
    });
  } catch {
    throw invalid();
  }
}

export class RegionCatalogue {
  private readonly regions: Map<string, Region>;
  constructor(records: string[]) {
    try {
      if (records.length < 1 || records.length > 100) throw invalid();
      const regions = records
        .map((source) => {
          if (Buffer.byteLength(source) > 65536) throw invalid();
          const document = parseDocument(source, {
            schema: 'core',
            uniqueKeys: true,
          });
          if (document.errors.length || document.warnings.length)
            throw invalid();
          return regionSchema.parse(document.toJS({ maxAliasCount: 0 }));
        })
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      this.regions = new Map(regions.map((region) => [region.code, region]));
      if (this.regions.size !== regions.length) throw invalid();
    } catch {
      throw invalid();
    }
  }
  list() {
    return structuredClone(
      Array.from(this.regions.values()).map((region) => ({
        ...region,
        data_status: 'catalogue_only' as const,
      })),
    );
  }
  assertConfigured(code: string): void {
    if (!regionCodeSchema.safeParse(code).success || !this.regions.has(code))
      throw new BadRequestException('Invalid or unsupported region code');
  }
  filters(code: string) {
    if (!regionCodeSchema.safeParse(code).success)
      throw new BadRequestException('Invalid region code');
    const region = this.regions.get(code);
    if (!region) throw new NotFoundException('Region not found');
    return structuredClone({
      ...region,
      data_status: 'catalogue_only' as const,
    });
  }
}

const metadataSchema = {
  type: 'object' as const,
  required: [
    'code',
    'name',
    'type',
    'search_entities',
    'metro_available',
    'directions_available',
    'timezone',
    'currency',
    'geo_bounds',
    'data_status',
  ],
  properties: {
    code: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['city', 'oblast'] },
    search_entities: {
      type: 'array',
      items: { type: 'string', enum: entitySchema.options },
    },
    metro_available: { type: 'boolean' },
    directions_available: { type: 'boolean' },
    timezone: { type: 'string' },
    currency: { type: 'string', enum: ['RUB'] },
    geo_bounds: {
      type: 'object',
      nullable: true,
      properties: {
        min_lat: { type: 'number' },
        max_lat: { type: 'number' },
        min_lon: { type: 'number' },
        max_lon: { type: 'number' },
      },
    },
    data_status: { type: 'string', enum: ['catalogue_only'] },
  },
};
@ApiTags('regions')
@Controller('v1/regions')
export class RegionsController {
  constructor(private readonly catalogue: RegionCatalogue) {}
  @Public()
  @Get()
  @ApiOperation({
    summary:
      'Configured region metadata; regional search/data connections are separate',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: metadataSchema } },
    },
  })
  list() {
    return { items: this.catalogue.list() };
  }
  @Public()
  @Get(':code/filters')
  @ApiOperation({
    summary: 'Region filter metadata, not confirmation of available geo data',
  })
  @ApiOkResponse({ schema: metadataSchema })
  @ApiBadRequestResponse({ description: 'Malformed region code' })
  @ApiNotFoundResponse({ description: 'Unknown region' })
  filters(@Param('code') code: string) {
    return this.catalogue.filters(code);
  }
}
