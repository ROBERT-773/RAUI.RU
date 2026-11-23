import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  openStaffTotpSecret,
  sealStaffTotpSecret,
  matchingTotpStep,
} from './modules/auth/staff-totp';

const key = Buffer.from('12345678901234567890');

test('encrypts factor secrets with a fresh nonce and binds them to the account', () => {
  const encryptionKey = Buffer.alloc(32, 7);
  const sealed = sealStaffTotpSecret(key, encryptionKey, 'account-one');
  assert.notEqual(
    sealed,
    sealStaffTotpSecret(key, encryptionKey, 'account-one'),
  );
  assert.deepEqual(
    openStaffTotpSecret(sealed, encryptionKey, 'account-one'),
    key,
  );
  assert.throws(() =>
    openStaffTotpSecret(sealed, encryptionKey, 'account-two'),
  );
  assert.throws(() =>
    openStaffTotpSecret(sealed, Buffer.alloc(32, 8), 'account-one'),
  );
  assert.throws(() =>
    openStaffTotpSecret(sealed.slice(0, -4), encryptionKey, 'account-one'),
  );
});

test('matches the six-digit suffixes of the RFC 6238 SHA-1 vectors', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ] as const;
  for (const [second, code] of vectors)
    assert.equal(matchingTotpStep(key, code, second), Math.floor(second / 30));
});

test('accepts only an adjacent time step and rejects malformed codes', () => {
  assert.equal(matchingTotpStep(key, '287082', 30), 1);
  assert.equal(matchingTotpStep(key, '287082', 60), 1);
  assert.equal(matchingTotpStep(key, '287082', 90), null);
  assert.equal(matchingTotpStep(key, '287082', 86400), null);
  assert.equal(matchingTotpStep(key, '94287082', 59), null);
  assert.equal(matchingTotpStep(key, '287082 ', 59), null);
  assert.equal(matchingTotpStep(key, '287082\n', 59), null);
});
