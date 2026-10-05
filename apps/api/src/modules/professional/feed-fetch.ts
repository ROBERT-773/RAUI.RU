import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
// Deliberately IPv4-only until an equally strict IPv6 policy is supported.
export function publicIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 &&
      (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export abstract class FeedFetcher {
  abstract fetch(url: string): Promise<string>;
}
export function validateFeedUrl(value: string, hosts: string[]) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hosts.includes(url.hostname) ||
    isIP(url.hostname)
  )
    throw new BadRequestException('Approved HTTPS feed host required');
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
  async fetch(value: string): Promise<string> {
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
          headers: {
            Accept: 'application/json,text/csv,application/xml,text/xml',
          },
          lookup: (_host, _options, done) => done(null, selected.address, 4),
        },
        (res) => {
          if (
            res.statusCode !== 200 ||
            ![
              'application/json',
              'text/csv',
              'application/xml',
              'text/xml',
            ].some((t) => (res.headers['content-type'] ?? '').includes(t))
          ) {
            req.destroy();
            clearTimeout(timer);
            reject(new ServiceUnavailableException('Feed response rejected'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) {
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
            resolve(Buffer.concat(chunks).toString('utf8'));
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
