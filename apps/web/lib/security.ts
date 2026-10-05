export function publicOrigin(
  value: string | undefined,
  production = false,
): string {
  if (!value && production) throw new Error('Public site origin required');
  const raw = value ?? 'http://localhost:3000';
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    raw !== url.origin ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && loopback && !production))
  )
    throw new Error('Invalid public site origin');
  return url.origin;
}
export function jsonLd(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return encoded.replace(
      /[<>&\u2028\u2029]/g,
      (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  } catch {
    throw new Error('Invalid structured data');
  }
}
export function contentSecurityPolicy(
  nonce: string,
  options: { tileUrl?: string; development?: boolean; https?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9+/]{22,43}={0,2}$/.test(nonce))
    throw new Error('Invalid security nonce');
  let tileOrigin = '';
  if (options.tileUrl) {
    const wildcard = options.tileUrl.includes('://{s}.');
    const url = new URL(options.tileUrl.replace('://{s}.', '://a.'));
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/^[a-z0-9.-]+$/.test(url.hostname)
    )
      throw new Error('Invalid tile origin');
    tileOrigin = wildcard ? url.origin.replace('://a.', '://*.') : url.origin;
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${tileOrigin ? ' ' + tileOrigin : ''}`,
    "font-src 'self' data:",
    `connect-src 'self'${options.development ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
