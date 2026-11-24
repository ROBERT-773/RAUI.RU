import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Header,
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
  Public,
  uuid,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { Listing, ListingAccess, publicEligibility } from './access';

type ContactMode = 'messages' | 'calls' | 'both';
type Phone = { id: string; phone: string };
type Settings = {
  canEdit: boolean;
  mode: ContactMode;
  phones: Phone[];
  selectedPhoneIds: string[];
};
export const listingContactSelectionSchema = z
  .object({
    phoneIds: z.array(uuid).max(2),
    expectedPhoneIds: z.array(uuid).max(2).optional(),
  })
  .strict();
const selectedPhones = `FROM listing_contact_phones selection
  JOIN seller_contact_phones phone ON (phone.user_id,phone.id)=(selection.seller_id,selection.phone_id)
  WHERE selection.listing_id=l.id AND selection.seller_id=l.seller_id`;

function sameSelection(current: string[], other: string[]) {
  return (
    current.length === other.length && current.every((id, i) => id === other[i])
  );
}

function requirePhone() {
  throw new BadRequestException({
    statusCode: 400,
    code: 'LISTING_CONTACT_PHONE_REQUIRED',
    message: 'Для звонков выберите хотя бы один подтверждённый номер.',
  });
}
function invalidSelection(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: 'INVALID_LISTING_CONTACT_PHONES',
    message:
      'Выберите до двух разных подтверждённых номеров из своего профиля.',
  });
}

/** A single statement applies the public listing and contact policies to the same snapshot. */
async function visiblePhones(sql: Sql, id: string) {
  const {
    rows: [row],
  } = await sql.query<{ mode: ContactMode; phones: Phone[] }>(
    `SELECT u.contact_mode AS mode,CASE WHEN u.contact_mode='messages' THEN '[]'::jsonb
      ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('id',phone.id,'phone',phone.phone) ORDER BY selection.position)
        ${selectedPhones}),'[]'::jsonb) END AS phones FROM listings l JOIN users u ON u.id=l.seller_id
      WHERE l.id=$1 AND ${publicEligibility}`,
    [id],
  );
  return row;
}

export async function publicListingContact(sql: Sql, id: string) {
  const row = await visiblePhones(sql, id);
  if (!row) throw new NotFoundException();
  return {
    messagesAllowed: row.mode !== 'calls',
    phones: row.phones.map((p) => p.phone),
  };
}

/** Before property/listing locks, serialize against profile changes and phone withdrawal. */
export async function lockContactSeller(sql: Sql, listingId: string) {
  const {
    rows: [author],
  } = await sql.query<{ id: string; contact_mode: ContactMode }>(
    'SELECT u.id,u.contact_mode FROM users u JOIN listings l ON l.seller_id=u.id WHERE l.id=$1 FOR SHARE OF u',
    [listingId],
  );
  if (!author) throw new NotFoundException();
  return author;
}

export async function requirePublicationContact(sql: Sql, listing: Listing) {
  const {
    rows: [row],
  } = await sql.query<{ missing: boolean }>(
    `SELECT u.contact_mode<>'messages' AND NOT EXISTS(SELECT 1 ${selectedPhones}) AS missing
      FROM users u JOIN listings l ON l.seller_id=u.id WHERE l.id=$1 AND u.id=$2`,
    [listing.id, listing.seller_id],
  );
  if (!row) throw new NotFoundException();
  if (row.missing) requirePhone();
}

@Injectable()
export class ListingContacts {
  constructor(
    private readonly db: Database,
    private readonly access: ListingAccess,
    private readonly audit: Audit,
  ) {}
  private async settings(
    sql: Sql,
    listing: Listing,
    actor: Actor,
  ): Promise<Settings> {
    if (listing.seller_id !== actor.id) {
      const visible = await visiblePhones(sql, listing.id);
      const phones = visible?.phones ?? [];
      const mode =
        visible?.mode ??
        (
          await sql.query<{ mode: ContactMode }>(
            'SELECT contact_mode AS mode FROM users WHERE id=$1',
            [listing.seller_id],
          )
        ).rows[0]?.mode;
      if (!mode) throw new NotFoundException();
      return {
        canEdit: false,
        mode,
        phones,
        selectedPhoneIds: phones.map((p) => p.id),
      };
    }
    const {
      rows: [settings],
    } = await sql.query<Omit<Settings, 'canEdit'>>(
      `SELECT u.contact_mode AS mode,
        COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'phone',p.phone) ORDER BY p.slot) FILTER(WHERE p.id IS NOT NULL),'[]'::jsonb) AS phones,
        COALESCE(array_agg(p.id ORDER BY c.position) FILTER(WHERE c.position IS NOT NULL),'{}'::uuid[]) AS "selectedPhoneIds"
       FROM users u LEFT JOIN seller_contact_phones p ON p.user_id=u.id
       LEFT JOIN listing_contact_phones c ON c.seller_id=u.id AND c.phone_id=p.id AND c.listing_id=$2
       WHERE u.id=$1 GROUP BY u.id`,
      [listing.seller_id, listing.id],
    );
    if (!settings) throw new NotFoundException();
    return { canEdit: true, ...settings };
  }
  get(actor: Actor, id: string) {
    return this.db.transaction(async (sql) => {
      const listing = await this.access.get(actor, id, sql);
      return this.settings(sql, listing, actor);
    });
  }
  set(actor: Actor, id: string, body: unknown) {
    const parsed = listingContactSelectionSchema.safeParse(body);
    if (!parsed.success) invalidSelection();
    const phoneIds = parsed.data.phoneIds.map((phoneId) =>
      phoneId.toLowerCase(),
    );
    const expected = parsed.data.expectedPhoneIds?.map((phoneId) =>
      phoneId.toLowerCase(),
    );
    if (
      new Set(phoneIds).size !== phoneIds.length ||
      (expected && new Set(expected).size !== expected.length)
    )
      invalidSelection();
    return this.db.transaction(async (sql) => {
      // Only the author may delegate a private number to their listing. Lock our own profile first.
      await sql.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [
        actor.id,
      ]);
      const listing = await this.access.get(actor, id, sql, true);
      if (listing.seller_id !== actor.id) throw new ForbiddenException();
      const current = await this.settings(sql, listing, actor);
      if (phoneIds.some((id) => !current.phones.some((p) => p.id === id)))
        invalidSelection();
      if (sameSelection(current.selectedPhoneIds, phoneIds)) return current;
      if (expected && !sameSelection(current.selectedPhoneIds, expected))
        throw new ConflictException({
          statusCode: 409,
          code: 'LISTING_CONTACT_SELECTION_CHANGED',
          message:
            'Контакты изменились. Проверьте номера и подтвердите выбор ещё раз.',
        });
      if (
        phoneIds.length === 0 &&
        current.mode !== 'messages' &&
        ['published', 'moderation'].includes(listing.status)
      )
        requirePhone();
      await sql.query(
        'DELETE FROM listing_contact_phones WHERE listing_id=$1',
        [id],
      );
      if (phoneIds.length)
        await sql.query(
          `INSERT INTO listing_contact_phones(listing_id,seller_id,phone_id,position)
         SELECT $1,$2,phone_id,position FROM unnest($3::uuid[]) WITH ORDINALITY AS chosen(phone_id,position)`,
          [id, actor.id, phoneIds],
        );
      if (
        ['draft', 'processing', 'paused', 'rejected'].includes(listing.status)
      ) {
        await sql.query(
          'UPDATE listings SET version=version+1,updated_at=now() WHERE id=$1',
          [id],
        );
      }
      await this.audit.record(
        sql,
        actor.id,
        'listing.contacts.changed',
        'listing',
        id,
        { phoneCount: phoneIds.length },
      );
      return { ...current, selectedPhoneIds: phoneIds };
    });
  }
}

@Controller('v1/listings')
export class ListingContactController {
  constructor(
    private readonly contacts: ListingContacts,
    private readonly db: Database,
  ) {}
  @Public()
  @Get(':id/public/contact')
  @Header('Cache-Control', 'private, no-store')
  public(@Param('id') id: string) {
    return publicListingContact(this.db.pool, parse(uuid, id));
  }
  @Get(':id/contact-settings')
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.contacts.get(actor, parse(uuid, id));
  }
  @Put(':id/contact-settings')
  @Header('Cache-Control', 'private, no-store')
  set(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.contacts.set(actor, parse(uuid, id), body);
  }
}
