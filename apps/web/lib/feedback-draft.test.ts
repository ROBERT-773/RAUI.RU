import { afterEach, expect, test, vi } from 'vitest';
import {
  clearFeedbackDraft,
  readFeedbackDraft,
  resumeFeedbackAfterLogin,
  storeFeedbackDraft,
} from './feedback-draft';

afterEach(() => {
  vi.unstubAllGlobals();
  clearFeedbackDraft();
});

test('the explicit guest login binds the suggestion to its author and returns to the fixed homepage dialog', () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { replace } });
  const draft = {
    owner: null,
    message: 'Точный адрес на карте',
    requestId: crypto.randomUUID(),
  };
  storeFeedbackDraft(draft);
  resumeFeedbackAfterLogin('first');
  expect(readFeedbackDraft()).toEqual({ ...draft, owner: 'first' });
  expect(replace).toHaveBeenCalledWith('/?feedback=1#beta-feedback');
  resumeFeedbackAfterLogin('second');
  expect(readFeedbackDraft()).toBeNull();
});
