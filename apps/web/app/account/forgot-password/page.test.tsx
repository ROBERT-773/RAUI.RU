import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { signInCapabilities } from '../../../lib/sign-in-capabilities';
import Page from './page';

vi.mock('../../../lib/sign-in-capabilities', () => ({
  signInCapabilities: vi.fn(),
}));
afterEach(cleanup);

test('offers an email link when only link delivery is available', async () => {
  vi.mocked(signInCapabilities).mockResolvedValue({
    smsAvailable: false,
    emailAvailable: false,
    resetLinkAvailable: true,
  });
  render(await Page({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Отправить ссылку' })).toBeTruthy();
});

test('explains an unavailable service before asking for an email', async () => {
  vi.mocked(signInCapabilities).mockResolvedValue({
    smsAvailable: false,
    emailAvailable: false,
    resetLinkAvailable: false,
  });
  render(await Page({ searchParams: Promise.resolve({ mode: 'password' }) }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(
    screen
      .getByRole('link', { name: 'Вернуться ко входу' })
      .getAttribute('href'),
  ).toBe('/account');
});

test('an old link to recovery opens the code flow when only SMS is available', async () => {
  vi.mocked(signInCapabilities).mockResolvedValue({
    smsAvailable: true,
    emailAvailable: false,
    resetLinkAvailable: false,
  });
  await expect(
    Page({ searchParams: Promise.resolve({ mode: 'password' }) }),
  ).rejects.toMatchObject({
    digest: expect.stringContaining('/account?action=recover'),
  });
});
