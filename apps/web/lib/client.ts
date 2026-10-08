'use client';
import type { AnalyticsAdapter, AnalyticsEvent } from '@raui/types/product';
export function setCsrf(value: string) {
  sessionStorage.setItem('raui_csrf', value);
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
        throw new ApiError(
          'Не удалось выполнить запрос. Попробуйте ещё раз.',
          response.status,
        );
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
  if (!response.ok) {
    if ([400, 409, 429, 503].includes(response.status)) {
      const failure: unknown = await response.json().catch(() => null);
      if (
        path.startsWith('v1/auth/verification/phone/otp') &&
        failure &&
        typeof failure === 'object' &&
        'code' in failure
      ) {
        const safeErrors: Record<string, { status: number; message: string }> =
          {
            phone_otp_invalid: {
              status: 400,
              message: 'Код недействителен или срок его действия истёк.',
            },
            phone_otp_contact_unavailable: {
              status: 409,
              message:
                'Не удалось подтвердить этот телефон. Обратитесь в поддержку.',
            },
            phone_otp_unavailable: {
              status: 503,
              message: 'SMS сейчас недоступно. Повторите запрос позже.',
            },
            phone_otp_rate_limited: {
              status: 429,
              message: 'Слишком много запросов SMS. Повторите запрос позже.',
            },
          };
        const safe =
          typeof failure.code === 'string'
            ? safeErrors[failure.code]
            : undefined;
        if (safe && safe.status === response.status) {
          const seconds =
            'retryAfterSeconds' in failure
              ? failure.retryAfterSeconds
              : undefined;
          throw new ApiError(
            safe.message,
            response.status,
            response.status === 429 &&
              typeof seconds === 'number' &&
              Number.isInteger(seconds) &&
              seconds > 0 &&
              seconds <= 3600
              ? seconds
              : undefined,
          );
        }
      }
      if (
        failure &&
        typeof failure === 'object' &&
        'code' in failure &&
        response.status === 409 &&
        failure.code === 'OWNER_PUBLICATION_QUOTA_EXCEEDED'
      )
        throw new ApiError(
          'Достигнут лимит: 6 объектов одновременно. Приостановите все опубликованные объявления одного объекта; сотрудник сможет повторить проверку текущей заявки.',
          response.status,
        );
    }
    throw new ApiError(
      response.status === 401
        ? 'Войдите в аккаунт, чтобы продолжить.'
        : response.status === 404
          ? 'Объект недоступен.'
          : 'Не удалось выполнить запрос. Попробуйте ещё раз.',
      response.status,
    );
  }
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
