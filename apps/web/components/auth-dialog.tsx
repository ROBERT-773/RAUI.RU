'use client';

import Link from 'next/link';
import {
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import BrandLogo from './brand-logo';
import styles from './auth-dialog.module.css';

export const loginTitle = 'Вход или регистрация';
export const publishTitle = 'Войдите, чтобы разместить объявление';

export default function AuthDialog({
  title,
  children,
  onClose,
  onNavigate,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onNavigate?: (href: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPressed = useRef(false);
  useLayoutEffect(() => {
    const node = ref.current!;
    const previousOverflow = document.body.style.overflow;
    if (typeof node.showModal === 'function') node.showModal();
    else node.open = true;
    document.body.style.overflow = 'hidden';
    node
      .querySelector<HTMLInputElement>('input:not([type="hidden"]):enabled')
      ?.focus();
    return () => {
      if (node.open && typeof node.close === 'function') node.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function handleLink(event: MouseEvent<HTMLDialogElement>) {
    if (
      !onNavigate ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.origin !== window.location.origin ||
      (link.target && link.target !== '_self') ||
      link.hasAttribute('download')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    onNavigate(link.href);
  }

  return createPortal(
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      onClickCapture={handleLink}
      onPointerDown={(event) => {
        backdropPressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdropPressed.current && event.target === event.currentTarget)
          onClose();
        backdropPressed.current = false;
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.content}>
        <div className={styles.brand}>
          <BrandLogo />
        </div>
        <button
          className={styles.close}
          type="button"
          aria-label="Закрыть"
          onClick={onClose}
        >
          ×
        </button>
        {children}
        <Link href="/support" className={styles.support}>
          Служба поддержки
        </Link>
      </div>
    </dialog>,
    document.body,
  );
}
