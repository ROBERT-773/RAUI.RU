import {
  Controller,
  Get,
  Query,
  Injectable,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/security';
import { Database, Sql } from '../database/database';
import { loadConfig } from '../../config';
import { join } from 'node:path';
import {
  RegionCatalogue,
  regionCodeSchema,
  RegionsController,
  loadRegionDocuments,
} from './regions';
export const addressSchema = z
  .object({
    formatted: z.string().trim().min(3).max(500),
    locality: z.string().trim().min(1).max(100),
    regionCode: regionCodeSchema.optional(),
    district: z.string().max(100).optional(),
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
  })
  .strict();
export type AddressInput = z.infer<typeof addressSchema>;
export abstract class Geocoder {
  abstract lookup(query: string): Promise<AddressInput[]>;
}
@Injectable()
export class HttpGeocoder extends Geocoder {
  async lookup(query: string) {
    const config = loadConfig();
    if (!config.GEOCODER_URL)
      throw new ServiceUnavailableException(
        'Geocoder unavailable; manual coordinates supported',
      );
    const url = new URL(config.GEOCODER_URL);
    url.searchParams.set('q', query);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: config.GEOCODER_TOKEN
        ? { Authorization: `Bearer ${config.GEOCODER_TOKEN}` }
        : {},
    });
    if (!response.ok)
      throw new ServiceUnavailableException('Geocoder unavailable');
    return parse(z.array(addressSchema).max(20), await response.json());
  }
}
@Injectable()
export class Geo {
  constructor(
    private readonly db: Database,
    private readonly regions: RegionCatalogue,
  ) {}
  async create(sql: Sql, address: AddressInput) {
    if (address.regionCode !== undefined)
      this.regions.assertConfigured(address.regionCode);
    const [row] = await this.db.rows<{ id: string }>(
      'INSERT INTO addresses(formatted,locality,district,point,region_code) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326),$6) RETURNING id',
      [
        address.formatted,
        address.locality,
        address.district ?? null,
        address.longitude,
        address.latitude,
        address.regionCode ?? null,
      ],
      sql,
    );
    return row!.id;
  }
  async read(id: string, sql: Sql = this.db.pool) {
    const [row] = await this.db.rows(
      'SELECT id,formatted,locality,district,ST_X(point) AS longitude,ST_Y(point) AS latitude,provider,region_code AS "regionCode" FROM addresses WHERE id=$1',
      [id],
      sql,
    );
    return row;
  }
}
@Controller('v1/geo')
export class GeoController {
  constructor(private readonly provider: Geocoder) {}
  @Get('geocode') lookup(@Query('q') query: string) {
    return this.provider.lookup(
      parse(z.string().trim().min(3).max(300), query),
    );
  }
}
@Module({
  controllers: [GeoController, RegionsController],
  providers: [
    Geo,
    { provide: Geocoder, useClass: HttpGeocoder },
    {
      provide: RegionCatalogue,
      useFactory: () =>
        new RegionCatalogue(
          loadRegionDocuments(join(__dirname, '../../config/regions')),
        ),
    },
  ],
  exports: [Geo, RegionCatalogue],
})
export class GeoModule {}
