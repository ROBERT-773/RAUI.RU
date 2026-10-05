'use client';
import type { AnalyticsAdapter, AnalyticsEvent } from '@raui/types/product';
let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
  sessionStorage.setItem('raui_csrf', value);
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch('/api/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrf || sessionStorage.getItem('raui_csrf')
        ? { 'X-CSRF-Token': csrf || sessionStorage.getItem('raui_csrf')! }
        : {}),
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
