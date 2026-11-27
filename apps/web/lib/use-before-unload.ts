import { useEffect } from 'react';

export function useBeforeUnload(hasUnsavedChanges: boolean) {
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warnAboutUnsavedChanges);
    return () =>
      window.removeEventListener('beforeunload', warnAboutUnsavedChanges);
  }, [hasUnsavedChanges]);
}
