import { Injectable } from '@nestjs/common';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { loadConfig } from '../../config';
import { publicIPv4, approvedHttpsUrl } from '../../common/outbound-policy';
import { ProviderPort } from './runtime';
export abstract class AiProvider implements ProviderPort {
  abstract generate(input: unknown, signal: AbortSignal): Promise<unknown>;
}
@Injectable()
export class GatewayAiProvider extends AiProvider {
  async generate(input: unknown, signal: AbortSignal) {
    const cfg = loadConfig();
    if (!cfg.AI_GATEWAY_URL || !cfg.AI_GATEWAY_TOKEN)
      throw new Error('unconfigured');
    // Operator-approved exact host plus all-answer DNS validation; no user-selected endpoint.
    const url = approvedHttpsUrl(
      cfg.AI_GATEWAY_URL,
      cfg.AI_ALLOWED_HOSTS.split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
    if (url.hostname.startsWith('[')) throw new Error('ai_endpoint_rejected');
    const addresses = await new Promise<{ address: string; family: number }[]>(
      (done, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('ai_dns_deadline'));
        }, 2000);
        const aborted = () => {
          cleanup();
          reject(new Error('ai_aborted'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
        };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) {
          aborted();
          return;
        }
        lookup(url.hostname, { all: true }).then(
          (values) => {
            cleanup();
            done(values);
          },
          () => {
            cleanup();
            reject(new Error('ai_dns_failed'));
          },
        );
      },
    );
    if (
      !addresses.length ||
      addresses.some((x) => x.family !== 4 || !publicIPv4(x.address))
    )
      throw new Error('ai_address_rejected');
    const requestId = (input as { requestId?: string }).requestId;
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId))
      throw new Error('ai_request_identity_required');
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 64000) throw new Error('ai_input_limit');
    return new Promise<unknown>((done, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          family: 4,
          agent: false,
          servername: url.hostname,
          rejectUnauthorized: true,
          signal,
          lookup: (_host, _options, callback) =>
            callback(null, addresses[0]!.address, 4),
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': requestId,
            Authorization: 'Bearer ' + cfg.AI_GATEWAY_TOKEN,
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !response.headers['content-type']?.startsWith('application/json')
          ) {
            response.destroy();
            reject(new Error('ai_response_rejected'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64000) {
              req.destroy();
              reject(new Error('ai_output_limit'));
            } else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('ai_response_failed')));
          response.on('aborted', () => reject(new Error('ai_response_failed')));
          response.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              let reflected = raw.includes(cfg.AI_GATEWAY_TOKEN!);
              const decoded: unknown = JSON.parse(
                raw,
                (key: string, value: unknown) => {
                  if (
                    key.includes(cfg.AI_GATEWAY_TOKEN!) ||
                    (typeof value === 'string' &&
                      value.includes(cfg.AI_GATEWAY_TOKEN!))
                  )
                    reflected = true;
                  return value;
                },
              );
              if (reflected) {
                reject(new Error('ai_response_rejected'));
                return;
              }
              done(decoded);
            } catch {
              reject(new Error('ai_invalid_json'));
            }
          });
        },
      );
      req.on('error', () => reject(new Error('ai_transport_failed')));
      req.end(body);
    });
  }
}
