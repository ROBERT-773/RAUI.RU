import { BadRequestException } from '@nestjs/common';
export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Idempotency key is required');
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw new BadRequestException('Invalid idempotency key');
  return key;
}
