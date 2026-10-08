import { ServiceUnavailableException } from '@nestjs/common';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';

const unavailable = () =>
  new ServiceUnavailableException('Verification delivery unavailable');
const sender = 'noreply@raui.ru';
const recipient = z
  .email()
  .max(254)
  .refine(
    (value) => !/[\r\n]/.test(value) && !value.includes(String.fromCharCode(0)),
  );
export interface ResetSmtpConfig {
  WEB_ORIGIN: string;
  RESET_SMTP_PASSWORD: string;
}
// A connector can supply an alternate network route; security options remain fixed here.
export type TlsConnector = (options: ConnectionOptions) => TLSSocket;
export async function sendResetSmtp(
  message: { destination: string; token: string },
  config: ResetSmtpConfig,
  connector: TlsConnector = connect,
): Promise<void> {
  let origin: URL;
  try {
    origin = new URL(config.WEB_ORIGIN);
  } catch {
    throw unavailable();
  }
  if (
    !recipient.safeParse(message.destination).success ||
    !/^[A-Za-z0-9_-]{43}$/.test(message.token) ||
    origin.protocol !== 'https:' ||
    origin.origin !== config.WEB_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw unavailable();
  let socket: TLSSocket | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const options: SMTPTransport.Options = {
    host: 'mail.nic.ru',
    port: 465,
    secure: true,
    pool: false,
    auth: { user: sender, pass: config.RESET_SMTP_PASSWORD },
    authMethod: 'LOGIN',
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    tls: {
      servername: 'mail.nic.ru',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    getSocket(_options, callback) {
      if (settled) {
        callback(unavailable(), {});
        return;
      }
      let called = false;
      const finish = (error: Error | null) => {
        if (called) return;
        called = true;
        if (settled || error) {
          socket?.destroy();
          callback(unavailable(), {});
        } else callback(null, { connection: socket, secured: true });
      };
      try {
        socket = connector({
          host: 'mail.nic.ru',
          port: 465,
          servername: 'mail.nic.ru',
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        });
        socket.once('error', () => finish(unavailable()));
        socket.once('secureConnect', () => finish(null));
      } catch {
        finish(unavailable());
      }
    },
  };
  const transport = nodemailer.createTransport(options);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        transport.close();
        if (error) reject(unavailable());
        else resolve();
      };
      timer = setTimeout(() => finish(unavailable()), 5000);
      transport.sendMail(
        {
          from: sender,
          to: message.destination,
          envelope: { from: sender, to: [message.destination] },
          subject: 'Восстановление пароля RAUI.RU',
          text: `Для восстановления пароля откройте ссылку:\n${origin.origin}/account/reset-password#token=${message.token}\n\nСсылка действует 15 минут. Если вы не запрашивали восстановление, проигнорируйте письмо.`,
          textEncoding: 'base64',
        },
        (error) => finish(error),
      );
    });
  } catch {
    throw unavailable();
  } finally {
    settled = true;
    clearTimeout(timer);
    socket?.destroy();
    transport.close();
  }
}
