import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  parse,
  uuid,
} from '../../common/security';
import { Database } from '../database/database';

export const feedbackInput = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((text) => !text.includes('\0'), 'Unsupported character'),
    requestId: uuid,
  })
  .strict();
const feedbackQuery = z
  .object({
    cursor: z
      .string()
      .length(64)
      .transform((value) => value.split('~'))
      .pipe(
        z.tuple([
          z.iso
            .datetime({ precision: 6 })
            .refine((time) => !time.startsWith('0000')),
          uuid,
        ]),
      )
      .optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]\d?|100)$/)
      .optional(),
  })
  .strict();
interface FeedbackItem {
  id: string;
  message: string;
  createdAt: string;
  authorId: string;
}

@Controller('v1')
export class FeedbackController {
  constructor(private readonly db: Database) {}

  @Post('account/feedback')
  @Header('Cache-Control', 'private, no-store')
  submit(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const { message, requestId } = parse(feedbackInput, body);
    return this.db.transaction(async (sql) => {
      const added = await sql.query<{ id: string }>(
        `INSERT INTO portal_feedback(author_id,request_id,message) VALUES($1,$2,$3)
         ON CONFLICT(author_id,request_id) DO NOTHING RETURNING id`,
        [actor.id, requestId, message],
      );
      if (added.rows[0]) return added.rows[0];
      // The conflict may have waited for another transaction to commit.
      // A separate READ COMMITTED statement can see that successful submission.
      const {
        rows: [original],
      } = await sql.query<{ id: string; message: string }>(
        'SELECT id,message FROM portal_feedback WHERE author_id=$1 AND request_id=$2',
        [actor.id, requestId],
      );
      if (!original || original.message !== message)
        throw new ConflictException({
          code: 'feedback_request_conflict',
          message: 'С этим идентификатором уже отправлено другое предложение.',
        });
      return { id: original.id };
    });
  }

  @AdminOnly()
  @Get('admin/feedback')
  @Header('Cache-Control', 'private, no-store')
  async inbox(@Query() query: unknown) {
    const { cursor, limit } = parse(feedbackQuery, query);
    const pageSize = Number(limit ?? 25);
    // Carry both ordering values so pagination survives deletion of the previous row.
    const after = cursor
      ? 'WHERE (f.created_at,f.id) < ($2::timestamptz,$3::uuid)'
      : '';
    const items = await this.db.rows<FeedbackItem>(
      `SELECT f.id,f.message,to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",u.public_id::text AS "authorId" FROM portal_feedback f
       JOIN users u ON u.id=f.author_id ${after} ORDER BY f.created_at DESC,f.id DESC LIMIT $1`,
      cursor ? [pageSize + 1, ...cursor] : [pageSize + 1],
    );
    const more = items.length > pageSize;
    if (more) items.pop();
    const last = items.at(-1);
    return {
      items,
      nextCursor: more && last ? `${last.createdAt}~${last.id}` : null,
    };
  }
}
