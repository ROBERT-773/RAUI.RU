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
export class ContactPhoneRequiredError extends ApiError {
  constructor(
    readonly listings: { id: string; title: string }[],
    readonly total: number,
  ) {
    super(
      'Чтобы по объявлению можно было позвонить, выберите подтверждённый номер.',
      409,
    );
  }
}
export class ListingContactSelectionChangedError extends ApiError {
  constructor() {
    super(
      'Контакты изменились в другой вкладке. Проверьте номера и подтвердите выбор ещё раз.',
      409,
    );
  }
}
export const feedHostApprovalHint =
  'Домен выгрузки ещё не разрешён. Попросите администратора RAUI разрешить загрузку с этого домена.';
const publicMutations = new Set([
  'v1/support/tickets',
  'v1/support/tickets/status',
  'v1/auth/register',
  'v1/auth/login',
  'v1/auth/phone-sign-in',
  'v1/auth/phone-sign-in/confirm',
  'v1/auth/phone-sign-in/register',
  'v1/auth/email-sign-in',
  'v1/auth/email-sign-in/confirm',
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
    if ([400, 403, 409, 429, 503].includes(response.status)) {
      const failure: unknown = await response.json().catch(() => null);
      if (
        failure &&
        typeof failure === 'object' &&
        'code' in failure &&
        typeof failure.code === 'string' &&
        (/^v1\/(?:account\/(?:contact-|inquiries\/)|listings\/[^/]+\/(?:contact-settings|transitions))/.test(
          path,
        ) ||
          (failure.code === 'contact_phone_required' &&
            /^v1\/auth\/verification\/phone(?:\/|$)/.test(path)))
      ) {
        if (
          failure.code === 'contact_phone_required' &&
          response.status === 409
        ) {
          const listings =
            'listings' in failure && Array.isArray(failure.listings)
              ? failure.listings.filter(
                  (row): row is { id: string; title: string } =>
                    row &&
                    typeof row.id === 'string' &&
                    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
                      row.id,
                    ) &&
                    typeof row.title === 'string',
                )
              : [];
          throw new ContactPhoneRequiredError(
            listings,
            'total' in failure && typeof failure.total === 'number'
              ? failure.total
              : listings.length,
          );
        }
        if (
          failure.code === 'LISTING_CONTACT_SELECTION_CHANGED' &&
          response.status === 409
        )
          throw new ListingContactSelectionChangedError();
        const messages: Record<string, string> = {
          contact_phone_invalid_code:
            'Код недействителен или срок его действия истёк.',
          contact_phone_limit:
            'Можно добавить не более двух дополнительных номеров.',
          contact_phone_exists: 'Этот номер уже добавлен в профиль.',
          contact_phone_primary:
            'Основной номер меняется в разделе подтверждения телефона.',
          LISTING_MESSAGES_DISABLED: 'Автор принимает только звонки.',
          INVALID_LISTING_CONTACT_PHONES:
            'Выберите до двух разных подтверждённых номеров из своего профиля.',
          LISTING_CONTACT_PHONE_REQUIRED:
            'Для звонков выберите хотя бы один подтверждённый номер.',
          phone_otp_unavailable:
            'Сейчас отправка SMS недоступна. Попробуйте позже.',
          phone_otp_rate_limited: 'Слишком много запросов. Попробуйте позже.',
        };
        if (Object.hasOwn(messages, failure.code))
          throw new ApiError(messages[failure.code]!, response.status);
      }
      if (
        response.status === 400 &&
        /^v1\/(?:account|organizations\/[^/]+)\/feeds\/link$/.test(path)
      ) {
        const unapproved =
          failure &&
          typeof failure === 'object' &&
          'code' in failure &&
          failure.code === 'feed_host_not_approved';
        throw new ApiError(
          unapproved
            ? feedHostApprovalHint
            : 'Проверьте ссылку HTTPS на XML-файл.',
          response.status,
        );
      }
      if (
        (path.startsWith('v1/auth/verification/phone/otp') ||
          path === 'v1/auth/phone-sign-in' ||
          path === 'v1/auth/email-sign-in') &&
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
            email_sign_in_rate_limited: {
              status: 429,
              message: 'Слишком много запросов кода. Попробуйте позже.',
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
        (failure.code === 'OWNER_PUBLICATION_QUOTA_EXCEEDED' ||
          failure.code === 'OWNER_MONTHLY_PUBLICATION_QUOTA_EXCEEDED')
      )
        throw new ApiError(
          failure.code === 'OWNER_MONTHLY_PUBLICATION_QUOTA_EXCEEDED'
            ? 'Достигнут лимит: три публикации в календарный месяц.'
            : 'Разрешено одно активное объявление. Приостановите действующее объявление; сотрудник сможет повторить проверку текущей заявки.',
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
  if (response.status === 204) return undefined as T;
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
