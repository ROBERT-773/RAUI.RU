type FeedbackDraft = {
  owner: string | null;
  message: string;
  requestId: string;
};

const key = 'raui_feedback_draft';
export const feedbackIdentityEvent = 'raui_feedback_identity_changed';

export function announceFeedbackIdentityChange() {
  try {
    localStorage.setItem(feedbackIdentityEvent, crypto.randomUUID());
  } catch {
    // The form also checks its owner before every submission.
  }
}

export function readFeedbackDraft(): FeedbackDraft | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(key) || 'null');
    return data &&
      (typeof data.owner === 'string' || data.owner === null) &&
      typeof data.message === 'string' &&
      data.message.length <= 2000 &&
      typeof data.requestId === 'string' &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(data.requestId)
      ? data
      : null;
  } catch {
    return null;
  }
}

export function storeFeedbackDraft(draft: FeedbackDraft) {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearFeedbackDraft() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Storage may be unavailable. */
  }
}

export function resumeFeedbackAfterLogin(owner: string) {
  const draft = readFeedbackDraft();
  if (draft?.owner === null) storeFeedbackDraft({ ...draft, owner });
  else if (draft && draft.owner !== owner) clearFeedbackDraft();
  window.location.replace('/?feedback=1#beta-feedback');
}
