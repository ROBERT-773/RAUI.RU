import { Injectable, Module } from '@nestjs/common';
import sharp from 'sharp';
import { Database } from '../database/database';
import { Audit } from '../audit/audit';
import { ObjectStorage, StorageModule } from './storage';
import type { MediaRow } from './media';
@Injectable()
export class MediaWorker {
  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly audit: Audit,
  ) {}
  async once() {
    const job = await this.db.transaction(async (sql) => {
      const [claimed] = await this.db.rows<{
        id: string;
        media_id: string;
        attempts: number;
      }>(
        `SELECT * FROM media_jobs WHERE (state='pending' AND available_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [],
        sql,
      );
      if (!claimed) return null;
      if (claimed.attempts >= 3) {
        await sql.query(
          "UPDATE media_jobs SET state='dead',lease_until=NULL,last_error='lease_expired' WHERE id=$1",
          [claimed.id],
        );
        await sql.query("UPDATE media SET state='failed' WHERE id=$1", [
          claimed.media_id,
        ]);
        await this.audit.record(
          sql,
          null,
          'media.dead',
          'media',
          claimed.media_id,
          { reason: 'lease_expired' },
        );
        return null;
      }
      await sql.query(
        "UPDATE media_jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes' WHERE id=$1",
        [claimed.id],
      );
      await sql.query("UPDATE media SET state='processing' WHERE id=$1", [
        claimed.media_id,
      ]);
      return { ...claimed, attempts: claimed.attempts + 1 };
    });
    if (!job) return false;
    try {
      const [media] = await this.db.rows<MediaRow>(
        'SELECT * FROM media WHERE id=$1',
        [job.media_id],
      );
      const bytes = await this.storage.get(media!.original_key);
      const variants: MediaRow['variants'] = {};
      for (const [name, width, format] of [
        ['thumb', 240, 'webp'],
        ['small', 800, 'webp'],
        ['large', 1600, 'webp'],
        ['avif', 1600, 'avif'],
      ] as const) {
        const { data, info } = await sharp(bytes, {
          limitInputPixels: 40_000_000,
        })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .toFormat(format, { quality: format === 'avif' ? 55 : 80 })
          .toBuffer({ resolveWithObject: true });
        const key = `processed/${media!.id}/${name}.${format}`;
        await this.storage.put(key, data, `image/${format}`);
        variants[name] = {
          key,
          width: info.width,
          height: info.height,
          mime: `image/${format}`,
        };
      }
      await this.db.transaction(async (sql) => {
        const result = await sql.query(
          "UPDATE media_jobs SET state='done',lease_until=NULL WHERE id=$1 AND state='running' AND attempts=$2 RETURNING id",
          [job.id, job.attempts],
        );
        if (!result.rowCount) return;
        await sql.query(
          "UPDATE media SET state='ready',variants=$2 WHERE id=$1",
          [job.media_id, JSON.stringify(variants)],
        );
        await this.audit.record(
          sql,
          null,
          'media.processed',
          'media',
          job.media_id,
          { variants: Object.keys(variants) },
        );
      });
    } catch {
      await this.db.transaction(async (sql) => {
        const terminal = job.attempts >= 3;
        const result = await sql.query(
          "UPDATE media_jobs SET state=$2,available_at=now()+$3*interval '1 second',lease_until=NULL,last_error='processing_failed' WHERE id=$1 AND state='running' AND attempts=$4 RETURNING id",
          [
            job.id,
            terminal ? 'dead' : 'pending',
            Math.pow(2, job.attempts) * 5,
            job.attempts,
          ],
        );
        if (!result.rowCount) return;
        await sql.query('UPDATE media SET state=$2 WHERE id=$1', [
          job.media_id,
          terminal ? 'failed' : 'queued',
        ]);
        await this.audit.record(
          sql,
          null,
          terminal ? 'media.dead' : 'media.retry',
          'media',
          job.media_id,
          { attempt: job.attempts },
        );
      });
    }
    return true;
  }
}
@Module({
  imports: [StorageModule],
  providers: [MediaWorker],
  exports: [MediaWorker],
})
export class WorkerModule {}
