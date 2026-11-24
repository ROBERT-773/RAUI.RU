'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, ContactPhoneRequiredError } from '../lib/client';
import {
  contactModes,
  type ContactMode,
  type ContactSettings,
} from '../lib/contact-settings';
import { invalidPhoneInput, normalizePhoneInput } from '../lib/phone-input';

const settingsPath = 'v1/account/contact-settings';
const phonesPath = 'v1/account/contact-phones';

export default function AccountContactSettings({
  onSessionExpired,
  focusOnMount = false,
}: {
  onSessionExpired: () => void;
  focusOnMount?: boolean;
}) {
  const [settings, setSettings] = useState<ContactSettings | null>(null);
  const [writing, setWriting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const busy = writing || loading;
  const [error, setError] = useState<Error | null>(null),
    [notice, setNotice] = useState('');
  const [phone, setPhone] = useState('+7'),
    [requested, setRequested] = useState(''),
    [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const generation = useRef(0),
    locked = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  useEffect(() => {
    const ref = generation;
    const current = ++ref.current;
    api<ContactSettings>(settingsPath)
      .then((result) => {
        if (
          !result ||
          !Object.hasOwn(contactModes, result.mode) ||
          !Array.isArray(result.phones)
        )
          throw new Error('Не удалось загрузить настройки связи.');
        if (current === generation.current) setSettings(result);
      })
      .catch((failure: Error) => {
        if (current !== generation.current) return;
        setError(failure);
        if (failure instanceof ApiError && failure.status === 401)
          onSessionExpired();
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      ref.current++;
    };
  }, [attempt, onSessionExpired]);
  useEffect(() => {
    if (!resendAt) return;
    const timeout = window.setTimeout(
      () => setResendAt(0),
      Math.max(0, resendAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [resendAt]);

  async function mutate<T>(
    request: () => Promise<T>,
    success: (value: T) => void,
  ) {
    if (locked.current) return;
    locked.current = true;
    setWriting(true);
    setError(null);
    setNotice('');
    const current = generation.current;
    try {
      const result = await request();
      if (current === generation.current) success(result);
    } catch (failure) {
      if (current !== generation.current) return;
      setError(
        failure instanceof Error
          ? failure
          : new Error('Не удалось обновить контакты.'),
      );
      if (failure instanceof ApiError && failure.status === 401)
        onSessionExpired();
    } finally {
      if (current === generation.current) {
        locked.current = false;
        setWriting(false);
      }
    }
  }
  function requestCode() {
    const normalized = normalizePhoneInput(phone);
    if (!normalized) {
      setError(new Error(invalidPhoneInput));
      return;
    }
    void mutate(
      () =>
        api<{ delivery: string; resendAfter: string }>(
          phonesPath + '/request',
          'POST',
          { phone: normalized },
        ),
      (value) => {
        setPhone(normalized);
        setRequested(normalized);
        setCode('');
        setResendAt(Date.parse(value.resendAfter) || 0);
        setNotice(
          value.delivery === 'unknown'
            ? 'Доставка пока не подтверждена. Если код пришёл, введите его.'
            : 'Введите код из SMS для дополнительного номера.',
        );
      },
    );
  }
  return (
    <section id="contact-settings" aria-label="Связь по объявлениям">
      <h3 ref={heading} tabIndex={-1}>
        Связь по объявлениям
      </h3>
      {!settings && !error && <p role="status">Загружаем настройки связи…</p>}
      {error && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            setLoading(true);
            setAttempt((n) => n + 1);
          }}
        >
          Обновить настройки связи
        </button>
      )}
      {settings && (
        <>
          <label>
            Способ связи для всех объявлений
            <select
              disabled={busy}
              value={settings.mode}
              onChange={(e) => {
                const mode = e.target.value as ContactMode;
                void mutate(
                  () => api<ContactSettings>(settingsPath, 'PATCH', { mode }),
                  (value) => {
                    setSettings(value);
                    setNotice('Способ связи сохранён для всех объявлений.');
                  },
                );
              }}
            >
              {(Object.keys(contactModes) as ContactMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {contactModes[mode]}
                </option>
              ))}
            </select>
          </label>
          <h4>Подтверждённые номера</h4>
          <p>В каждом объявлении можно отдельно выбрать до двух номеров.</p>
          <ul>
            {settings.phones.map((p) => (
              <li key={p.id}>
                {p.phone}
                {p.primary ? (
                  ' · Основной номер'
                ) : (
                  <>
                    {' '}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Удалить дополнительный номер ${p.phone}`}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Удалить номер ${p.phone} из профиля и объявлений?`,
                          )
                        )
                          return;
                        void mutate(
                          () =>
                            api<ContactSettings>(
                              phonesPath + '/' + p.id,
                              'DELETE',
                            ),
                          (value) => {
                            setSettings(value);
                            setNotice('Дополнительный номер удалён.');
                          },
                        );
                      }}
                    >
                      Удалить
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {settings.phones.filter((p) => !p.primary).length < 2 && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  requestCode();
                }}
              >
                <label>
                  Дополнительный номер
                  <input
                    type="tel"
                    autoComplete="tel"
                    required
                    value={phone}
                    disabled={busy}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setRequested('');
                      setCode('');
                      setNotice('');
                      setError(null);
                    }}
                  />
                </label>
                <button disabled={busy || Boolean(resendAt)}>
                  {requested
                    ? 'Запросить новый код'
                    : 'Получить код для номера'}
                </button>
              </form>
              {requested && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!/^\d{6}$/.test(code)) return;
                    void mutate(
                      () =>
                        api<ContactSettings>(phonesPath + '/verify', 'POST', {
                          phone: requested,
                          code,
                        }),
                      (value) => {
                        setSettings(value);
                        setRequested('');
                        setPhone('+7');
                        setCode('');
                        setResendAt(0);
                        setNotice('Дополнительный номер подтверждён.');
                      },
                    );
                  }}
                >
                  <label>
                    Код для дополнительного номера
                    <input
                      type="text"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      required
                      maxLength={6}
                      pattern="[0-9]{6}"
                      disabled={busy}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <button disabled={busy || !/^\d{6}$/.test(code)}>
                    Подтвердить дополнительный номер
                  </button>
                </form>
              )}
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error.message}</p>}
      {error instanceof ContactPhoneRequiredError && error.total > 0 && (
        <>
          <p>Объявлений для проверки: {error.total}</p>
          <ul>
            {error.listings.map((item) => (
              <li key={item.id}>
                <Link
                  href={
                    '/account/listings?listing=' + encodeURIComponent(item.id)
                  }
                >
                  {item.title || 'Открыть объявление'}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
