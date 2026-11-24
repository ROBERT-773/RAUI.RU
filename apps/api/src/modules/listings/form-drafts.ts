import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { Database } from '../database/database';

const key = z.string().min(1).max(64);
const text = z.string().max(2000);
export const listingForm = z
  .object({
    step: z.number().int().min(0).max(3),
    category: z.string().max(100),
    deal: z.string().max(50),
    region: z.string().max(100),
    organizationId: z.string().max(100),
    locality: text,
    address: text,
    longitude: z.string().max(100),
    latitude: z.string().max(100),
    coordinatesFromSuggestion: z.boolean().optional(),
    attributes: z.record(key, text).refine((v) => Object.keys(v).length <= 100),
    title: text,
    price: z.string().max(100),
    terms: z
      .record(key, z.union([text, z.number(), z.boolean()]))
      .refine((v) => Object.keys(v).length <= 100),
  })
  .strict();

const draftVersion = z.number().int().min(1).max(2147483647);
export const savedListingForm = z.object({
  id: uuid,
  version: draftVersion,
  form: listingForm,
});
export const saveListingForm = z
  .object({ version: draftVersion.or(z.literal(0)), form: listingForm })
  .strict();
export const listingFormReference = z
  .object({ id: uuid, version: draftVersion })
  .strict();
type SavedForm = z.infer<typeof savedListingForm>;

@Injectable()
export class ListingFormDrafts {
  constructor(private readonly db: Database) {}

  list(actor: Actor) {
    seller(actor);
    return this.db.rows<SavedForm>(
      'SELECT id,version,form FROM listing_form_drafts WHERE owner_id=$1 AND listing_id IS NULL ORDER BY updated_at DESC,id',
      [actor.id],
    );
  }

  save(actor: Actor, id: string, body: unknown) {
    seller(actor);
    const { version, form } = parse(saveListingForm, body);
    const payload = JSON.stringify(form);
    return this.db.transaction(async (sql) => {
      if (version === 0) {
        const [created] = await this.db.rows<SavedForm>(
          'INSERT INTO listing_form_drafts(id,owner_id,form) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id,version,form',
          [id, actor.id, payload],
          sql,
        );
        if (created) return created;
      }
      const [current] = await this.db.rows<
        SavedForm & { same: boolean; listing_id: string | null }
      >(
        'SELECT id,version,form,listing_id,form=$3::jsonb AS same FROM listing_form_drafts WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, actor.id, payload],
        sql,
      );
      if (!current) throw new NotFoundException('Listing form draft not found');
      if (current.listing_id)
        throw new ConflictException('Listing form draft already completed');
      if (
        current.same &&
        (current.version === version || current.version === version + 1)
      )
        return { id: current.id, version: current.version, form: current.form };
      if (current.version !== version)
        throw new ConflictException('Stale listing form draft version');
      const [updated] = await this.db.rows<SavedForm>(
        'UPDATE listing_form_drafts SET form=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version,form',
        [id, payload],
        sql,
      );
      return updated!;
    });
  }
}

@Controller('v1/account/listing-drafts')
export class ListingFormDraftController {
  constructor(private readonly drafts: ListingFormDrafts) {}

  @Get() list(@CurrentActor() actor: Actor) {
    return this.drafts.list(actor);
  }

  @Put(':id') save(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.drafts.save(actor, parse(uuid, id), body);
  }
}
