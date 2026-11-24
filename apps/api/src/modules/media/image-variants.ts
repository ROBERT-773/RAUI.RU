import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
import type { ObjectStorage } from './storage';
import type { MediaRow } from './media';

const renditions = [
  ['thumb', 240, 'webp'],
  ['small', 800, 'webp'],
  ['large', 1600, 'webp'],
  ['avif', 1600, 'avif'],
] as const;
const objectKey = (id: string, name: string, format: string) =>
  `processed/${id}/${name}.${format}`;

export function variantKeys(id: string) {
  return renditions.map(([name, , format]) => objectKey(id, name, format));
}

export async function storeImageVariants(
  storage: ObjectStorage,
  id: string,
  bytes: Buffer,
  heartbeat?: () => Promise<void>,
) {
  const variants: MediaRow['variants'] = {};
  for (const [name, width, format] of renditions) {
    await heartbeat?.();
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .toFormat(format, { quality: format === 'avif' ? 55 : 80 })
      .toBuffer({ resolveWithObject: true })
      .catch(() => {
        throw new BadRequestException(
          'Не удалось прочитать пиксели изображения.',
        );
      });
    const key = objectKey(id, name, format),
      mime = 'image/' + format;
    await storage.put(key, data, mime);
    variants[name] = { key, width: info.width, height: info.height, mime };
  }
  return variants;
}
