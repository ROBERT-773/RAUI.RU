import { headerNames, normalizeIp, signIdentity } from '@raui/config/ingress';

// Server transport only: node:crypto prevents accidental use in client bundles.
export async function backendFetch(
  target: string,
  incoming: Headers,
  options: RequestInit = {},
) {
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('Trusted ingress unavailable');
  }
  const production = process.env.DEPLOYMENT_ENV === 'production';
  const secret = process.env.PROXY_IDENTITY_SECRET;
  const ingressHeader = process.env.TRUSTED_INGRESS_IP_HEADER;
  const ip = ingressHeader ? normalizeIp(incoming.get(ingressHeader)) : null;
  if (
    !target.startsWith('/v1/') ||
    /\s/.test(target) ||
    url.origin !== base ||
    url.username ||
    url.password ||
    !['https:', 'http:'].includes(url.protocol) ||
    (production &&
      (!secret || !ingressHeader || !ip || url.protocol !== 'https:'))
  )
    throw new Error('Trusted ingress unavailable');
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  for (const name of headerNames) headers.delete(name);
  if (secret && ip)
    for (const [name, value] of Object.entries(
      signIdentity(method, target, ip, secret),
    ))
      headers.set(name, value);
  return fetch(base + target, {
    ...options,
    method,
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
}
