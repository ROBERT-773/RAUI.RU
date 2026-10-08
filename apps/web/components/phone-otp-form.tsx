'use client';
import { Button } from '@raui/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
interface Challenge {
  challengeId: string;
  expiresAt: string;
  resendAfter: string;
  delivery: 'accepted' | 'unavailable' | 'unknown';
}
const deliveryCopy: Record<Challenge['delivery'], string> = {
  accepted: 'Запрос на отправку SMS принят. Доставка не подтверждена.',
  unknown: 'Не удалось подтвердить отправку. Если SMS придёт, используйте код.',
  unavailable: 'SMS сейчас недоступно. Повторите запрос позже.',
};
export default function PhoneOtpForm({
  onConfirmed,
  onSessionExpired,
  onBusy,
  disabled = false,
}: {
  onConfirmed: () => void | Promise<void>;
  onSessionExpired?: () => void;
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0);
  const lock = useRef(false);
  const pending = useRef<{ phone: string; key: string } | null>(null);
  const callbacks = useRef({ onConfirmed, onSessionExpired, onBusy });
  useEffect(() => {
    callbacks.current = { onConfirmed, onSessionExpired, onBusy };
  }, [onConfirmed, onSessionExpired, onBusy]);
  useEffect(() => {
    const generation = epoch;
    const request = pending;
    ++generation.current;
    return () => {
      ++generation.current;
      request.current = null;
    };
  }, []);
  useEffect(() => {
    if (!challenge && !resendAt) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (challenge && time >= Date.parse(challenge.expiresAt)) setCode('');
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [challenge, resendAt]);
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = Boolean(challenge && now >= Date.parse(challenge.expiresAt));
  function failure(value: unknown) {
    setError(
      value instanceof Error
        ? value.message
        : 'Не удалось выполнить запрос. Попробуйте ещё раз.',
    );
    if (value instanceof Error && 'status' in value && value.status === 401)
      callbacks.current.onSessionExpired?.();
  }
  async function request() {
    if (lock.current || disabled || Date.now() < resendAt) return;
    if (!pending.current && !/^\+[1-9][0-9]{7,14}$/.test(phone)) return;
    lock.current = true;
    setBusy(true);
    callbacks.current.onBusy?.(true);
    setError('');
    setNotice('');
    setCode('');
    setChallenge(null);
    const current = epoch.current;
    const allocation = pending.current ?? { phone, key: crypto.randomUUID() };
    pending.current = allocation;
    try {
      const result = await api<Challenge>(
        'v1/auth/verification/phone/otp',
        'POST',
        { phone: allocation.phone },
        { idempotencyKey: allocation.key },
      );
      if (current !== epoch.current) return;
      // Do not retain an unusable challenge or interpret malformed JSON as delivery.
      if (
        !result ||
        typeof result.challengeId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          result.challengeId,
        ) ||
        !['accepted', 'unavailable', 'unknown'].includes(result.delivery) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        !Number.isFinite(Date.parse(result.resendAfter))
      )
        throw new Error(
          'Не удалось подтвердить результат запроса. Попробуйте ещё раз.',
        );
      setChallenge(result);
      setNow(Date.now());
      setResendAt(Date.parse(result.resendAfter));
      setNotice(deliveryCopy[result.delivery]);
      setUncertain(false);
      pending.current = null;
    } catch (value) {
      if (current !== epoch.current) return;
      const status =
        value instanceof Error && 'status' in value ? value.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        pending.current = null;
        setUncertain(false);
        if (status === 429) {
          const seconds =
            'retryAfterSeconds' in (value as Error)
              ? (value as Error & { retryAfterSeconds?: number })
                  .retryAfterSeconds
              : undefined;
          setNow(Date.now());
          setResendAt(
            Date.now() +
              (typeof seconds === 'number' && seconds > 0 ? seconds : 60) *
                1000,
          );
        }
      } else setUncertain(true);
      failure(value);
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy(false);
        callbacks.current.onBusy?.(false);
      }
    }
  }
  async function confirm() {
    if (
      lock.current ||
      disabled ||
      !challenge ||
      Date.now() >= Date.parse(challenge.expiresAt) ||
      !/^[0-9]{6}$/.test(code)
    )
      return;
    lock.current = true;
    setBusy(true);
    callbacks.current.onBusy?.(true);
    setError('');
    setNotice('');
    const submitted = code;
    setCode('');
    const current = epoch.current;
    try {
      await api('v1/auth/verification/phone/otp/confirm', 'POST', {
        challengeId: challenge.challengeId,
        code: submitted,
      });
      if (current !== epoch.current) return;
      setChallenge(null);
      await callbacks.current.onConfirmed();
    } catch (value) {
      if (current === epoch.current) failure(value);
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy(false);
        callbacks.current.onBusy?.(false);
      }
    }
  }
  return (
    <section aria-label="Подтверждение телефона SMS-кодом">
      <h4>Подтверждение SMS-кодом</h4>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void request();
        }}
      >
        <label>
          Номер телефона для SMS
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            pattern="\+[1-9][0-9]{7,14}"
            required
            disabled={busy || disabled || uncertain}
            onChange={(event) => {
              setPhone(event.target.value);
              setCode('');
              setChallenge(null);
              setNotice('');
            }}
          />
        </label>
        <p>Международный формат: + и от 8 до 15 цифр.</p>
        <Button type="submit" disabled={busy || disabled || remaining > 0}>
          {uncertain
            ? 'Проверить результат запроса'
            : challenge
              ? 'Повторить запрос SMS-кода'
              : 'Запросить SMS-код'}
        </Button>
        {remaining > 0 && (
          <p role="status">Повторный запрос через {remaining} сек.</p>
        )}
      </form>
      {challenge && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <label>
            SMS-код из 6 цифр
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              required
              value={code}
              disabled={busy || disabled || expired}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            disabled={busy || disabled || expired || !/^[0-9]{6}$/.test(code)}
          >
            Подтвердить SMS-код
          </Button>
          {expired && (
            <p role="status">Срок действия кода истёк. Запросите новый код.</p>
          )}
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
