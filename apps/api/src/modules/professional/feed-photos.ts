import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hash, parse } from '../../common/security';
import { Database, Sql } from '../database/database';
import { validateImage, type MediaRow } from '../media/media';
import { ObjectStorage } from '../media/storage';
import { storeImageVariants, variantKeys } from '../media/image-variants';
import { feedPhotosSchema, type FeedPhotoInput } from './contracts';
import { FeedPhotoFetcher, type FeedImage } from './feed-photos-fetch';

export interface PreparedFeedPhoto {
  id: string;
  kind: FeedPhotoInput['kind'];
  sha256: string;
  mime: FeedImage['mime'];
  originalKey: string;
  variants: MediaRow['variants'];
}

@Injectable()
export class FeedPhotos {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly fetcher: FeedPhotoFetcher,
  ) {}

  async prepare(
    inputs: FeedPhotoInput[],
    heartbeat?: () => Promise<void>,
  ): Promise<PreparedFeedPhoto[]> {
    const photos = parse(feedPhotosSchema, inputs);
    const staged: string[] = [],
      prepared: PreparedFeedPhoto[] = [],
      digests = new Set<string>();
    try {
      for (const { url, kind } of photos) {
        await heartbeat?.();
        const { bytes, mime } = await this.fetcher.fetch(url);
        const id = randomUUID(),
          filename = id + '.' + mime.split('/')[1],
          originalKey = 'originals/' + filename;
        await validateImage(bytes, mime, filename);
        const sha256 = hash(bytes);
        if (digests.has(sha256))
          throw new BadRequestException(
            'В XML повторяется одно и то же изображение.',
          );
        digests.add(sha256);
        // A committed reservation owns every key before any external write, including a partial PUT.
        await this.db.pool.query(
          "INSERT INTO professional_photo_cleanup(media_id,object_keys,available_at) VALUES($1,$2,clock_timestamp()+interval '1 day')",
          [id, [originalKey, ...variantKeys(id)]],
        );
        staged.push(id);
        await this.storage.put(originalKey, bytes, mime);
        const variants = await storeImageVariants(
          this.storage,
          id,
          bytes,
          heartbeat,
        );
        prepared.push({ id, kind, sha256, mime, originalKey, variants });
      }
      return prepared;
    } catch (error) {
      await this.abandon(staged);
      throw error;
    }
  }

  async replace(
    sql: Sql,
    listingId: string,
    photos: PreparedFeedPhoto[],
  ): Promise<boolean> {
    const listing = await sql.query<{ seller_id: string }>(
      'SELECT seller_id FROM listings WHERE id=$1 FOR UPDATE',
      [listingId],
    );
    if (!listing.rowCount)
      throw new ConflictException(
        'Объявление для замены фотографий не найдено.',
      );
    const { rows } = await sql.query<{
      id: string;
      kind: FeedPhotoInput['kind'];
      content_sha256: string;
      feed_photo_position: number;
    }>(
      'SELECT id,kind,content_sha256,feed_photo_position FROM media WHERE listing_id=$1 AND feed_photo_position IS NOT NULL ORDER BY feed_photo_position,id FOR UPDATE',
      [listingId],
    );
    if (
      rows.length === photos.length &&
      rows.every(
        (row, i) =>
          row.content_sha256 === photos[i]!.sha256 &&
          row.kind === photos[i]!.kind,
      )
    )
      return false;
    const manual = await sql.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM media WHERE listing_id=$1 AND kind='photo' AND feed_photo_position IS NULL",
      [listingId],
    );
    if (
      manual.rows[0]!.count +
        photos.filter((photo) => photo.kind === 'photo').length >
      21
    )
      throw new BadRequestException(
        'В объявлении можно разместить до 21 фотографии.',
      );
    const reused = new Map(
      rows.map((row) => [row.kind + ':' + row.content_sha256, row]),
    );
    for (const [i, photo] of photos.entries()) {
      const key = photo.kind + ':' + photo.sha256;
      const saved = reused.get(key);
      if (saved) {
        if (saved.feed_photo_position !== i)
          await sql.query(
            'UPDATE media SET feed_photo_position=$2 WHERE id=$1',
            [saved.id, i],
          );
        reused.delete(key);
        continue;
      }
      const held = await sql.query(
        'DELETE FROM professional_photo_cleanup WHERE media_id=$1 AND NOT cleaning AND available_at>clock_timestamp() RETURNING media_id',
        [photo.id],
      );
      if (!held.rowCount)
        throw new ConflictException(
          'Срок подготовки фотографий истёк. Повторите импорт.',
        );
      await sql.query(
        "INSERT INTO media(id,listing_id,uploaded_by,kind,original_key,mime,state,variants,content_sha256,feed_photo_position) VALUES($1,$2,$3,$4,$5,$6,'ready',$7,$8,$9)",
        [
          photo.id,
          listingId,
          listing.rows[0]!.seller_id,
          photo.kind,
          photo.originalKey,
          photo.mime,
          JSON.stringify(photo.variants),
          photo.sha256,
          i,
        ],
      );
    }
    if (reused.size)
      await sql.query('DELETE FROM media WHERE id=ANY($1::uuid[])', [
        [...reused.values()].map((row) => row.id),
      ]);
    return true;
  }

  async release(photos: PreparedFeedPhoto[]) {
    await this.abandon(photos.map((photo) => photo.id));
  }
  private async abandon(ids: string[]) {
    if (!ids.length) return;
    // Promoted media no longer have a reservation. On a failed transaction all reservations remain.
    // The one-day deadline covers process termination and a database outage during eager cleanup.
    try {
      await this.db.pool.query(
        'UPDATE professional_photo_cleanup SET available_at=clock_timestamp() WHERE media_id=ANY($1::uuid[]) AND NOT cleaning',
        [ids],
      );
      await this.cleanup();
    } catch {
      console.error('feed_photo_cleanup_deferred');
    }
  }
  async cleanup(): Promise<void> {
    // Commit the claim before touching storage. All object deletes may safely run again after a crash.
    const results = await this.db.pool.query<{
      media_id: string;
      object_keys: string[];
    }>(
      `WITH due AS (SELECT media_id FROM professional_photo_cleanup WHERE available_at<=clock_timestamp() ORDER BY available_at LIMIT 48 FOR UPDATE SKIP LOCKED)
       UPDATE professional_photo_cleanup q SET cleaning=true,available_at=clock_timestamp()+interval '15 minutes'
       FROM due WHERE q.media_id=due.media_id RETURNING q.media_id,q.object_keys`,
    );
    for (let i = 0; i < results.rows.length; i += 6) {
      await Promise.all(
        results.rows.slice(i, i + 6).map(async (row) => {
          try {
            const deletions = await Promise.allSettled(
              row.object_keys.map((key) => this.storage.delete(key)),
            );
            if (deletions.some((result) => result.status === 'rejected')) {
              console.error('feed_photo_cleanup_deferred');
              return;
            }
            await this.db.pool.query(
              'DELETE FROM professional_photo_cleanup WHERE media_id=$1 AND cleaning',
              [row.media_id],
            );
          } catch {
            console.error('feed_photo_cleanup_deferred');
          }
        }),
      );
    }
  }
}
