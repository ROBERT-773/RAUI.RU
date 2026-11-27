'use client';

import Link from 'next/link';
import { AccountEntryLink } from './account-entry-link';
import { useEffect, useRef, useState } from 'react';
import BetaFeedback from './beta-feedback';
import {
  clearFeedbackDraft,
  feedbackIdentityEvent,
} from '../lib/feedback-draft';
import styles from './beta-invitation.module.css';

export default function BetaInvitation({
  initialDismissed = false,
  initialOpen = false,
}: {
  initialDismissed?: boolean;
  initialOpen?: boolean;
}) {
  const [dismissed, setDismissed] = useState(initialDismissed),
    [open, setOpen] = useState(initialOpen);
  const trigger = useRef<HTMLButtonElement>(null),
    returnFocus = useRef(false);
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== feedbackIdentityEvent) return;
      clearFeedbackDraft();
      setOpen(false);
    }
    function onPageShow(event: PageTransitionEvent) {
      // Closing the restored dialog makes it verify the account again on opening.
      if (event.persisted) setOpen(false);
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [open, dismissed]);
  function closeFeedback() {
    returnFocus.current = true;
    setOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get('feedback') === '1') {
      url.searchParams.delete('feedback');
      if (url.hash === '#beta-feedback') url.hash = '';
      window.history.replaceState(
        window.history.state,
        '',
        url.pathname + url.search + url.hash,
      );
    }
  }
  return (
    <section
      id="beta-feedback"
      aria-label="Бесплатное размещение объявлений"
      className={dismissed ? styles.compact : styles.invitation}
    >
      {!dismissed && (
        <>
          <button
            type="button"
            className={styles.close}
            aria-label="Закрыть приглашение"
            onClick={() => {
              document.cookie =
                'raui_beta_closed=1; Max-Age=31536000; Path=/; SameSite=Lax' +
                (window.location.protocol === 'https:' ? '; Secure' : '');
              returnFocus.current = true;
              setDismissed(true);
            }}
          >
            ×
          </button>
          <div className={styles.copy}>
            <h2>Бесплатное размещение объявлений</h2>
            <p>
              Портал работает в тестовом режиме. Приносим извинения за возможные
              сбои. <Link href="/support">Сообщить о сбое</Link>
            </p>
            <details>
              <summary>Условия размещения</summary>
              <p>
                Собственники, независимые агенты и агентства могут бесплатно
                размещать базовые объявления после подтверждения почты и
                телефона и одобрения аккаунта. При ручной подаче объявление
                проходит модерацию. Для собственника доступно одно активное
                объявление и до трёх публикаций за календарный месяц. Платное
                продвижение — отдельная услуга.
              </p>
            </details>
          </div>
        </>
      )}
      <div className={styles.actions}>
        {!dismissed && (
          <AccountEntryLink
            href="/account/listings#new-listing"
            intent="publish"
          >
            Разместить объявление
          </AccountEntryLink>
        )}
        <button
          type="button"
          ref={trigger}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Оставить отзыв
        </button>
      </div>
      {open && <BetaFeedback onClose={closeFeedback} />}
    </section>
  );
}
