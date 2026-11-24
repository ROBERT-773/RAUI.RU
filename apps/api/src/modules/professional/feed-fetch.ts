import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { publicIPv4 } from '../../common/outbound-policy';
import { xmlFeedMaxBytes } from './feed-limits';
import { FeedLinkError } from './feed-link-error';
import type { XmlFeedDownload } from './feed-parser';
export { publicIPv4 } from '../../common/outbound-policy';
export abstract class FeedFetcher {
  abstract fetch(
    url: string,
    format?: string,
  ): Promise<string | XmlFeedDownload>;
}
export function validateFeedUrl(value: string, hosts: string[]) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    url.hostname.startsWith('[') ||
    isIP(url.hostname)
  )
    throw new BadRequestException('Approved HTTPS feed host required');
  if (!hosts.includes(url.hostname))
    throw new FeedLinkError(
      'feed_host_not_approved',
      'Feed host needs administrator approval',
    );
  return url;
}
export async function resolveFeedHost(
  hostname: string,
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (
    host,
  ) => lookup(host, { all: true }),
  timeoutMs = 3000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(hostname),
      new Promise<never>((_done, reject) => {
        timer = setTimeout(
          () => reject(new ServiceUnavailableException('Feed DNS deadline')),
          timeoutMs,
        );
      }),
    ]);
    if (!addresses.length || addresses.some((x) => !publicIPv4(x.address)))
      throw new ServiceUnavailableException('Feed address rejected');
    return addresses;
  } finally {
    clearTimeout(timer);
  }
}
@Injectable()
export class HttpsFeedFetcher extends FeedFetcher {
  async fetch(
    value: string,
    format?: string,
  ): Promise<string | XmlFeedDownload> {
    const hosts = (process.env.FEED_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const url = validateFeedUrl(value, hosts);
    const addresses = await resolveFeedHost(url.hostname);
    const selected = addresses[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new ServiceUnavailableException('Feed deadline'));
      }, 10000);
      const req = request(
        url,
        {
          method: 'GET',
          family: 4,
          agent: false,
          servername: url.hostname,
          rejectUnauthorized: true,
          headers: {
            Accept: 'application/json,text/csv,application/xml,text/xml',
          },
          lookup: (_host, _options, done) => done(null, selected.address, 4),
        },
        (res) => {
          const contentType = res.headers['content-type'] ?? '';
          const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
          if (
            res.statusCode !== 200 ||
            ![
              'application/json',
              'text/csv',
              'application/xml',
              'text/xml',
            ].includes(mime)
          ) {
            req.destroy();
            clearTimeout(timer);
            reject(new ServiceUnavailableException('Feed response rejected'));
            return;
          }
          let size = 0;
          const maxBytes =
            format === 'xml' ||
            (format === undefined &&
              (mime === 'application/xml' || mime === 'text/xml'))
              ? xmlFeedMaxBytes
              : 2_000_000;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new ServiceUnavailableException('Feed too large'));
            } else chunks.push(chunk);
          });
          res.on('error', () => {
            clearTimeout(timer);
            reject(new ServiceUnavailableException('Feed response failed'));
          });
          res.on('end', () => {
            clearTimeout(timer);
            const bytes = Buffer.concat(chunks);
            resolve(
              format === 'xml'
                ? { bytes, contentType }
                : bytes.toString('utf8'),
            );
          });
        },
      );
      req.on('error', () => {
        clearTimeout(timer);
        reject(new ServiceUnavailableException('Feed unavailable'));
      });
      req.end();
    });
  }
}
