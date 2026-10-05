import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  parse,
  uuid,
} from '../../common/security';
import { Audit } from '../audit/audit';
import { Database } from '../database/database';
import {
  Organizations,
  OrganizationsModule,
} from '../organizations/organizations';

const importItem = z
  .object({
    externalReference: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    price: z.number().positive().max(99_999_999_999_999),
    dealType: z.enum(['sale', 'long_rent', 'short_rent']),
    categoryCode: z.string().trim().min(1).max(80),
    description: z.string().max(10000).default(''),
    attributes: z.record(z.string().max(50), z.union([
      z.string().max(2000),
      z.number(),
      z.boolean(),
    ])).default({}),
    address: z
      .object({
        formatted: z.string().trim().min(3).max(500),
        locality: z.string().trim().min(1).max(100),
        district: z.string().max(100).optional(),
        longitude: z.number().min(-180).max(180),
        latitude: z.number().min(-90).max(90),
      })
      .strict(),
  })
  .strict();

@Injectable()
export class ProfessionalImports {
  constructor(
    private readonly db: Database,
    private readonly organizations: Organizations,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}

  async apply(
    actor: Actor,
    organizationId: string,
    feedId: string,
    body: unknown,
    key: unknown,
  ) {
    const organization = parse(uuid, organizationId);
    const feed = parse(uuid, feedId);
    await this.organizations.permission(actor, organization, true);
    const input = parse(
      z.object({ items: z.array(z.unknown()).min(1).max(1000) }).strict(),
      body,
    );

    return this.idem.run(
      actor,
      `professional.feed.apply:${feed}`,
      key,
      input,
      async (sql) => {
        const [definition] = await this.db.rows<{ id: string }>(
          `SELECT id FROM professional_feed_definitions
           WHERE id=$1 AND organization_id=$2 AND active
           FOR SHARE`,
          [feed, organization],
          sql,
        );
        if (!definition) throw new BadRequestException('Active feed not found');

        const [run] = await this.db.rows<{ id: string }>(
          `INSERT INTO professional_import_runs(
             feed_id,organization_id,requested_by,mode,status
           ) VALUES($1,$2,$3,'apply','running')
           RETURNING id`,
          [feed, organization, actor.id],
          sql,
        );

        let upserted = 0;
        let quarantined = 0;
        const seen = new Set<string>();

        for (const [index, raw] of input.items.entries()) {
          const result = importItem.safeParse(raw);
          const fallback = `invalid:${index + 1}`;
          const reference =
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as { externalReference?: unknown }).externalReference ===
              'string'
              ? (raw as { externalReference: string }).externalReference.trim() ||
                fallback
              : fallback;

          const errors = result.success
            ? []
            : result.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              }));

          if (seen.has(reference))
            errors.push({
              path: 'externalReference',
              message: 'Duplicate external reference in import',
            });
          seen.add(reference);

          if (errors.length || !result.success) {
            quarantined++;
            await sql.query(
              `INSERT INTO professional_import_items(
                 run_id,external_reference,status,payload,errors
               ) VALUES($1,$2,'quarantined',$3,$4)`,
              [
                run!.id,
                reference.slice(0, 200),
                JSON.stringify(raw),
                JSON.stringify(errors),
              ],
            );
            continue;
          }

          const item = result.data;
          const [category] = await this.db.rows<{ code: string }>(
            'SELECT code FROM categories WHERE code=$1 AND active',
            [item.categoryCode],
            sql,
          );
          if (!category) {
            quarantined++;
            await sql.query(
              `INSERT INTO professional_import_items(
                 run_id,external_reference,status,payload,errors
               ) VALUES($1,$2,'quarantined',$3,$4)`,
              [
                run!.id,
                item.externalReference,
                JSON.stringify(raw),
                JSON.stringify([
                  { path: 'categoryCode', message: 'Unknown active category' },
                ]),
              ],
            );
            continue;
          }

          const [source] = await this.db.rows<{ id: string }>(
            `INSERT INTO listing_sources(
               kind,organization_id,external_reference,metadata
             ) VALUES('feed',$1,$2,$3)
             ON CONFLICT(organization_id,kind,external_reference)
             WHERE external_reference IS NOT NULL
             DO UPDATE SET metadata=EXCLUDED.metadata
             RETURNING id`,
            [
              organization,
              item.externalReference,
              JSON.stringify({ feedId: feed, lastRunId: run!.id }),
            ],
            sql,
          );

          const [existing] = await this.db.rows<{
            id: string;
            property_id: string;
            status: string;
          }>(
            'SELECT id,property_id,status FROM listings WHERE source_id=$1 FOR UPDATE',
            [source!.id],
            sql,
          );

          if (
            existing &&
            ['archived', 'sold', 'rented'].includes(existing.status)
          ) {
            quarantined++;
            await sql.query(
              `INSERT INTO professional_import_items(
                 run_id,external_reference,listing_id,status,payload,errors
               ) VALUES($1,$2,$3,'quarantined',$4,$5)`,
              [
                run!.id,
                item.externalReference,
                existing.id,
                JSON.stringify(raw),
                JSON.stringify([
                  {
                    path: 'externalReference',
                    message: 'Terminal listing cannot be overwritten',
                  },
                ]),
              ],
            );
            continue;
          }

          const [address] = await this.db.rows<{ id: string }>(
            `INSERT INTO addresses(
               formatted,locality,district,point,provider,provider_reference
             ) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326),'feed',$6)
             RETURNING id`,
            [
              item.address.formatted,
              item.address.locality,
              item.address.district ?? null,
              item.address.longitude,
              item.address.latitude,
              item.externalReference,
            ],
            sql,
          );

          let propertyId: string;
          let listingId: string;

          if (existing) {
            propertyId = existing.property_id;
            listingId = existing.id;
            await sql.query(
              `UPDATE properties
               SET category_code=$2,address_id=$3,attributes=$4,
                   version=version+1,updated_at=now()
               WHERE id=$1`,
              [
                propertyId,
                item.categoryCode,
                address!.id,
                JSON.stringify(item.attributes),
              ],
            );
            await sql.query(
              `UPDATE listings
               SET deal_type=$2,title=$3,price=$4,description=$5,
                   status='draft',version=version+1,updated_at=now()
               WHERE id=$1`,
              [
                listingId,
                item.dealType,
                item.title,
                item.price,
                item.description,
              ],
            );
          } else {
            const [property] = await this.db.rows<{ id: string }>(
              `INSERT INTO properties(
                 created_by,organization_id,category_code,address_id,attributes
               ) VALUES($1,$2,$3,$4,$5)
               RETURNING id`,
              [
                actor.id,
                organization,
                item.categoryCode,
                address!.id,
                JSON.stringify(item.attributes),
              ],
              sql,
            );
            propertyId = property!.id;
            const [listing] = await this.db.rows<{ id: string }>(
              `INSERT INTO listings(
                 property_id,source_id,seller_id,organization_id,deal_type,
                 title,price,description,terms,status
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,'draft')
               RETURNING id`,
              [
                propertyId,
                source!.id,
                actor.id,
                organization,
                item.dealType,
                item.title,
                item.price,
                item.description,
              ],
              sql,
            );
            listingId = listing!.id;
          }

          upserted++;
          await sql.query(
            `INSERT INTO professional_import_items(
               run_id,external_reference,property_id,listing_id,status,payload
             ) VALUES($1,$2,$3,$4,'upserted',$5)`,
            [
              run!.id,
              item.externalReference,
              propertyId,
              listingId,
              JSON.stringify(raw),
            ],
          );
          await this.audit.record(
            sql,
            actor.id,
            existing ? 'professional.feed.updated' : 'professional.feed.created',
            'listing',
            listingId,
            {
              organizationId: organization,
              feedId: feed,
              externalReference: item.externalReference,
              runId: run!.id,
            },
          );
        }

        const stats = {
          total: input.items.length,
          upserted,
          quarantined,
        };
        await sql.query(
          `UPDATE professional_import_runs
           SET status=$2,stats=$3,finished_at=now()
           WHERE id=$1`,
          [
            run!.id,
            quarantined > 0 ? 'quarantined' : 'succeeded',
            JSON.stringify(stats),
          ],
        );
        await this.audit.record(
          sql,
          actor.id,
          'professional.feed.applied',
          'professional_import_run',
          run!.id,
          { organizationId: organization, feedId: feed, ...stats },
        );
        return { runId: run!.id, ...stats };
      },
      (sql) => this.organizations.permission(actor, organization, true, sql),
    );
  }
}

@Controller('v1/organizations/:organizationId/feeds/:feedId')
export class ProfessionalImportsController {
  constructor(private readonly imports: ProfessionalImports) {}

  @Post('apply')
  apply(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('feedId') feedId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.imports.apply(actor, organizationId, feedId, body, key);
  }
}

@Module({
  imports: [OrganizationsModule],
  controllers: [ProfessionalImportsController],
  providers: [ProfessionalImports, Idempotency],
})
export class ProfessionalImportsModule {}
