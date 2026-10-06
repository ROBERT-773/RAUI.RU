import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function localDatabase(value) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    process.env.NODE_ENV === 'production'
  )
    throw new Error('Recovery drill requires explicit local development DB');
  return url;
}
export function restoreName(value) {
  if (!/^raui_restore_test_[a-f0-9]{16}$/.test(value))
    throw new Error('Fresh generated scratch restore database required');
  return value;
}
export function objectKey(value) {
  if (
    !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '.' || part === '..' || !part)
  )
    throw new Error('Unsafe object key');
  return value;
}
const aad = Buffer.from('raui-private-backup-v1');
export function cipherFor(key, nonce) {
  if (key.length !== 32 || nonce.length !== 12)
    throw new Error('Invalid backup key or nonce');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return cipher;
}
export function decipherFor(key, nonce, tag) {
  if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16)
    throw new Error('Invalid backup envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return decipher;
}
export function seal(bytes, key) {
  const nonce = randomBytes(12),
    cipher = cipherFor(key, nonce);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
export function open(envelope, key) {
  if (envelope.length < 28) throw new Error('Invalid backup envelope');
  const decipher = decipherFor(
    key,
    envelope.subarray(0, 12),
    envelope.subarray(12, 28),
  );
  return Buffer.concat([
    decipher.update(envelope.subarray(28)),
    decipher.final(),
  ]);
}

export async function cleanupRecovery(actions) {
  let failed = false;
  for (const action of [
    actions.drop,
    actions.end,
    actions.wipe,
    actions.remove,
  ]) {
    try {
      await action();
    } catch {
      failed = true;
    }
  }
  if (failed)
    throw new Error(
      'Recovery cleanup incomplete; inspect local scratch DB without restoring source',
    );
}

export function sequenceNextValue(sequence) {
  const last = BigInt(sequence.last_value);
  const increment = BigInt(sequence.increment_by);
  const min = BigInt(sequence.min_value);
  const max = BigInt(sequence.max_value);
  let next = sequence.is_called ? last + increment : last;
  if (next < min || next > max) {
    if (!sequence.cycle) throw new Error('Scratch sequence exhausted');
    next = increment > 0n ? min : max;
  }
  return next.toString();
}

export async function createRecoveryWorkspace(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(root + '/drill-');
  return {
    directory,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function publishRecoveryEvidence(output, action) {
  await rm(output, { force: true });
  const evidence = await action();
  const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(evidence, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}
