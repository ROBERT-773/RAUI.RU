'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ApiError } from '../lib/client';
import { AccountEntryDialog } from './account-entry-link';

type Action = {
  trigger: HTMLButtonElement;
  title: string;
  execute: () => Promise<void>;
  href: string;
  entry: string;
};

const historyKey = 'rauiAccountAction';

export function useAccountAction(onError: (message: string) => void) {
  const [dialogAction, setDialogAction] = useState<Action | null>(null);
  const waiting = useRef<Action | null>(null);
  const inFlight = useRef(new Set<HTMLButtonElement>());
  const generation = useRef(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  function dismiss(restoreFocus: boolean) {
    const action = waiting.current;
    waiting.current = null;
    if (action && restoreFocus) returnFocus.current = action.trigger;
    setDialogAction(null);
  }

  useEffect(() => {
    // Back, Forward and bfcache restore may change history without unmounting the view.
    function moved() {
      generation.current++;
      if (waiting.current) dismiss(true);
    }
    function leaving() {
      generation.current++;
      dismiss(false);
    }
    const epochRef = generation;
    window.addEventListener('popstate', moved);
    window.addEventListener('pagehide', leaving);
    return () => {
      epochRef.current++;
      waiting.current = null;
      returnFocus.current = null;
      window.removeEventListener('popstate', moved);
      window.removeEventListener('pagehide', leaving);
    };
  }, []);

  useEffect(() => {
    if (!dialogAction && returnFocus.current) {
      returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [dialogAction]);

  async function run(
    event: MouseEvent<HTMLButtonElement>,
    title: string,
    execute: () => Promise<void>,
  ) {
    const trigger = event.currentTarget;
    if (event.detail > 1 || waiting.current || inFlight.current.has(trigger))
      return;
    const epoch = generation.current;
    const href = window.location.href;
    inFlight.current.add(trigger);
    try {
      await execute();
    } catch (error) {
      if (
        epoch !== generation.current ||
        href !== window.location.href ||
        !trigger.isConnected
      )
        return;
      if (!(error instanceof ApiError) || error.status !== 401) {
        onError((error as Error).message);
        return;
      }
      if (waiting.current) return;
      const action = {
        trigger,
        title,
        execute,
        href,
        entry: crypto.randomUUID(),
      };
      window.history.pushState(
        { ...window.history.state, [historyKey]: action.entry },
        '',
        href,
      );
      // Other unauthorized requests started before this prompt cannot reopen it after cancellation.
      generation.current++;
      waiting.current = action;
      setDialogAction(action);
    } finally {
      inFlight.current.delete(trigger);
    }
  }

  function finish(action: Action, authenticated: boolean) {
    if (waiting.current !== action) return;
    const ownsEntry =
      window.history.state?.[historyKey] === action.entry &&
      window.location.href === action.href;
    dismiss(true);
    if (!ownsEntry) return;
    window.history.back();
    if (!authenticated || !action.trigger.isConnected) return;
    inFlight.current.add(action.trigger);
    void action
      .execute()
      .catch((error: Error) => {
        if (action.trigger.isConnected && window.location.href === action.href)
          onError(error.message);
      })
      .finally(() => inFlight.current.delete(action.trigger));
  }

  const dialog = dialogAction && (
    <AccountEntryDialog
      title={dialogAction.title}
      onClose={() => finish(dialogAction, false)}
      onLeave={() => dismiss(false)}
      onAuthenticated={() => finish(dialogAction, true)}
    />
  );
  return { run, dialog };
}
