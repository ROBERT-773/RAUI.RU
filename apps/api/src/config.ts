import { z } from 'zod';
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WEB_ORIGIN: z.url(),
    DATABASE_URL: z
      .url()
      .refine((v) =>
        ['postgres:', 'postgresql:'].includes(new URL(v).protocol),
      ),
    REDIS_URL: z
      .url()
      .refine((v) => ['redis:', 'rediss:'].includes(new URL(v).protocol)),
    OPENSEARCH_URL: z.url().default('http://127.0.0.1:9200'),
    OPENSEARCH_ALIAS: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{2,80}$/)
      .default('raui-listings'),
    OPENSEARCH_TOKEN: z.string().optional(),
    SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    LOCAL_PRIVATE_DIR: z.string().default('.cache/private'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('eu-central-1'),
    S3_BUCKET: z.string().optional(),
    CDN_BASE_URL: z.url().optional(),
    VERIFICATION_GATEWAY_URL: z
      .url()
      .refine((v) => new URL(v).protocol === 'https:')
      .optional(),
    VERIFICATION_GATEWAY_TOKEN: z.string().min(1).optional(),
    GEOCODER_URL: z
      .url()
      .refine((v) => new URL(v).protocol === 'https:')
      .optional(),
    GEOCODER_TOKEN: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      new URL(value.OPENSEARCH_URL).protocol !== 'https:'
    )
      context.addIssue({
        code: 'custom',
        path: ['OPENSEARCH_URL'],
        message: 'Production OpenSearch requires TLS',
      });
    if (
      value.NODE_ENV === 'production' &&
      value.S3_ENDPOINT &&
      new URL(value.S3_ENDPOINT).protocol !== 'https:'
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
    if (value.VERIFICATION_GATEWAY_URL && !value.VERIFICATION_GATEWAY_TOKEN)
      context.addIssue({
        code: 'custom',
        path: ['VERIFICATION_GATEWAY_TOKEN'],
        message: 'Gateway token required',
      });
    if (
      value.NODE_ENV === 'production' &&
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
