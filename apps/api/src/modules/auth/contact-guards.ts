import { ConflictException } from '@nestjs/common';
import { Sql } from '../database/database';
// The caller holds the user's row lock. A forced withdrawal of verification
// bypasses this voluntary-change check and the migration clears the selection.
export async function guardLoginPhoneChange(
  sql: Sql,
  userId: string,
  nextPhone: string,
) {
  const {
    rows: [primary],
  } = await sql.query<{ id: string }>(
    `SELECT p.id FROM users u JOIN seller_contact_phones p ON p.user_id=u.id AND p.slot=0
     WHERE u.id=$1 AND u.contact_mode='calls' AND p.phone<>$2`,
    [userId, nextPhone],
  );
  if (primary) await requireLivePhone(sql, userId, primary.id);
}
export async function requireLivePhone(
  sql: Sql,
  userId: string,
  removing: string | null,
) {
  const { rows } = await sql.query<{
    id: string;
    title: string;
    total: number;
  }>(
    `SELECT l.id,l.title,count(*) OVER()::int AS total FROM listings l
       WHERE l.seller_id=$1 AND l.status IN ('published','moderation')
       AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM listing_contact_phones used
          WHERE used.listing_id=l.id AND used.phone_id=$2))
       AND NOT EXISTS (SELECT 1 FROM listing_contact_phones other WHERE other.listing_id=l.id
          AND ($2::uuid IS NULL OR other.phone_id<>$2))
       ORDER BY l.id LIMIT 20`,
    [userId, removing],
  );
  if (rows.length)
    throw new ConflictException({
      code: 'contact_phone_required',
      message:
        'Выберите номер для звонков в этих объявлениях или разрешите сообщения.',
      total: rows[0]!.total,
      listings: rows.map(({ id, title }) => ({ id, title })),
    });
}
