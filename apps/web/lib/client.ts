'use client';
import type { AnalyticsAdapter, AnalyticsEvent } from '@raui/types/product';
export function setCsrf(value: string) {
  sessionStorage.setItem('raui_csrf', value);
}
const publicMutations = new Set([
  'v1/auth/register',
  'v1/auth/login',
  'v1/auth/verification/email/confirm',
  'v1/auth/password-reset',
  'v1/auth/password-reset/confirm',
]);
let recovery: Promise<string | undefined> | undefined;
function recoverCsrf(): Promise<string | undefined> {
  if (!recovery) {
    recovery = (async () => {
      const response = await fetch('/api/v1/auth/csrf', { cache: 'no-store' });
      if (response.status === 401) return undefined;
      if (!response.ok)
        throw new Error('Не удалось выполнить запрос. Попробуйте ещё раз.');
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== 'object' ||
        !('csrfToken' in value) ||
        typeof value.csrfToken !== 'string' ||
        !value.csrfToken
      )
        throw new Error('Не удалось выполнить запрос. Попробуйте ещё раз.');
      return value.csrfToken;
    })().finally(() => {
      recovery = undefined;
    });
  }
  return recovery;
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  options?: { idempotencyKey?: string },
): Promise<T> {
  const token =
    !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
    !publicMutations.has(path)
      ? await recoverCsrf()
      : undefined;
  const response = await fetch('/api/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.idempotencyKey
        ? { 'Idempotency-Key': options.idempotencyKey }
        : {}),
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Войдите в аккаунт, чтобы продолжить.'
        : response.status === 404
          ? 'Объект недоступен.'
          : 'Не удалось выполнить запрос. Попробуйте ещё раз.',
    );
  return (await response.json()) as T;
}
let analytics: AnalyticsAdapter = { emit: () => {} };
export function configureAnalytics(adapter: AnalyticsAdapter) {
  analytics = adapter;
}
export function track(event: AnalyticsEvent) {
  try {
    analytics.emit(event);
  } catch {
    console.warn('analytics_adapter_failed');
  }
}
export const money = (value: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
