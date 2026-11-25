import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../../config';
import { sendEmailSignInSmtp } from './reset-smtp';

export function emailSignInAvailable(cfg = loadConfig()) {
  return (
    cfg.EMAIL_SIGN_IN_ENABLED === 'true' &&
    cfg.RESET_SMTP_ENABLED === 'true' &&
    Boolean(cfg.EMAIL_SIGN_IN_PEPPER && cfg.RESET_SMTP_PASSWORD)
  );
}
export abstract class EmailSignInDelivery {
  abstract send(destination: string, code: string): Promise<void>;
}
@Injectable()
export class ConfiguredEmailSignInDelivery extends EmailSignInDelivery {
  async send(destination: string, code: string) {
    const cfg = loadConfig();
    if (!emailSignInAvailable(cfg)) throw new ServiceUnavailableException();
    await sendEmailSignInSmtp(destination, code, cfg.RESET_SMTP_PASSWORD!);
  }
}
