import { createHmac } from 'node:crypto';

export function authenticatorCode(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = Buffer.alloc(20);
  let value = 0;
  let bits = 0;
  let offset = 0;
  for (const character of encoded) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      secret[offset++] = (value >>> bits) & 255;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  secret.fill(0);
  const index = digest.readUInt8(digest.length - 1) & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}
