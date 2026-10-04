import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Post,
  Res,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import {
  Actor,
  CurrentActor,
  Idempotency,
  Public,
  parse,
  seller,
  uuid,
} from '../../common/security';
import { Database, Sql } from '../database/database';
import { Audit } from '../audit/audit';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { ObjectStorage, StorageModule, MediaDelivery } from './storage';
export const uploadSchema = z
  .object({
    listingId: uuid,
    kind: z.enum(['photo', 'floor_plan']).default('photo'),
    filename: z.string().regex(/^[^/\\]{1,200}\.(jpg|jpeg|png|webp)$/i),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    base64: z
      .string()
      .min(1)
      .max(14_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export async function validateImage(
  bytes: Buffer,
  mime: string,
  filename: string,
) {
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024)
    throw new BadRequestException('Image must be at most 10 MiB');
  const extension = filename.split('.').pop()!.toLowerCase();
  const expected =
    mime === 'image/jpeg' ? 'jpeg' : mime === 'image/png' ? 'png' : 'webp';
  if ((extension === 'jpg' ? 'jpeg' : extension) !== expected)
    throw new BadRequestException('Extension/MIME mismatch');
  try {
    const metadata = await sharp(bytes, {
      limitInputPixels: 40_000_000,
      animated: false,
    }).metadata();
    if (
      metadata.format !== expected ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error();
    return metadata;
  } catch {
    throw new BadRequestException('Invalid or unsafe image');
  }
}
export interface MediaRow {
  id: string;
  listing_id: string;
  original_key: string;
  mime: string;
  state: string;
  variants: Record<
    string,
    { key: string; width: number; height: number; mime: string }
  >;
}
@Injectable()
export class Media {
  constructor(
    private readonly db: Database,
    private readonly access: ListingAccess,
    private readonly storage: ObjectStorage,
    private readonly delivery: MediaDelivery,
    private readonly audit: Audit,
    private readonly idem: Idempotency,
  ) {}
  async upload(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    const input = parse(uploadSchema, body);
    const bytes = Buffer.from(input.base64, 'base64');
    await validateImage(bytes, input.mime, input.filename);
    let uploaded: string | undefined;
    try {
      return await this.idem.run(
        actor,
        'media.upload',
        key,
        input,
        async (sql) => {
          const listing = await this.access.get(
            actor,
            input.listingId,
            sql,
            true,
          );
          if (!['draft', 'paused', 'rejected'].includes(listing.status))
            throw new ConflictException('Listing must be editable');
          const id = randomUUID(),
            objectKey = `originals/${id}.${input.mime.split('/')[1]}`;
          await this.storage.put(objectKey, bytes, input.mime);
          uploaded = objectKey;
          const [row] = await this.db.rows<MediaRow>(
            'INSERT INTO media(id,listing_id,uploaded_by,kind,original_key,mime) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [id, input.listingId, actor.id, input.kind, objectKey, input.mime],
            sql,
          );
          await sql.query('INSERT INTO media_jobs(media_id) VALUES($1)', [id]);
          await sql.query(
            "UPDATE listings SET status='draft',version=version+1,updated_at=now() WHERE id=$1",
            [listing.id],
          );
          await this.audit.history(
            sql,
            actor.id,
            listing.id,
            'listing.media.added',
            { status: listing.status, version: listing.version },
            { mediaId: id, status: 'draft', version: listing.version + 1 },
          );
          return { id: row!.id, state: row!.state };
        },
        (sql) => this.access.get(actor, input.listingId, sql),
      );
    } catch (error) {
      if (uploaded)
        await this.storage
          .delete(uploaded)
          .catch(() => console.error('media_orphan_cleanup_failed'));
      throw error;
    }
  }
  async list(actor: Actor, listingId: string) {
    await this.access.get(actor, listingId);
    return this.db.rows(
      'SELECT id,kind,state,variants,created_at FROM media WHERE listing_id=$1 ORDER BY created_at LIMIT 100',
      [listingId],
    );
  }
  async publicAssets(sql: Sql, listingId: string) {
    const rows = await this.db.rows<MediaRow & { kind: string }>(
      "SELECT id,kind,variants FROM media WHERE listing_id=$1 AND state='ready' ORDER BY created_at LIMIT 100",
      [listingId],
      sql,
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      variants: Object.fromEntries(
        Object.entries(row.variants).map(([name, value]) => [
          name,
          {
            width: value.width,
            height: value.height,
            mime: value.mime,
            url: this.delivery.url(row.id, name),
          },
        ]),
      ),
    }));
  }
  async ready(sql: Sql, listingId: string) {
    const [row] = await this.db.rows<{ ready: string; pending: string }>(
      "SELECT count(*) FILTER(WHERE state='ready') AS ready,count(*) FILTER(WHERE state<>'ready') AS pending FROM media WHERE listing_id=$1",
      [listingId],
      sql,
    );
    if (Number(row!.ready) < 1 || Number(row!.pending) > 0)
      throw new ConflictException(
        'At least one ready image and no pending/failed media required',
      );
  }
  async content(
    actor: Actor | undefined,
    id: string,
    variant: string,
    res: Response,
  ) {
    const [row] = await this.db.rows<MediaRow>(
      'SELECT * FROM media WHERE id=$1',
      [parse(uuid, id)],
    );
    if (!row) throw new NotFoundException();
    if (!(await this.access.visible(row.listing_id))) {
      if (!actor) throw new NotFoundException();
      await this.access.get(actor, row.listing_id);
    }
    const item = row.variants[variant];
    if (row.state !== 'ready' || !item) throw new NotFoundException();
    res.setHeader('Content-Type', item.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(item.key));
  }
}
@Controller('v1/media')
export class MediaController {
  constructor(private readonly media: Media) {}
  @Post() upload(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.media.upload(actor, body, key);
  }
  @Get('listing/:id') list(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ) {
    return this.media.list(actor, parse(uuid, id));
  }
  @Public() @Get(':id/:variant') content(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('variant') variant: string,
    @Res() res: Response,
  ) {
    return this.media.content(
      actor,
      id,
      parse(z.enum(['thumb', 'small', 'large', 'avif']), variant),
      res,
    );
  }
}
@Module({
  imports: [ListingAccessModule, StorageModule],
  controllers: [MediaController],
  providers: [Media, Idempotency],
  exports: [Media],
})
export class MediaModule {}
