import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '../../../lib/backend';
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const isUuid = (value: string | undefined) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value ?? '',
    );
  const propertyRoute =
    path[1] === 'properties' &&
    ((path.length === 2 && request.method === 'POST') ||
      (path.length === 3 &&
        isUuid(path[2]) &&
        ['GET', 'PATCH'].includes(request.method)));
  const moderationRoute =
    path[1] === 'admin' &&
    path[2] === 'moderation' &&
    ((path.length === 3 && request.method === 'GET') ||
      (path.length === 5 &&
        isUuid(path[3]) &&
        ((path[4] === 'materials' && request.method === 'GET') ||
          (path[4] === 'decision' && request.method === 'POST'))) ||
      (path.length === 7 &&
        isUuid(path[3]) &&
        path[4] === 'media' &&
        isUuid(path[5]) &&
        ['thumb', 'small', 'large', 'avif'].includes(path[6] ?? '') &&
        request.method === 'GET'));
  const staffPermissionsRoute =
    path[1] === 'admin' &&
    path[2] === 'users' &&
    ((path.length === 3 && request.method === 'GET') ||
      (path.length === 5 &&
        path[4] === 'permissions' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          path[3] ?? '',
        ) &&
        ['GET', 'PATCH'].includes(request.method)));
  const registrationRoute =
    path[1] === 'admin' &&
    path[2] === 'registration-approvals' &&
    ((path.length === 3 && request.method === 'GET') ||
      (path.length === 4 && isUuid(path[3]) && request.method === 'GET') ||
      (path.length === 5 &&
        isUuid(path[3]) &&
        path[4] === 'decision' &&
        request.method === 'POST'));
  if (
    path[0] !== 'v1' ||
    (!staffPermissionsRoute &&
      !registrationRoute &&
      !propertyRoute &&
      !moderationRoute &&
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
      ].includes(path[1] ?? '')) ||
    path.some((s) => !/^[a-zA-Z0-9_-]+$/.test(s))
  )
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  const mutation = !['GET', 'HEAD'].includes(request.method);
  const csrfRecovery = path.join('/') === 'v1/auth/csrf';
  if (
    csrfRecovery &&
    ((request.headers.get('origin') !== null &&
      request.headers.get('origin') !==
        (process.env.WEB_ORIGIN ?? new URL(request.url).origin)) ||
      (request.headers.get('sec-fetch-site') !== null &&
        request.headers.get('sec-fetch-site') !== 'same-origin'))
  )
    return NextResponse.json({ message: 'Invalid origin' }, { status: 403 });
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
