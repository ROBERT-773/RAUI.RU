'use client';

import { Button } from '@raui/ui';
import { useEffect, useId, useRef, useState } from 'react';
import modal from './beta-invitation.module.css';
import styles from './phone-sign-in.module.css';

type CodeDialogProps = {
  channel: 'phone' | 'email';
  destination: string;
  delivery: 'accepted' | 'unknown' | 'unavailable';
  resendAfter: string;
  expiresAt: string;
  verifying: boolean;
  sending: boolean;
  uncertainResend: boolean;
  error: string;
  verificationFailed: boolean;
  onConfirm: (code: string) => void;
  onResend: () => void;
  onClose: () => void;
};

export function CodeDialog({
  channel,
  destination,
  delivery,
  resendAfter,
  expiresAt,
  verifying,
  sending,
  uncertainResend,
  error,
  verificationFailed,
  onConfirm,
  onResend,
  onClose,
}: CodeDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const attempted = useRef('');
  const [code, setCode] = useState('');
  const [caret, setCaret] = useState(0);
  const title = useId();
  const hint = useId();
  const problem = useId();
  const deadline = Date.parse(resendAfter);
  const expiration = Date.parse(expiresAt);
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  const expired = now >= expiration;
  const inputBlocked = verifying || sending || uncertainResend || expired;
  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const tick = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) window.clearInterval(tick);
    }, 500);
    return () => window.clearInterval(tick);
  }, [deadline]);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer =
      expiration > Date.now()
        ? window.setTimeout(refresh, expiration - Date.now() + 1)
        : undefined;
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [expiration]);
  useEffect(() => {
    const node = dialog.current!;
    if (typeof node.showModal === 'function') node.showModal();
    else node.open = true;
    field.current?.focus();
    return () => {
      if (node.open && typeof node.close === 'function') node.close();
    };
  }, []);
  useEffect(() => {
    if (verificationFailed && !verifying) {
      field.current?.focus();
      field.current?.select();
    }
  }, [verificationFailed, verifying]);
  function change(raw: string) {
    if (inputBlocked) return;
    if (Date.now() >= expiration) {
      setNow(Date.now());
      return;
    }
    const digits = raw.replace(/[\s-]/g, '');
    if (!/^\d{0,6}$/.test(digits)) return;
    setCode(digits);
    setCaret(
      Math.min(field.current?.selectionStart ?? digits.length, digits.length),
    );
    if (digits.length === 6 && attempted.current !== digits) {
      attempted.current = digits;
      onConfirm(digits);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={modal.dialog}
      aria-labelledby={title}
      aria-describedby={hint}
      onCancel={(event) => {
        event.preventDefault();
        if (!verifying) onClose();
      }}
    >
      <h2 id={title}>
        {channel === 'phone' ? 'Подтверждение телефона' : 'Подтверждение почты'}
      </h2>
      <button
        className={modal.close}
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        disabled={verifying}
      >
        ×
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            verificationFailed &&
            !inputBlocked &&
            !(Date.now() >= expiration) &&
            code.length === 6
          )
            onConfirm(code);
        }}
      >
        <p id={hint}>
          {channel === 'phone'
            ? 'Введите код из сообщения или уведомления.'
            : 'Введите код из письма.'}{' '}
          <strong className={styles.destination}>{destination}</strong>
        </p>
        {delivery === 'unknown' && (
          <p role="status">
            Отправку пока не удалось подтвердить. Если код придёт, введите его.
          </p>
        )}
        <label>
          Код подтверждения
          <span className={styles.codeBox}>
            <span aria-hidden="true" className={styles.cells}>
              {Array.from({ length: 6 }, (_, index) => (
                <span
                  key={index}
                  data-active={index === Math.min(caret, 5) || undefined}
                />
              ))}
            </span>
            <input
              ref={field}
              type="text"
              dir="ltr"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              pattern="[0-9]{6}"
              required
              value={code}
              readOnly={inputBlocked}
              aria-describedby={error ? hint + ' ' + problem : hint}
              className={styles.codeInput}
              onSelect={(event) =>
                setCaret(event.currentTarget.selectionStart ?? 0)
              }
              onChange={(event) => change(event.target.value)}
            />
          </span>
        </label>
        {Number.isFinite(expiration) &&
          (expired ? (
            <p role="status">Срок действия кода истёк. Запросите новый код.</p>
          ) : (
            <p>
              Код действует до{' '}
              <time dateTime={expiresAt}>
                {new Date(expiration).toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              .
            </p>
          ))}
        {verifying && <p role="status">Проверяем код…</p>}
        {sending && <p role="status">Запрашиваем код…</p>}
        {error && (
          <p role="alert" id={problem}>
            {error}
          </p>
        )}
        {verificationFailed && !expired && code.length === 6 && (
          <Button type="submit" className="primary" disabled={inputBlocked}>
            Подтвердить код
          </Button>
        )}
        <div className={styles.resend}>
          <Button
            disabled={
              verifying ||
              sending ||
              !Number.isFinite(deadline) ||
              remaining > 0
            }
            onClick={onResend}
          >
            {uncertainResend ? 'Проверить отправку' : 'Отправить новый код'}
          </Button>
          {remaining > 0 && (
            <span role="timer" aria-label="До повторной отправки">
              через {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, '0')}
            </span>
          )}
        </div>
        <Button disabled={verifying} onClick={onClose}>
          {channel === 'phone' ? 'Изменить номер' : 'Изменить почту'}
        </Button>
      </form>
    </dialog>
  );
}
