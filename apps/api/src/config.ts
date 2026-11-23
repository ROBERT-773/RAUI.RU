import { z } from 'zod';
import { isIP } from 'node:net';
import { normalizeIp } from '@raui/config/ingress';
export function isProduction(value: {
  NODE_ENV: string;
  DEPLOYMENT_ENV?: string;
}): boolean {
  return (
    value.NODE_ENV === 'production' || value.DEPLOYMENT_ENV === 'production'
  );
}
function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
export function validPhoneOtpUrl(value: string): boolean {
  const url = safeUrl(value);
  return (
    !!url &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (!url.port || url.port === '443') &&
    !isIP(url.hostname) &&
    !url.hostname.startsWith('[') &&
    url.hostname.includes('.')
  );
}
export function validPhoneOtpPepper(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').length >= 32 &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}
export function phoneOtpCapability(config: {
  PHONE_OTP_ENABLED: string;
  PHONE_OTP_PEPPER?: string | undefined;
  PHONE_OTP_GATEWAY_URL?: string | undefined;
  PHONE_OTP_GATEWAY_TOKEN?: string | undefined;
}): { available: boolean; reason: 'available' | 'disabled' | 'unconfigured' } {
  if (config.PHONE_OTP_ENABLED !== 'true')
    return { available: false, reason: 'disabled' };
  return config.PHONE_OTP_PEPPER &&
    config.PHONE_OTP_GATEWAY_URL &&
    config.PHONE_OTP_GATEWAY_TOKEN
    ? { available: true, reason: 'available' }
    : { available: false, reason: 'unconfigured' };
}
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DEPLOYMENT_ENV: z.enum(['local', 'staging', 'production']).default('local'),
    PROXY_IDENTITY_SECRET: z
      .string()
      .regex(/^[\x21-\x7e]{32,256}$/)
      .optional(),
    TRUSTED_PROXY_PEERS: z.string().default(''),
    TRUSTED_INGRESS_IP_HEADER: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional(),
    SITE_URL: z.url().optional(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WEB_ORIGIN: z.url(),
    DATABASE_URL: z
      .url()
      .refine((v) =>
        ['postgres:', 'postgresql:'].includes(safeUrl(v)?.protocol ?? ''),
      ),
    REDIS_URL: z
      .url()
      .refine((v) =>
        ['redis:', 'rediss:'].includes(safeUrl(v)?.protocol ?? ''),
      ),
    OPENSEARCH_URL: z.url().default('http://127.0.0.1:9200'),
    OPENSEARCH_ALIAS: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{2,80}$/)
      .default('raui-listings'),
    OPENSEARCH_TOKEN: z.string().optional(),
    FEED_ALLOWED_HOSTS: z.string().default(''),
    AI_ENABLED: z.enum(['true', 'false']).default('false'),
    AI_GATEWAY_URL: z
      .url()
      .refine(
        (v) =>
          safeUrl(v)?.protocol === 'https:' &&
          !safeUrl(v)?.username &&
          !safeUrl(v)?.password,
      )
      .optional(),
    AI_GATEWAY_TOKEN: z.string().min(16).optional(),
    AI_ALLOWED_HOSTS: z.string().default(''),
    AI_CALL_CAP_MICROS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000000)
      .default(100000),
    AI_DAILY_BUDGET_MICROS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000000000)
      .default(1000000),
    NOTIFICATION_GATEWAY_URL: z
      .url()
      .refine(
        (v) =>
          safeUrl(v)?.protocol === 'https:' &&
          !safeUrl(v)?.username &&
          !safeUrl(v)?.password,
      )
      .optional(),
    NOTIFICATION_GATEWAY_TOKEN: z.string().min(16).optional(),
    SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    LOCAL_PRIVATE_DIR: z.string().default('.cache/private'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('eu-central-1'),
    S3_BUCKET: z.string().optional(),
    CDN_BASE_URL: z
      .url()
      .refine((value) => {
        const url = safeUrl(value);
        return (
          !!url &&
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'CDN base requires clean credential-free HTTP(S) URL')
      .optional(),
    PHONE_OTP_ENABLED: z.enum(['true', 'false']).default('false'),
    PHONE_OTP_PEPPER: z
      .string()
      .max(1024)
      .refine(validPhoneOtpPepper)
      .optional(),
    PHONE_OTP_GATEWAY_URL: z
      .string()
      .max(2048)
      .refine(validPhoneOtpUrl)
      .optional(),
    PHONE_OTP_GATEWAY_TOKEN: z
      .string()
      .min(16)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    RESET_SMTP_ENABLED: z.enum(['true', 'false']).default('false'),
    RESET_SMTP_PASSWORD: z.string().min(1).optional(),
    VERIFICATION_GATEWAY_URL: z
      .url()
      .refine((v) => safeUrl(v)?.protocol === 'https:')
      .optional(),
    VERIFICATION_GATEWAY_TOKEN: z.string().min(1).optional(),
    GEOCODER_URL: z
      .url()
      .refine((v) => safeUrl(v)?.protocol === 'https:')
      .optional(),
    GEOCODER_TOKEN: z.string().optional(),
  })
  .superRefine((value, context) => {
    const production = isProduction(value);
    const reject = (field: string, message: string) =>
      context.addIssue({ code: 'custom', path: [field], message });
    if (value.RESET_SMTP_ENABLED === 'true') {
      if (!value.RESET_SMTP_PASSWORD)
        reject('RESET_SMTP_PASSWORD', 'Reset SMTP credentials required');
      const origin = safeUrl(value.WEB_ORIGIN);
      if (
        origin?.protocol !== 'https:' ||
        origin.username ||
        origin.password ||
        origin.origin !== value.WEB_ORIGIN
      )
        reject('WEB_ORIGIN', 'Reset SMTP requires a clean HTTPS origin');
    }
    if (
      value.TRUSTED_PROXY_PEERS &&
      value.TRUSTED_PROXY_PEERS.split(',').some(
        (peer) => !normalizeIp(peer.trim()),
      )
    )
      reject(
        'TRUSTED_PROXY_PEERS',
        'Exact trusted proxy IP addresses required',
      );
    if (production) {
      if (!value.PROXY_IDENTITY_SECRET)
        reject(
          'PROXY_IDENTITY_SECRET',
          'Production proxy authentication required',
        );
      if (!value.TRUSTED_PROXY_PEERS)
        reject(
          'TRUSTED_PROXY_PEERS',
          'Production trusted proxy peers required',
        );
      if (!value.TRUSTED_INGRESS_IP_HEADER)
        reject(
          'TRUSTED_INGRESS_IP_HEADER',
          'Production trusted ingress header required',
        );
      const origin = (raw: string | undefined) => {
        if (!raw) return false;
        const url = safeUrl(raw);
        return (
          url?.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          url.origin === raw
        );
      };
      if (!origin(value.WEB_ORIGIN))
        reject('WEB_ORIGIN', 'Production requires a clean public HTTPS origin');
      if (!origin(value.SITE_URL) || value.SITE_URL !== value.WEB_ORIGIN)
        reject(
          'SITE_URL',
          'Production site must match the public HTTPS origin',
        );
      const db = safeUrl(value.DATABASE_URL);
      const tlsKeys = [...(db?.searchParams.keys() ?? [])].filter((key) =>
        key.toLowerCase().startsWith('ssl'),
      );
      if (
        !db ||
        db.searchParams.getAll('sslmode').length !== 1 ||
        db.searchParams.get('sslmode') !== 'verify-full' ||
        tlsKeys.some(
          (key) =>
            !['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(key),
        )
      )
        reject(
          'DATABASE_URL',
          'Production PostgreSQL requires verified TLS without override parameters',
        );
      if (safeUrl(value.REDIS_URL)?.protocol !== 'rediss:')
        reject('REDIS_URL', 'Production Redis requires TLS');
      if (!value.OPENSEARCH_TOKEN || value.OPENSEARCH_TOKEN.length < 16)
        reject('OPENSEARCH_TOKEN', 'Production search authentication required');
      for (const field of [
        'OPENSEARCH_URL',
        'S3_ENDPOINT',
        'CDN_BASE_URL',
      ] as const) {
        const raw = value[field];
        if (raw) {
          const url = safeUrl(raw);
          if (!url || url.protocol !== 'https:' || url.username || url.password)
            reject(
              field,
              'Production service requires credential-free HTTPS URL',
            );
        }
      }
    }
    if (production && safeUrl(value.OPENSEARCH_URL)?.protocol !== 'https:')
      context.addIssue({
        code: 'custom',
        path: ['OPENSEARCH_URL'],
        message: 'Production OpenSearch requires TLS',
      });
    if (
      production &&
      value.S3_ENDPOINT &&
      safeUrl(value.S3_ENDPOINT)?.protocol !== 'https:'
    )
      context.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message: 'Production S3 requires TLS',
      });
    if (value.STORAGE_DRIVER === 's3' && !value.S3_BUCKET)
      context.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'S3 bucket required',
      });
    if (value.AI_GATEWAY_URL && !value.AI_GATEWAY_TOKEN)
      context.addIssue({
        code: 'custom',
        path: ['AI_GATEWAY_TOKEN'],
        message: 'AI gateway token required',
      });
    if (value.NOTIFICATION_GATEWAY_URL && !value.NOTIFICATION_GATEWAY_TOKEN)
      context.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_GATEWAY_TOKEN'],
        message: 'Notification token required',
      });
    if (value.VERIFICATION_GATEWAY_URL && !value.VERIFICATION_GATEWAY_TOKEN)
      context.addIssue({
        code: 'custom',
        path: ['VERIFICATION_GATEWAY_TOKEN'],
        message: 'Gateway token required',
      });
    if (
      production &&
      (value.STORAGE_DRIVER !== 's3' || !value.VERIFICATION_GATEWAY_URL)
    )
      context.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: 'Production requires object storage and verification provider',
      });
  });
export function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Invalid environment fields: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
