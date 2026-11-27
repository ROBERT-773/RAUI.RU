import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  hash,
  parse,
  Public,
  uuid,
} from '../../common/security';
import { Database } from '../database/database';

export const ticketTopics = z.enum([
  'login',
  'listing',
  'moderation',
  'photos',
  'complaint',
  'ownership',
  'xml',
  'commercial',
  'other',
]);
const message = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes('\0'), 'Unsupported character');
export const ticketReceipt = z.strictObject({ receipt: z.uuidv4() });
export const ticketInput = ticketReceipt.extend({
  topic: ticketTopics,
  message,
  listingId: uuid.optional(),
});
export const ticketAnswer = z.strictObject({ reply: message });
const queueQuery = z.strictObject({
  after: uuid.optional(),
  topic: ticketTopics.optional(),
});
const projection =
  'id,topic,message,listing_id AS "listingId",created_at AS "createdAt",reply,replied_at AS "repliedAt"';
type Ticket = {
  id: string;
  topic: z.infer<typeof ticketTopics>;
  message: string;
  listingId: string | null;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
};

@Injectable()
export class SupportTickets {
  constructor(private readonly db: Database) {}

  submit(input: z.infer<typeof ticketInput>) {
    const digest = hash(input.receipt);
    return this.db.transaction(async (sql) => {
      const result = await sql.query<{ id: string }>(
        `INSERT INTO support_tickets(receipt_hash,topic,message,listing_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(receipt_hash) DO NOTHING RETURNING id`,
        [digest, input.topic, input.message, input.listingId ?? null],
      );
      if (result.rows[0]) return result.rows[0];
      const existing = await sql.query<{ id: string }>(
        `SELECT id FROM support_tickets WHERE receipt_hash=$1 AND topic=$2 AND message=$3
        AND listing_id IS NOT DISTINCT FROM $4::uuid`,
        [digest, input.topic, input.message, input.listingId ?? null],
      );
      if (!existing.rows[0])
        throw new ConflictException(
          'Для другого обращения откройте новую форму.',
        );
      return existing.rows[0];
    });
  }

  async read(receipt: string) {
    const [row] = await this.db.rows<Ticket>(
      `SELECT ${projection} FROM support_tickets WHERE receipt_hash=$1`,
      [hash(receipt)],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  async queue({ after, topic }: z.infer<typeof queueQuery>) {
    const rows = await this.db.rows<Ticket>(
      `SELECT ${projection} FROM support_tickets
      WHERE reply IS NULL AND ($1::text IS NULL OR topic=$1)
      AND ($2::uuid IS NULL OR (created_at,id) > (SELECT created_at,id FROM support_tickets WHERE id=$2))
      ORDER BY created_at,id LIMIT 26`,
      [topic ?? null, after ?? null],
    );
    const items = rows.slice(0, 25);
    return { items, nextCursor: rows.length > 25 ? items.at(-1)!.id : null };
  }

  answer(id: string, reply: string, actor: Actor) {
    return this.db.transaction(async (sql) => {
      const result = await sql.query<{ reply: string | null }>(
        'SELECT reply FROM support_tickets WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!result.rows[0]) throw new NotFoundException();
      if (result.rows[0].reply === reply) return { answered: true };
      if (result.rows[0].reply !== null)
        throw new ConflictException('На обращение уже ответили.');
      await sql.query(
        'UPDATE support_tickets SET reply=$2,replied_at=now(),replied_by=$3 WHERE id=$1',
        [id, reply, actor.id],
      );
      return { answered: true };
    });
  }
}

@Controller('v1')
export class SupportController {
  constructor(private readonly tickets: SupportTickets) {}

  @Public()
  @Post('support/tickets')
  @Header('Cache-Control', 'private, no-store')
  submit(@Body() body: unknown) {
    return this.tickets.submit(parse(ticketInput, body));
  }

  @Public()
  @Post('support/tickets/status')
  @Header('Cache-Control', 'private, no-store')
  status(@Body() body: unknown) {
    return this.tickets.read(parse(ticketReceipt, body).receipt);
  }

  @AdminOnly()
  @Get('admin/support')
  @Header('Cache-Control', 'private, no-store')
  queue(@Query() query: unknown) {
    return this.tickets.queue(parse(queueQuery, query));
  }

  @AdminOnly()
  @Post('admin/support/:id/reply')
  @Header('Cache-Control', 'private, no-store')
  answer(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.tickets.answer(
      parse(uuid, id),
      parse(ticketAnswer, body).reply,
      actor,
    );
  }
}
