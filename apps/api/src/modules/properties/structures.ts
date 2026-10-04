import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
  ForbiddenException,
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
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';
import { Audit } from '../audit/audit';
import { Geo, GeoModule, addressSchema } from '../geo/geo';
@Injectable()
export class Structures {
  constructor(
    private readonly db: Database,
    private readonly orgs: Organizations,
    private readonly geo: Geo,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async developer(actor: Actor, id: string, sql: Sql = this.db.pool) {
    const member = await this.orgs.permission(actor, id, false, sql);
    if (member.kind !== 'developer')
      throw new ForbiddenException('Developer organization required');
  }
  async create(
    actor: Actor,
    kind: 'complex' | 'building' | 'section' | 'floor',
    body: unknown,
    key: unknown,
  ) {
    seller(actor);
    const input = parse(
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('complex'),
            organizationId: uuid,
            name: z.string().min(1).max(200),
            address: addressSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal('building'),
            organizationId: uuid,
            name: z.string().min(1).max(200),
            address: addressSchema,
            complexId: uuid.optional(),
            completionDate: z.iso.date().optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('section'),
            buildingId: uuid,
            name: z.string().min(1).max(100),
          })
          .strict(),
        z
          .object({
            kind: z.literal('floor'),
            sectionId: uuid,
            number: z.number().int().min(-10).max(200),
          })
          .strict(),
      ]),
      { ...(typeof body === 'object' && body !== null ? body : {}), kind },
    );
    return this.idem.run(
      actor,
      `structure.${kind}`,
      key,
      input,
      async (sql) => {
        let result: { id: string };
        if (input.kind === 'complex' || input.kind === 'building') {
          await this.developer(actor, input.organizationId, sql);
          const address = await this.geo.create(sql, input.address);
          if (input.kind === 'complex')
            [result] = (await this.db.rows<{ id: string }>(
              'INSERT INTO residential_complexes(organization_id,name,address_id) VALUES($1,$2,$3) RETURNING *',
              [input.organizationId, input.name, address],
              sql,
            )) as [{ id: string }];
          else {
            if (input.complexId) {
              const [complex] = await this.db.rows<{ organization_id: string }>(
                'SELECT organization_id FROM residential_complexes WHERE id=$1',
                [input.complexId],
                sql,
              );
              if (complex?.organization_id !== input.organizationId)
                throw new BadRequestException('Complex organization mismatch');
            }
            [result] = (await this.db.rows<{ id: string }>(
              'INSERT INTO buildings(organization_id,name,address_id,complex_id,completion_date) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [
                input.organizationId,
                input.name,
                address,
                input.complexId ?? null,
                input.completionDate ?? null,
              ],
              sql,
            )) as [{ id: string }];
          }
        } else {
          const [building] = await this.db.rows<{
            id: string;
            organization_id: string;
          }>(
            input.kind === 'section'
              ? 'SELECT id,organization_id FROM buildings WHERE id=$1'
              : 'SELECT b.id,b.organization_id FROM buildings b JOIN sections s ON s.building_id=b.id WHERE s.id=$1',
            [input.kind === 'section' ? input.buildingId : input.sectionId],
            sql,
          );
          if (!building)
            throw new BadRequestException('Parent structure missing');
          await this.developer(actor, building.organization_id, sql);
          [result] = (await this.db.rows<{ id: string }>(
            input.kind === 'section'
              ? 'INSERT INTO sections(building_id,name) VALUES($1,$2) RETURNING *'
              : 'INSERT INTO floors(section_id,number) VALUES($1,$2) RETURNING *',
            input.kind === 'section'
              ? [input.buildingId, input.name]
              : [input.sectionId, input.number],
            sql,
          )) as [{ id: string }];
        }
        await this.audit.record(
          sql,
          actor.id,
          `${kind}.created`,
          kind,
          result.id,
          input,
        );
        return result;
      },
      async (sql) => {
        if ('organizationId' in input)
          return this.developer(actor, input.organizationId, sql);
        const [building] = await this.db.rows<{ organization_id: string }>(
          input.kind === 'section'
            ? 'SELECT organization_id FROM buildings WHERE id=$1'
            : 'SELECT b.organization_id FROM buildings b JOIN sections s ON s.building_id=b.id WHERE s.id=$1',
          [input.kind === 'section' ? input.buildingId : input.sectionId],
          sql,
        );
        if (!building)
          throw new BadRequestException('Parent structure missing');
        return this.developer(actor, building.organization_id, sql);
      },
    );
  }
  async hierarchy(actor: Actor, organizationId: string) {
    await this.developer(actor, organizationId);
    return {
      complexes: await this.db.rows(
        'SELECT * FROM residential_complexes WHERE organization_id=$1 ORDER BY id LIMIT 100',
        [organizationId],
      ),
      buildings: await this.db.rows(
        'SELECT * FROM buildings WHERE organization_id=$1 ORDER BY id LIMIT 100',
        [organizationId],
      ),
      sections: await this.db.rows(
        'SELECT s.* FROM sections s JOIN buildings b ON b.id=s.building_id WHERE b.organization_id=$1 ORDER BY s.id LIMIT 100',
        [organizationId],
      ),
      floors: await this.db.rows(
        'SELECT f.* FROM floors f JOIN sections s ON s.id=f.section_id JOIN buildings b ON b.id=s.building_id WHERE b.organization_id=$1 ORDER BY f.id LIMIT 100',
        [organizationId],
      ),
    };
  }
}
@Controller('v1/structures')
export class StructureController {
  constructor(private readonly structures: Structures) {}
  @Post('complexes') complex(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.structures.create(actor, 'complex', body, key);
  }
  @Post('buildings') building(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.structures.create(actor, 'building', body, key);
  }
  @Post('sections') section(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.structures.create(actor, 'section', body, key);
  }
  @Post('floors') floor(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.structures.create(actor, 'floor', body, key);
  }
  @Get(':organizationId') hierarchy(
    @CurrentActor() actor: Actor,
    @Param('organizationId') id: string,
  ) {
    return this.structures.hierarchy(actor, parse(uuid, id));
  }
}
@Module({
  imports: [OrganizationsModule, GeoModule],
  controllers: [StructureController],
  providers: [Structures, Idempotency],
})
export class StructuresModule {}
