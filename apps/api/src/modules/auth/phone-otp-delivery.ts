import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { loadConfig, phoneOtpCapability, validPhoneOtpUrl } from '../../config';
import { publicIPv4 } from '../../common/outbound-policy';
export type PhoneOtpDispatch = 'accepted' | 'unavailable' | 'unknown';
export interface PhoneOtpMessage {
  version: 1;
  challengeId: string;
  destination: string;
  code: string;
  expiresAt: string;
}
export abstract class PhoneOtpDelivery {
  abstract send(message: PhoneOtpMessage): Promise<PhoneOtpDispatch>;
}
export function classifyPhoneOtpAcknowledgment(
  status: number,
  body: string,
  id: string,
): PhoneOtpDispatch {
  if (status >= 400 && status < 500 && status !== 408) return 'unavailable';
  if (status !== 202 || Buffer.byteLength(body) > 4096) return 'unknown';
  try {
    const ack: unknown = JSON.parse(body);
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return 'unknown';
    const fields = ack as Record<string, unknown>;
    return Object.keys(fields).length === 3 &&
      fields.version === 1 &&
      fields.challengeId === id &&
      fields.accepted === true
      ? 'accepted'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
export async function resolvePhoneOtpGateway(
  host: string,
  resolver: typeof lookup = lookup,
) {
  const addresses = await resolver(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((x) => x.family !== 4 || !publicIPv4(x.address))
  )
    throw new Error('phone_otp_gateway_rejected');
  return addresses[0]!;
}
@Injectable()
export class ConfiguredPhoneOtpDelivery extends PhoneOtpDelivery {
  async send(message: PhoneOtpMessage): Promise<PhoneOtpDispatch> {
    const cfg = loadConfig();
    if (!phoneOtpCapability(cfg).available) return 'unavailable';
    const signal = AbortSignal.timeout(5000);
    try {
      if (!validPhoneOtpUrl(cfg.PHONE_OTP_GATEWAY_URL!)) return 'unavailable';
      const url = new URL(cfg.PHONE_OTP_GATEWAY_URL!);
      const address = await Promise.race([
        resolvePhoneOtpGateway(url.hostname),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('phone_otp_timeout')),
            { once: true },
          ),
        ),
      ]);
      return await new Promise<PhoneOtpDispatch>((resolve) => {
        const req = request(
          url,
          {
            method: 'POST',
            agent: false,
            family: 4,
            servername: url.hostname,
            rejectUnauthorized: true,
            signal,
            lookup: (_host, _options, done) => done(null, address.address, 4),
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.PHONE_OTP_GATEWAY_TOKEN!}`,
              'Idempotency-Key': message.challengeId,
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (status !== 202) {
              response.destroy();
              resolve(
                classifyPhoneOtpAcknowledgment(status, '', message.challengeId),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 4096) {
                response.destroy();
                resolve('unknown');
              } else chunks.push(chunk);
            });
            response.on('error', () => resolve('unknown'));
            response.on('aborted', () => resolve('unknown'));
            response.on('end', () =>
              resolve(
                classifyPhoneOtpAcknowledgment(
                  status,
                  Buffer.concat(chunks).toString('utf8'),
                  message.challengeId,
                ),
              ),
            );
          },
        );
        req.on('error', () => resolve('unknown'));
        req.end(JSON.stringify(message));
      });
    } catch {
      return 'unknown';
    }
  }
}
