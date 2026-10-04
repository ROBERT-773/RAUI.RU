import { Injectable, Module, BadRequestException } from '@nestjs/common';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { loadConfig } from '../../config';
export abstract class ObjectStorage {
  abstract put(key: string, bytes: Buffer, mime: string): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
}
function validKey(key: string) {
  if (!/^[a-z0-9][a-z0-9/-]*\.[a-z0-9]+$/.test(key) || key.includes('..'))
    throw new BadRequestException('Invalid storage key');
  return key;
}
export abstract class MediaDelivery {
  abstract url(id: string, variant: string): string;
}
@Injectable()
export class ConfiguredMediaDelivery extends MediaDelivery {
  url(id: string, variant: string) {
    const base = loadConfig().CDN_BASE_URL;
    const path = `/v1/media/${id}/${variant}`;
    return base ? base.replace(/\/$/, '') + path : path;
  }
}
@Injectable()
export class ConfiguredStorage extends ObjectStorage {
  private readonly config = loadConfig();
  private readonly s3 =
    this.config.STORAGE_DRIVER === 's3'
      ? new S3Client({
          ...(this.config.S3_ENDPOINT
            ? { endpoint: this.config.S3_ENDPOINT }
            : {}),
          region: this.config.S3_REGION,
          forcePathStyle: true,
          maxAttempts: 2,
        })
      : null;
  private path(key: string) {
    return resolve(this.config.LOCAL_PRIVATE_DIR, 'objects', validKey(key));
  }
  async put(key: string, bytes: Buffer, mime: string) {
    validKey(key);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: mime,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return;
    }
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  async get(key: string) {
    validKey(key);
    if (!this.s3) return readFile(this.path(key));
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    return Buffer.from(await response.Body!.transformToByteArray());
  }
  async delete(key: string) {
    validKey(key);
    if (this.s3) {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      return;
    }
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
@Module({
  providers: [
    { provide: ObjectStorage, useClass: ConfiguredStorage },
    { provide: MediaDelivery, useClass: ConfiguredMediaDelivery },
  ],
  exports: [ObjectStorage, MediaDelivery],
})
export class StorageModule {}
