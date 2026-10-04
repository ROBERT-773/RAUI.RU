import type { HealthResponse } from '@raui/types';
export function GET() {
  return Response.json(
    { status: 'ok', service: 'web' } satisfies HealthResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
export const dynamic = 'force-dynamic';
