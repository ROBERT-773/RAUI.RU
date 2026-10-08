import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '../../../lib/backend';
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    path[0] !== 'v1' ||
    ![
      'auth',
      'search',
      'listings',
      'account',
      'media',
      'geo',
      'regions',
      'catalog',
      'categories',
    ].includes(path[1] ?? '') ||
    path.some((s) => !/^[a-zA-Z0-9_-]+$/.test(s))
  )
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  const mutation = !['GET', 'HEAD'].includes(request.method);
  if (
    mutation &&
    request.headers.get('origin') !==
      (process.env.WEB_ORIGIN ?? new URL(request.url).origin)
  )
    return NextResponse.json({ message: 'Invalid origin' }, { status: 403 });
  const headers = new Headers();
  for (const key of [
    'cookie',
    'content-type',
    'x-csrf-token',
    'idempotency-key',
  ]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (mutation)
    headers.set(
      'origin',
      process.env.WEB_ORIGIN ?? new URL(request.url).origin,
    );
  try {
    const target = '/' + path.join('/') + request.nextUrl.search;
    const response = await backendFetch(target, request.headers, {
      method: request.method,
      headers,
      ...(mutation ? { body: await request.arrayBuffer() } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const output = new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    for (const cookie of response.headers.getSetCookie())
      output.headers.append('Set-Cookie', cookie);
    return output;
  } catch {
    return NextResponse.json(
      { message: 'Service unavailable' },
      { status: 503 },
    );
  }
}
export const GET = proxy,
  POST = proxy,
  PATCH = proxy,
  DELETE = proxy;
