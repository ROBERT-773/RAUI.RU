import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.url(),
  DATABASE_URL: z
    .url()
    .refine((v) => ['postgres:', 'postgresql:'].includes(new URL(v).protocol)),
  REDIS_URL: z
    .url()
    .refine((v) => ['redis:', 'rediss:'].includes(new URL(v).protocol)),
});
export function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Invalid environment fields: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
