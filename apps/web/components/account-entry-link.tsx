'use client';

import dynamic from 'next/dynamic';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import type { AccountUser } from './account';
import { api } from '../lib/client';
import AuthDialog, { loginTitle, publishTitle } from './auth-dialog';

function OpeningStatus() {
  return <p role="status">Открываем форму входа…</p>;
}
const Account = dynamic(() => import('./account'), {
  ssr: false,
  loading: OpeningStatus,
});
export const accountEntryHistoryKey = 'rauiAccountEntry';
type Intent = 'login' | 'publish';
type Channels = {
  smsAvailable: boolean;
  emailAvailable: boolean;
  resetLinkAvailable: boolean;
};
const unavailable: Channels = {
  smsAvailable: false,
  emailAvailable: false,
  resetLinkAvailable: false,
};

function destinationAfterSignIn(
  user: AccountUser,
  href: string,
  intent: Intent,
) {
  if (intent !== 'publish') return href;
  const approved =
    !user.registration_approval_state ||
    user.registration_approval_state === 'approved';
  const canPublish = [
    'owner',
    'agent',
    'agency',
    'developer',
    'admin',
  ].includes(user.role);
  return approved &&
    canPublish &&
    user.email_verified_at &&
    user.phone_verified_at
    ? '/account/listings#new-listing'
    : '/account?action=publish';
}

function navigate(href: string) {
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin) return;
  // Re-entering the current route also needs fresh authenticated page data.
  if (
    target.pathname === window.location.pathname &&
    target.search === window.location.search
  ) {
    window.history.replaceState(null, '', target.href);
    window.location.reload();
  } else {
    window.location.replace(target.href);
  }
}

export function AccountEntryDialog({
  title,
  onAuthenticated,
  onClose,
  onLeave,
}: {
  title: string;
  onAuthenticated: (user: AccountUser) => void;
  onClose: () => void;
  onLeave?: () => void;
}) {
  const [channels, setChannels] = useState<Channels | null>(null);
  useEffect(() => {
    let current = true;
    api<Channels>('v1/auth/password-reset/capabilities')
      .then((result) => {
        if (current)
          setChannels({
            emailAvailable: result.emailAvailable === true,
            smsAvailable: result.smsAvailable === true,
            resetLinkAvailable: result.resetLinkAvailable === true,
          });
      })
      .catch(() => {
        if (current) setChannels(unavailable);
      });
    return () => {
      current = false;
    };
  }, []);

  return (
    <AuthDialog
      title={title}
      onClose={onClose}
      onNavigate={(href) => {
        onLeave?.();
        navigate(href);
      }}
    >
      {channels ? (
        <Account
          {...channels}
          compactEntry
          entryTitle={title}
          onAuthenticated={onAuthenticated}
        />
      ) : (
        <OpeningStatus />
      )}
    </AuthDialog>
  );
}

export function AccountEntryLink({
  href,
  intent = 'login',
  children,
  onClick,
  ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  href: string;
  intent?: Intent;
}) {
  const id = useId();
  const trigger = useRef<HTMLAnchorElement>(null);
  const returnFocus = useRef(false);
  const closing = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function sync() {
      const active = window.history.state?.[accountEntryHistoryKey] === id;
      if (active) returnFocus.current = true;
      closing.current = false;
      setOpen(active);
    }
    window.addEventListener('popstate', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, [id]);
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <>
      <a
        {...props}
        ref={trigger}
        href={href}
        aria-haspopup="dialog"
        onClick={(event) => {
          onClick?.(event);
          const link = event.currentTarget;
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            link.origin !== window.location.origin ||
            (link.target && link.target !== '_self') ||
            link.hasAttribute('download')
          )
            return;
          event.preventDefault();
          if (open || closing.current) return;
          if (window.history.state?.[accountEntryHistoryKey] === id) {
            setOpen(true);
            return;
          }
          window.history.pushState(
            { ...window.history.state, [accountEntryHistoryKey]: id },
            '',
            window.location.href,
          );
          returnFocus.current = true;
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && (
        <AccountEntryDialog
          title={intent === 'publish' ? publishTitle : loginTitle}
          onAuthenticated={(user) =>
            navigate(destinationAfterSignIn(user, href, intent))
          }
          onClose={() => {
            if (closing.current) return;
            closing.current = true;
            setOpen(false);
            if (window.history.state?.[accountEntryHistoryKey] === id)
              window.history.back();
            else closing.current = false;
          }}
        />
      )}
    </>
  );
}
