import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, parse, uuid } from '../../common/security';
import { Database } from '../database/database';
import { publicEligibility } from '../listings/access';

export const adminDirectorySearchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(320)
      .regex(/[\p{L}\p{N}]/u)
      .refine((value) => !value.includes('\0'), 'Unsupported character'),
    after: uuid.optional(),
  })
  .strict();

const publicId = z.string().regex(/^[1-9][0-9]*$/);
function publicIdForSearch(value: string) {
  return /^[1-9]\d{0,18}$/.test(value) &&
    (value.length < 19 || value <= '9223372036854775807')
    ? value
    : null;
}
export const adminListingDirectorySearchSchema = adminDirectorySearchSchema
  .extend({ by: z.literal('seller').optional() })
  .refine((input) => !input.by || publicIdForSearch(input.query) !== null, {
    path: ['query'],
    message: 'Invalid seller ID',
  });
const userRow = z.object({
  id: uuid,
  publicId,
  name: z.string(),
  email: z.string(),
  role: z.enum(['buyer', 'owner', 'agent', 'agency', 'developer', 'admin']),
  active: z.boolean(),
  matchedPhone: z.string().nullable(),
});
const listingRow = z.object({
  id: uuid,
  title: z.string(),
  address: z.string(),
  price: z.string().nullable(),
  area: z.string().nullable(),
  floor: z.string().nullable(),
  status: z.enum([
    'draft',
    'processing',
    'moderation',
    'published',
    'paused',
    'archived',
    'sold',
    'rented',
    'rejected',
  ]),
  dealType: z.enum(['sale', 'long_rent', 'short_rent']),
  sellerPublicId: publicId,
  publiclyVisible: z.boolean(),
});
export const adminUserSearchResultSchema = z.object({
  items: z.array(userRow),
  nextCursor: uuid.nullable(),
});
export const adminListingSearchResultSchema = z.object({
  items: z.array(listingRow),
  nextCursor: uuid.nullable(),
});

const pageSize = 25;
function page<T extends { id: string }>(rows: T[]) {
  const items = rows.slice(0, pageSize);
  return {
    items,
    nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null,
  };
}

function phoneForSearch(query: string) {
  const compact = query.replace(/[\s()-]/g, '');
  if (/^(?:\+7|8|7)\d{10}$/.test(compact)) return '+7' + compact.slice(-10);
  // A partial Russian number must never match an abbreviated login phone.
  return /^\+[1-689]\d{7,14}$/.test(compact) ? compact : null;
}

@AdminOnly()
@Controller('v1/admin/search')
export class AdminDirectorySearch {
  constructor(private readonly db: Database) {}

  @Post('users')
  @HttpCode(200)
  async users(@Body() body: unknown) {
    const { query, after } = parse(adminDirectorySearchSchema, body);
    const numericId = publicIdForSearch(query);
    const phone = phoneForSearch(query);
    const loginSpellings = [phone];
    if (phone?.startsWith('+7')) {
      loginSpellings.push(phone.slice(1), '8' + phone.slice(2));
    }
    const email = query.includes('@') ? query.toLowerCase() : null;
    const name = email || /^[+\d\s()-]+$/.test(query) ? null : query;
    // The unique (user_id,phone) key permits at most one verified contact
    // row, even when the user's login number also appears in slot zero.
    const rows = await this.db.rows<z.infer<typeof userRow>>(
      `SELECT u.id, u.public_id::text AS "publicId", u.display_name AS name, u.email,
              u.role, u.active, CASE WHEN login.matched OR cp.id IS NOT NULL THEN $3 END AS "matchedPhone"
       FROM users u
       CROSS JOIN LATERAL (
         SELECT CASE WHEN $3::text IS NOT NULL THEN
           u.phone=$3 OR regexp_replace(u.phone,'[[:space:]()\u00a0\u202f-]','','g')=ANY($7::text[])
         END AS matched
       ) login
       LEFT JOIN seller_contact_phones cp ON cp.user_id=u.id AND cp.phone=$3
       WHERE ($1::uuid IS NULL OR u.id>$1)
         AND (u.public_id=$2::bigint OR login.matched OR cp.id IS NOT NULL OR u.email=$4
           OR strpos(lower(u.display_name),lower($5))>0)
       ORDER BY u.id LIMIT $6`,
      [
        after ?? null,
        numericId,
        phone,
        email,
        name,
        pageSize + 1,
        loginSpellings,
      ],
    );
    return page(rows);
  }

  @Post('listings')
  @HttpCode(200)
  async listings(@Body() body: unknown) {
    const { query, after, by } = parse(adminListingDirectorySearchSchema, body);
    const id = uuid.safeParse(query);
    const condition =
      by === 'seller'
        ? 'u.public_id=$2::bigint'
        : id.success
          ? 'l.id=$2::uuid'
          : '(strpos(lower(l.title),lower($2))>0 OR strpos(lower(a.formatted),lower($2))>0)';
    const rows = await this.db.rows<z.infer<typeof listingRow>>(
      `SELECT l.id,l.title,a.formatted AS address,l.status,l.deal_type AS "dealType",
              l.price::text AS price,p.attributes->>'area' AS area,p.attributes->>'floor' AS floor,
              u.public_id::text AS "sellerPublicId", (${publicEligibility}) AS "publiclyVisible"
       FROM listings l JOIN properties p ON p.id=l.property_id JOIN addresses a ON a.id=p.address_id
       JOIN users u ON u.id=l.seller_id
       WHERE ($1::uuid IS NULL OR l.id>$1) AND ${condition} ORDER BY l.id LIMIT $3`,
      [after ?? null, query, pageSize + 1],
    );
    return page(rows);
  }
}
