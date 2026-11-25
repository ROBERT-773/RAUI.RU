'use client';

import type { ComponentProps } from 'react';
import Account from './account';
import AuthDialog, { loginTitle, publishTitle } from './auth-dialog';

function closeDirectEntry() {
  const current = window.location;
  const previous = document.referrer && new URL(document.referrer);
  if (
    previous &&
    previous.origin === current.origin &&
    previous.pathname !== current.pathname
  ) {
    current.replace(previous.href);
  } else {
    current.replace('/');
  }
}

export default function AccountPageEntry(
  props: NonNullable<ComponentProps<typeof Account>>,
) {
  const title = props.continueListing ? publishTitle : loginTitle;
  return (
    <Account
      {...props}
      compactEntry
      entryTitle={title}
      renderEntry={(content) => (
        <AuthDialog
          title={props.recoverAccess ? 'Восстановить доступ' : title}
          onClose={closeDirectEntry}
        >
          {content}
        </AuthDialog>
      )}
    />
  );
}
