'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/client';
import {
  readFeedbackDraft,
  storeFeedbackDraft,
  clearFeedbackDraft,
} from '../lib/feedback-draft';
import styles from './beta-invitation.module.css';

type Identity =
  { kind: 'user' | 'pending'; id: string } | { kind: 'guest' | 'forbidden' };
type Session = Identity | { kind: 'loading' } | { kind: 'error' };
const sessionError = 'Не удалось проверить вход. Повторите проверку.';
const storageError =
  'Браузер не сохранил предложение. Скопируйте его и нажмите «Войти и продолжить» ещё раз.';

async function currentSession(): Promise<Identity> {
  try {
    const user = await api<{
      id: string;
      registration_approval_state?: 'approved' | 'pending' | 'rejected';
    }>('v1/auth/me');
    if (!user?.id) throw new Error();
    if (user.registration_approval_state === 'rejected')
      return { kind: 'forbidden' };
    return {
      kind: user.registration_approval_state === 'pending' ? 'pending' : 'user',
      id: user.id,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      return { kind: 'guest' };
    if (error instanceof ApiError && error.status === 403)
      return { kind: 'forbidden' };
    throw error;
  }
}

export default function BetaFeedback({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(false);
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false);
  const pending = useRef<{ message: string; requestId: string } | null>(null),
    lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLTextAreaElement>(null),
    close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    mounted.current = true;
    element.showModal();
    return () => {
      mounted.current = false;
      element.close();
    };
  }, []);
  useEffect(() => {
    let active = true;
    currentSession()
      .then((current) => {
        if (!active) return;
        const stored = readFeedbackDraft();
        if ('id' in current && stored?.owner === current.id) {
          setMessage(stored.message);
          pending.current = stored;
        } else if (stored) clearFeedbackDraft();
        setSession(current);
      })
      .catch(() => {
        if (active) setSession({ kind: 'error' });
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (
      (session.kind === 'user' || session.kind === 'guest') &&
      document.activeElement === close.current
    )
      field.current?.focus();
  }, [session.kind]);
  useEffect(() => {
    if (sent) result.current?.focus();
  }, [sent]);

  async function submit() {
    if (lock.current || session.kind !== 'user' || !message.trim()) return;
    if (message.includes('\u0000')) {
      setError('Удалите служебный символ из текста и повторите отправку.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    const text = message.trim();
    const entry =
      pending.current?.message.trim() === text
        ? pending.current
        : { message: text, requestId: crypto.randomUUID() };
    pending.current = entry;
    try {
      const now = await currentSession();
      if (!mounted.current) return;
      if (now.kind === 'pending' && now.id === session.id) {
        storeFeedbackDraft({ ...entry, owner: now.id });
        setSession(now);
        return;
      }
      if (now.kind !== 'user' || now.id !== session.id) {
        clearFeedbackDraft();
        pending.current = null;
        setMessage('');
        setSession(now);
        setError(
          'Аккаунт изменился. Проверьте, под каким именем вы отправляете предложение.',
        );
        return;
      }
      storeFeedbackDraft({ ...entry, owner: now.id });
      const receipt = await api<{ id: string }>('v1/account/feedback', 'POST', {
        message: text,
        requestId: entry.requestId,
      });
      if (!receipt?.id) throw new Error();
      if (readFeedbackDraft()?.requestId === entry.requestId)
        clearFeedbackDraft();
      if (mounted.current) {
        pending.current = null;
        setMessage('');
        setSent(true);
      }
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) {
        clearFeedbackDraft();
        pending.current = null;
        setMessage('');
        setSession({ kind: 'guest' });
        setError('Сеанс завершён. Войдите в аккаунт, чтобы продолжить.');
      } else if (failure instanceof ApiError && failure.status === 403) {
        pending.current = null;
        setMessage('');
        setSession({ kind: 'forbidden' });
      } else
        setError(
          'Не удалось подтвердить отправку. Нажмите «Отправить предложение» ещё раз.',
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-label="Обратная связь о портале"
      className={styles.dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        ref={close}
        className={styles.close}
        aria-label="Закрыть форму"
        onClick={onClose}
      >
        ×
      </button>
      {sent ? (
        <p ref={result} tabIndex={-1} role="status">
          Спасибо! Ваше предложение отправлено команде RAUI.
        </p>
      ) : (
        <form
          aria-label="Обратная связь о портале"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="beta-suggestion">
            Что бы вы хотели видеть на портале?
          </label>
          <textarea
            ref={field}
            id="beta-suggestion"
            rows={4}
            maxLength={2000}
            required
            value={message}
            disabled={
              busy ||
              session.kind === 'loading' ||
              session.kind === 'error' ||
              session.kind === 'forbidden'
            }
            onChange={(e) => {
              const value = e.target.value;
              setMessage(value);
              setError('');
              if (session.kind === 'pending') {
                const entry = {
                  message: value,
                  requestId: crypto.randomUUID(),
                };
                pending.current = entry;
                storeFeedbackDraft({ ...entry, owner: session.id });
              }
            }}
          />
          {session.kind === 'loading' && <p role="status">Проверяем вход…</p>}
          {session.kind === 'error' && (
            <>
              <p role="alert">{sessionError}</p>
              <button
                type="button"
                onClick={() => {
                  setSession({ kind: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                Повторить проверку
              </button>
            </>
          )}
          {session.kind === 'guest' && (
            <>
              <p>Войдите в аккаунт, чтобы отправить предложение.</p>
              <a
                href="/account?action=feedback"
                onClick={(e) => {
                  if (
                    message &&
                    error !== storageError &&
                    !storeFeedbackDraft({
                      owner: null,
                      message,
                      requestId: crypto.randomUUID(),
                    })
                  ) {
                    e.preventDefault();
                    setError(storageError);
                  }
                }}
              >
                Войти и продолжить
              </a>
            </>
          )}
          {session.kind === 'user' && (
            <button
              type="submit"
              className="primary"
              disabled={busy || !message.trim()}
            >
              {busy ? 'Отправляем…' : 'Отправить предложение'}
            </button>
          )}
          {session.kind === 'pending' && (
            <p role="status">
              Отправка станет доступна после одобрения аккаунта.{' '}
              <a href="/account">Проверить статус в кабинете</a>
            </p>
          )}
          {session.kind === 'forbidden' && (
            <p role="alert">
              Для этого аккаунта отправка предложений недоступна.{' '}
              <a href="/account">Проверить статус в кабинете</a>
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </dialog>
  );
}
