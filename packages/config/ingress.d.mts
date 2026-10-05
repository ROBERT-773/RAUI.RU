export const headerNames: readonly string[];
export function normalizeIp(value: unknown): string | null;
export function signIdentity(
  method: string,
  target: string,
  ip: string,
  secret: string,
  at?: number,
): Record<string, string>;
export function verifyIdentity(
  headers: Record<string, unknown>,
  method: string,
  target: string,
  secret: string,
  now?: number,
): string | null;
