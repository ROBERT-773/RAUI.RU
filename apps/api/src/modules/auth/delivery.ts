import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isProduction, loadConfig } from '../../config';
export interface VerificationMessage {
  destination: string;
  purpose: 'email' | 'phone' | 'reset';
  token: string;
}
export abstract class VerificationDelivery {
  abstract send(message: VerificationMessage): Promise<void>;
}
@Injectable()
export class ConfiguredDelivery extends VerificationDelivery {
  async send(message: VerificationMessage) {
    const config = loadConfig();
    if (config.VERIFICATION_GATEWAY_URL) {
      try {
        const response = await fetch(config.VERIFICATION_GATEWAY_URL, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.VERIFICATION_GATEWAY_TOKEN}`,
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Rejected delivery');
      } catch {
        throw new ServiceUnavailableException(
          'Verification delivery unavailable',
        );
      }
      return;
    }
    if (isProduction(config))
      throw new ServiceUnavailableException(
        'Verification provider not configured',
      );
    const directory = resolve(config.LOCAL_PRIVATE_DIR, 'verification');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(directory, 'messages.jsonl'),
      JSON.stringify(message) + '\n',
      { mode: 0o600 },
    );
  }
}
