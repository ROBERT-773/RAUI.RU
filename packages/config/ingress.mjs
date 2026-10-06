import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
export const headerNames = [
  'x-raui-client-ip',
  'x-raui-forwarded-at',
  'x-raui-forwarded-signature',
];
export function normalizeIp(value) {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%'))
    return null;
  const ip =
    value.startsWith('::ffff:') && isIP(value.slice(7)) === 4
      ? value.slice(7)
      : value;
  if (!isIP(ip)) return null;
  return isIP(ip) === 4 ? ip : new URL(`http://[${ip}]`).hostname.slice(1, -1);
}
export function signIdentity(method, target, ip, secret, at = Date.now()) {
  ip = normalizeIp(ip);
  if (
    !ip ||
    typeof secret !== 'string' ||
    !/^[\x21-\x7e]{32,256}$/.test(secret) ||
    !/^[A-Z]{3,10}$/.test(method) ||
    typeof target !== 'string' ||
    !target.startsWith('/v1/') ||
    target.length > 4096 ||
    /\s/.test(target) ||
    !Number.isSafeInteger(at) ||
    at < 0
  )
    throw new Error('Invalid forwarding contract');
  const time = String(at);
  return {
    [headerNames[0]]: ip,
    [headerNames[1]]: time,
    [headerNames[2]]: createHmac('sha256', secret)
      .update(JSON.stringify([1, method, target, ip, time]))
      .digest('hex'),
  };
}
export function verifyIdentity(
  headers,
  method,
  target,
  secret,
  now = Date.now(),
) {
  try {
    const ip = headers[headerNames[0]],
      time = headers[headerNames[1]],
      signature = headers[headerNames[2]];
    if (
      typeof time !== 'string' ||
      !/^[0-9]{13}$/.test(time) ||
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      normalizeIp(ip) !== ip ||
      Math.abs(now - Number(time)) > 30000
    )
      return null;
    const expected = signIdentity(method, target, ip, secret, Number(time))[
      headerNames[2]
    ];
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    )
      ? ip
      : null;
  } catch {
    return null;
  }
}
