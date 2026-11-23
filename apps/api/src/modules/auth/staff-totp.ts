import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const nonceSize = 12;
const tagSize = 16;
const secretSize = 20;

export function sealStaffTotpSecret(
  secret: Buffer,
  key: Buffer,
  accountId: string,
): string {
  if (secret.length !== secretSize) throw new Error('Invalid TOTP secret size');
  const nonce = randomBytes(nonceSize);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('raui-staff-totp:v1:' + accountId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

export function openStaffTotpSecret(
  sealed: string,
  key: Buffer,
  accountId: string,
): Buffer {
  const data = Buffer.from(sealed, 'base64url');
  if (
    data.length !== nonceSize + tagSize + secretSize ||
    data.toString('base64url') !== sealed
  )
    throw new Error('Invalid encrypted TOTP secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    data.subarray(0, nonceSize),
  );
  decipher.setAAD(Buffer.from('raui-staff-totp:v1:' + accountId));
  decipher.setAuthTag(data.subarray(nonceSize, nonceSize + tagSize));
  return Buffer.concat([
    decipher.update(data.subarray(nonceSize + tagSize)),
    decipher.final(),
  ]);
}

export function matchingTotpStep(
  key: Buffer,
  code: string,
  unixSeconds: number,
): number | null {
  if (
    code.length !== 6 ||
    !/^\d{6}$/.test(code) ||
    !Number.isSafeInteger(unixSeconds) ||
    unixSeconds < 0
  )
    return null;

  const current = Math.floor(unixSeconds / 30);
  const supplied = Buffer.from(code, 'ascii');
  const counter = Buffer.alloc(8);
  for (const step of [current, current + 1, current - 1]) {
    if (step < 0) continue;
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest.readUInt8(digest.length - 1) & 0xf;
    const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    const expected = Buffer.from(String(value).padStart(6, '0'), 'ascii');
    if (timingSafeEqual(supplied, expected)) return step;
  }
  return null;
}
