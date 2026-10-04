import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Headers,
  Injectable,
  Module,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import {
  Catalog,
  CatalogModule,
  codeSchema,
  validateAttributes,
} from '../catalog/catalog';
import { Geo, GeoModule, addressSchema } from '../geo/geo';
const values = z.record(
  z.string().max(50),
  z.union([z.string().max(2000), z.number(), z.boolean()]),
);
export const createSchema = z
  .object({
    organizationId: uuid.optional(),
    category: codeSchema,
    address: addressSchema,
    buildingId: uuid.optional(),
    floorId: uuid.optional(),
    unitNumber: z.string().max(50).optional(),
    attributes: values.default({}),
  })
  .strict();
export interface Property {
  id: string;
  created_by: string;
  organization_id: string | null;
  category_code: string;
  address_id: string;
  building_id: string | null;
  floor_id: string | null;
  attributes: Record<string, unknown>;
  version: number;
}
@Injectable()
export class Properties {
  constructor(
    private readonly db: Database,
    private readonly orgs: Organizations,
    private readonly catalog: Catalog,
    private readonly geo: Geo,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async access(
    actor: Actor,
    id: string,
    sql: Sql = this.db.pool,
    lock = false,
  ): Promise<Property> {
    const [property] = await this.db.rows<Property>(
      `SELECT * FROM properties WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [parse(uuid, id)],
      sql,
    );
    if (!property) throw new NotFoundException();
    if (property.organization_id)
      await this.orgs.permission(actor, property.organization_id, false, sql);
    else if (property.created_by !== actor.id && actor.role !== 'admin')
      throw new ForbiddenException();
    return property;
  }
  async complete(property: Property, sql: Sql) {
    validateAttributes(
      await this.catalog.definitions(property.category_code, sql),
      property.attributes,
      true,
    );
    const address = await this.geo.read(property.address_id, sql);
    if (!address) throw new BadRequestException('Address required');
  }
  async create(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(createSchema, body);
    return this.idem.run(
      actor,
      'property.create',
      key,
      input,
      async (sql) => {
        if (input.organizationId)
          await this.orgs.permission(actor, input.organizationId, false, sql);
        validateAttributes(
          await this.catalog.definitions(input.category, sql),
          input.attributes,
        );
        if (input.buildingId) {
          const [building] = await this.db.rows<{ organization_id: string }>(
            'SELECT organization_id FROM buildings WHERE id=$1',
            [input.buildingId],
            sql,
          );
          if (!building || building.organization_id !== input.organizationId)
            throw new ForbiddenException('Building organization mismatch');
        }
        if (input.floorId) {
          const [floor] = await this.db.rows<{ building_id: string }>(
            'SELECT s.building_id FROM floors f JOIN sections s ON s.id=f.section_id WHERE f.id=$1',
            [input.floorId],
            sql,
          );
          if (!floor || floor.building_id !== input.buildingId)
            throw new BadRequestException('Floor/building mismatch');
        }
        const addressId = await this.geo.create(sql, input.address);
        const [property] = await this.db.rows<Property>(
          'INSERT INTO properties(created_by,organization_id,category_code,address_id,building_id,floor_id,unit_number,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            actor.id,
            input.organizationId ?? null,
            input.category,
            addressId,
            input.buildingId ?? null,
            input.floorId ?? null,
            input.unitNumber ?? null,
            JSON.stringify(input.attributes),
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'property.created',
          'property',
          property!.id,
          input,
        );
        return property!;
      },
      async (sql) => {
        if (input.organizationId)
          await this.orgs.permission(actor, input.organizationId, false, sql);
      },
    );
  }
  async get(actor: Actor, id: string) {
    const property = await this.access(actor, id);
    return { ...property, address: await this.geo.read(property.address_id) };
  }
  async patch(actor: Actor, id: string, body: unknown) {
    seller(actor);
    const input = parse(
      z
        .object({
          version: z.number().int().positive(),
          attributes: values.optional(),
          address: addressSchema.optional(),
        })
        .strict(),
      body,
    );
    return this.db.transaction(async (sql) => {
      const property = await this.access(actor, id, sql, true);
      if (property.version !== input.version)
        throw new ConflictException('Stale property version');
      const listings = await this.db.rows<{ id: string; status: string }>(
        'SELECT id,status FROM listings WHERE property_id=$1 ORDER BY id FOR UPDATE',
        [id],
        sql,
      );
      if (
        listings.some((l) =>
          ['published', 'processing', 'moderation'].includes(l.status),
        )
      )
        throw new ConflictException(
          'Pause active listings before changing property',
        );
      const attributes = input.attributes ?? property.attributes;
      validateAttributes(
        await this.catalog.definitions(property.category_code, sql),
        attributes,
      );
      const addressId = input.address
        ? await this.geo.create(sql, input.address)
        : property.address_id;
      const [updated] = await this.db.rows<Property>(
        'UPDATE properties SET attributes=$2,address_id=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
        [id, JSON.stringify(attributes), addressId],
        sql,
      );
      for (const listing of listings) {
        await sql.query(
          "UPDATE listings SET status=CASE WHEN status IN ('draft','paused','rejected') THEN 'draft' ELSE status END,version=version+1,updated_at=now() WHERE id=$1",
          [listing.id],
        );
        await this.audit.history(
          sql,
          actor.id,
          listing.id,
          'listing.property.changed',
          property,
          updated!,
        );
      }
      await this.audit.record(
        sql,
        actor.id,
        'property.changed',
        'property',
        id,
        { before: property, after: updated },
      );
      return updated!;
    });
  }
}
@Controller('v1/properties')
export class PropertyController {
  constructor(private readonly properties: Properties) {}
  @Post() create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.properties.create(actor, body, key);
  }
  @Get(':id') get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.properties.get(actor, id);
  }
  @Patch(':id') patch(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.properties.patch(actor, id, body);
  }
}
@Module({
  imports: [OrganizationsModule, CatalogModule, GeoModule],
  controllers: [PropertyController],
  providers: [Properties, Idempotency],
  exports: [Properties],
})
export class PropertiesModule {}
