import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const api = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001';
const database = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(new URL(api).hostname) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  process.env.NODE_ENV === 'production' ||
  process.env.STORAGE_DRIVER === 's3' ||
  process.env.VERIFICATION_GATEWAY_URL
)
  throw new Error(
    'Core smoke requires local development API/database/adapters',
  );
const suffix = randomBytes(6).toString('hex'),
  password = randomBytes(24).toString('base64url');
async function call(path, method = 'GET', body, session, key) {
  const response = await fetch(`${api}/v1${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: `Bearer ${session.sessionToken}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${method} ${path} failed: ${response.status}`);
  return response.json();
}
async function challenge(destination, purpose) {
  const text = await readFile(
    resolve(
      process.env.LOCAL_PRIVATE_DIR ?? '.cache/private',
      'verification/messages.jsonl',
    ),
    'utf8',
  );
  const messages = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return messages
    .reverse()
    .find(
      (message) =>
        message.destination === destination && message.purpose === purpose,
    ).token;
}
async function user(prefix) {
  const email = `${prefix}-${suffix}@example.test`;
  await call('/auth/register', 'POST', {
    email,
    password,
    displayName: 'Local core smoke',
    role: 'owner',
  });
  await call('/auth/verification/email/confirm', 'POST', {
    token: await challenge(email, 'email'),
  });
  const session = await call('/auth/login', 'POST', {
    email,
    password,
    transport: 'bearer',
  });
  const phone = `+7${BigInt('0x' + randomBytes(4).toString('hex'))
    .toString()
    .padStart(10, '0')}`;
  await call('/auth/verification/phone', 'POST', { phone }, session);
  await call(
    '/auth/verification/phone/confirm',
    'POST',
    { token: await challenge(phone, 'phone') },
    session,
  );
  return { email, session };
}
const owner = await user('owner'),
  moderator = await user('moderator');
// Explicit local operator bootstrap; never allowed by an unauthenticated HTTP request.
execFileSync(
  process.execPath,
  ['dist/modules/auth/bootstrap-admin.js', moderator.email],
  { stdio: 'pipe' },
);
moderator.session = await call('/auth/login', 'POST', {
  email: moderator.email,
  password,
  transport: 'bearer',
});
const property = await call(
  '/properties',
  'POST',
  {
    category: 'apartment',
    address: {
      formatted: 'Москва, Тверская, smoke',
      locality: 'Москва',
      longitude: 37.6173,
      latitude: 55.7558,
    },
    attributes: { area: 50 },
  },
  owner.session,
  randomUUID(),
);
let listing = await call(
  '/listings',
  'POST',
  {
    propertyId: property.id,
    dealType: 'sale',
    title: 'Локальная smoke-проверка',
    price: 10000000,
  },
  owner.session,
  randomUUID(),
);
assert.notEqual(listing.id, property.id);
assert.equal(
  (
    await call(
      `/listings/${listing.id}/source`,
      'GET',
      undefined,
      owner.session,
    )
  ).kind,
  'direct',
);
const image = await sharp({
  create: { width: 48, height: 32, channels: 3, background: '#336699' },
})
  .png()
  .toBuffer();
const uploaded = await call(
  '/media',
  'POST',
  {
    listingId: listing.id,
    kind: 'photo',
    filename: 'smoke.png',
    mime: 'image/png',
    base64: image.toString('base64'),
  },
  owner.session,
  randomUUID(),
);
let ready = false;
for (let i = 0; i < 100; i++) {
  const assets = await call(
    `/media/listing/${listing.id}`,
    'GET',
    undefined,
    owner.session,
  );
  if (assets.find((asset) => asset.id === uploaded.id)?.state === 'ready') {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(ready, 'Separate media worker must process the image');
listing = await call(
  `/listings/${listing.id}`,
  'GET',
  undefined,
  owner.session,
);
listing = await call(
  `/listings/${listing.id}/transitions`,
  'POST',
  { version: listing.version, status: 'processing' },
  owner.session,
  randomUUID(),
);
listing = await call(
  `/listings/${listing.id}/transitions`,
  'POST',
  { version: listing.version, status: 'moderation' },
  owner.session,
  randomUUID(),
);
const pending = (
  await call('/admin/moderation', 'GET', undefined, moderator.session)
).find((item) => item.listing_id === listing.id);
await call(
  `/admin/moderation/${pending.id}/decision`,
  'POST',
  { decision: 'approve', reason: 'Local built-service smoke' },
  moderator.session,
  randomUUID(),
);
const published = await call(`/listings/${listing.id}/public`);
assert.equal(published.id, listing.id);
assert.ok(published.media[0].variants.thumb.url);
assert.equal((await fetch(`${api}/v1/media/${uploaded.id}/thumb`)).status, 200);
await call('/auth/logout-all', 'POST', {}, owner.session);
assert.equal(
  (
    await fetch(`${api}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${owner.session.sessionToken}` },
    })
  ).status,
  401,
);
await call('/auth/logout-all', 'POST', {}, moderator.session);
console.log(
  'Built-service core smoke passed: real local delivery, auth, domain entities, separate media worker, moderation, publication and revocation',
);
