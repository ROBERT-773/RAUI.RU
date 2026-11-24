import { BadRequestException, Injectable } from '@nestjs/common';
import { request } from 'node:https';
import { resolveFeedHost, validateFeedUrl } from './feed-fetch';

const photoMimes = ['image/jpeg', 'image/png', 'image/webp'] as const;
type ImageMime = (typeof photoMimes)[number];
const imageMime = (input: string): input is ImageMime =>
  photoMimes.some((type) => input === type);
export interface FeedImage {
  bytes: Buffer;
  mime: ImageMime;
}

@Injectable()
export class FeedPhotoFetcher {
  async fetch(source: string): Promise<FeedImage> {
    const hosts = (
      process.env.FEED_MEDIA_ALLOWED_HOSTS ??
      process.env.FEED_ALLOWED_HOSTS ??
      ''
    )
      .split(',')
      .map((value) => value.trim());
    let url: URL;
    try {
      url = validateFeedUrl(source, hosts);
    } catch {
      throw new BadRequestException(
        'Нужна ссылка HTTPS на изображение с разрешённого сервером хоста.',
      );
    }
    const [address] = await resolveFeedHost(url.hostname);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          family: 4,
          agent: false,
          servername: url.hostname,
          rejectUnauthorized: true,
          headers: { Accept: photoMimes.join(',') },
          lookup: (_hostname, _options, done) =>
            done(null, address!.address, 4),
          signal: AbortSignal.timeout(10_000),
        },
        (res) => {
          const mime = (res.headers['content-type'] ?? '')
            .split(';', 1)[0]!
            .trim()
            .toLowerCase();
          if (res.statusCode !== 200 || !imageMime(mime)) {
            reject(
              new BadRequestException(
                'Источник должен вернуть изображение JPEG, PNG или WebP по прямой ссылке.',
              ),
            );
            res.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('error', () =>
            reject(
              new BadRequestException('Не удалось загрузить изображение.'),
            ),
          );
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 10 * 1024 * 1024) {
              reject(
                new BadRequestException('Размер фотографии превышает 10 МиБ.'),
              );
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ bytes: Buffer.concat(chunks), mime }));
        },
      );
      req.on('error', () =>
        reject(new BadRequestException('Не удалось загрузить изображение.')),
      );
      req.end();
    });
  }
}
