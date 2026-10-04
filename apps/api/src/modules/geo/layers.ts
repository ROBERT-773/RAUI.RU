import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import type { GeoJSONFeature } from '@raui/types/product';
import { Public, parse } from '../../common/security';
import { searchSchema } from '../search/contracts';
export abstract class GeoLayersProvider {
  abstract boundaries(
    kind: 'district' | 'okrug',
    locality: string,
  ): Promise<GeoJSONFeature[]>;
  abstract pois(
    bounds: [number, number, number, number],
  ): Promise<GeoJSONFeature[]>;
  abstract readonly configured: boolean;
}
@Injectable()
export class EmptyGeoLayers extends GeoLayersProvider {
  readonly configured = false;
  async boundaries() {
    return [];
  }
  async pois() {
    return [];
  }
}
@Injectable()
export class GeoLayers {
  constructor(readonly provider: GeoLayersProvider) {}
  async lookup(body: unknown) {
    const input = parse(
      z
        .object({
          bounds: searchSchema.shape.bounds.unwrap(),
          locality: z.string().max(150).optional(),
          kind: z.enum(['district', 'okrug']).default('district'),
        })
        .strict(),
      body,
    );
    const [pois, boundaries] = await Promise.all([
      this.provider.pois(input.bounds),
      input.locality
        ? this.provider.boundaries(input.kind, input.locality)
        : Promise.resolve([]),
    ]);
    return { configured: this.provider.configured, pois, boundaries };
  }
}
@Controller('v1/geo/layers')
export class GeoLayersController {
  constructor(readonly layers: GeoLayers) {}
  @Public() @Post() lookup(@Body() body: unknown) {
    return this.layers.lookup(body);
  }
}
@Module({
  controllers: [GeoLayersController],
  providers: [
    GeoLayers,
    { provide: GeoLayersProvider, useClass: EmptyGeoLayers },
  ],
  exports: [GeoLayersProvider],
})
export class GeoLayersModule {}
