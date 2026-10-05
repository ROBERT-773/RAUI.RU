import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy } from './lib/security';
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64');
  const csp = contentSecurityPolicy(nonce, {
    ...(process.env.NEXT_PUBLIC_MAP_TILE_URL
      ? { tileUrl: process.env.NEXT_PUBLIC_MAP_TILE_URL }
      : {}),
    development: process.env.NODE_ENV === 'development',
    https: process.env.DEPLOYMENT_ENV === 'production',
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|health|robots.txt|sitemap.xml).*)',
  ],
};
