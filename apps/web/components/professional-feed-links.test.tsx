import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import ProfessionalFeedLinks from './professional-feed-links';
import { api } from '../lib/client';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const base = 'v1/organizations/org-1/feeds';
const feed = {
  id: 'feed-1',
  provider: 'cian',
  host: 'feeds.example',
  active: true,
};
const run = {
  id: 'run-1',
  status: 'quarantined',
  stats: { total: 11, valid: 10, quarantined: 1 },
  error: null,
};
const reportPath = base + '/feed-1/runs/run-1';
test('unverified sellers have a next step before reading private feed data', async () => {
  const verify = vi.fn();
  render(<ProfessionalFeedLinks onVerifyContacts={verify} />);
  fireEvent.click(screen.getByText('Мои XML-выгрузки'));
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Подтвердить почту и телефон для импорта',
    }),
  );
  expect(verify).toHaveBeenCalledOnce();
  expect(api).not.toHaveBeenCalled();
});
async function openSection(personal = false) {
  fireEvent.click(
    screen.getByText(
      personal ? 'Мои XML-выгрузки' : 'XML-выгрузки организации',
    ),
  );
  return within(await screen.findByRole('region', { name: 'ЦИАН' }));
}
test('offers four providers and loads counts and rejected rows for the queued run, never echoes the saved URL', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === base + '/links') return [];
    if (path === base + '/link')
      return { feed, preview: { runId: run.id, status: 'queued' } };
    if (path === reportPath) return run;
    if (path === reportPath + '/items?errorsOnly=true&limit=20')
      return [
        {
          external_reference: 'кв-25',
          errors: [{ code: 'validation', message: 'Укажите цену.' }],
        },
      ];
    throw new Error('Unexpected request');
  });
  render(<ProfessionalFeedLinks organizationId="org-1" />);
  const row = await openSection();
  expect(screen.getAllByRole('textbox')).toHaveLength(4);
  fireEvent.change(row.getByLabelText('ЦИАН'), {
    target: { value: 'https://feeds.example/cian.xml?token=secret' },
  });
  fireEvent.click(row.getByRole('button', { name: 'Проверить' }));
  expect(
    await row.findByText(
      'Проверено объектов — 11. Прошли проверку — 10. С ошибками — 1.',
    ),
  ).toBeTruthy();
  expect(api).toHaveBeenCalledWith(
    base + '/link',
    'POST',
    { provider: 'cian', url: 'https://feeds.example/cian.xml?token=secret' },
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
  expect(row.queryByDisplayValue(/secret/)).toBeNull();
  fireEvent.click(row.getByRole('button', { name: 'Посмотреть ошибки' }));
  expect(await row.findByText('кв-25')).toBeTruthy();
  expect(await row.findByText(/Укажите цену/)).toBeTruthy();
});

test('reopens an existing personal source, checks it without its URL, and scopes a replacement to the personal account', async () => {
  const personal = 'v1/account/feeds';
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/links')) return [{ ...feed, lastRunId: 'old-run' }];
    if (path.endsWith('/link'))
      return { feed, preview: { runId: 'new-run', status: 'queued' } };
    return { id: 'run', status: 'running', stats: {}, error: null };
  });
  render(<ProfessionalFeedLinks />);
  const row = await openSection(true);
  expect(row.getByText(/Ссылка сохранена · feeds.example/)).toBeTruthy();
  expect(await row.findByText(/Проверка в очереди/)).toBeTruthy();
  fireEvent.click(row.getByRole('button', { name: 'Проверить ещё раз' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      personal + '/link',
      'POST',
      { provider: 'cian' },
      expect.anything(),
    ),
  );
  const input = row.getByLabelText('ЦИАН');
  fireEvent.change(input, { target: { value: 'https://new.example/feed' } });
  fireEvent.click(row.getByRole('button', { name: 'Проверить' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      personal + '/link',
      'POST',
      { provider: 'cian', url: 'https://new.example/feed' },
      expect.anything(),
    ),
  );
  expect(row.queryByText(/Прошли проверку/)).toBeNull();
});

test('changing organizations clears link drafts and ignores a late report from the previous organization', async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === base + '/links') return [{ ...feed, lastRunId: 'run-1' }];
    if (path === reportPath)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return [];
  });
  const view = render(<ProfessionalFeedLinks organizationId="org-1" />);
  const row = await openSection();
  fireEvent.change(row.getByLabelText('ЦИАН'), {
    target: { value: 'https://private.example/old' },
  });
  view.rerender(<ProfessionalFeedLinks organizationId="org-2" />);
  finish(run);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('v1/organizations/org-2/feeds/links'),
  );
  expect(screen.queryByDisplayValue(/private.example/)).toBeNull();
  expect(screen.queryByText(/Прошли проверку/)).toBeNull();
});

test('a file in the wrong slot names the matching field and keeps the link marked as saved', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/links')
      ? [{ ...feed, lastRunId: 'wrong-slot' }]
      : {
          id: 'wrong-slot',
          status: 'failed',
          stats: {},
          error: 'feed_provider_mismatch_avito',
        },
  );
  render(<ProfessionalFeedLinks organizationId="org-1" />);
  const row = await openSection();
  expect((await row.findByRole('alert')).textContent).toContain(
    'Вставьте ссылку в поле «Авито».',
  );
  expect(row.getByText(/Ссылка сохранена/)).toBeTruthy();
});

test('retries an uncertain submission with the same key and renders a failed worker result without exposing a feed URL', async () => {
  let submissions = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/links')) return [];
    if (path.endsWith('/link')) {
      if (++submissions === 1) throw new Error('upstream details');
      return { feed, preview: { runId: 'finished' } };
    }
    return {
      id: 'finished',
      status: 'failed',
      stats: {},
      error: 'invalid_feed',
    };
  });
  render(<ProfessionalFeedLinks organizationId="org-1" />);
  const row = await openSection();
  fireEvent.change(row.getByLabelText('ЦИАН'), {
    target: { value: 'https://feeds.example/feed?key=secret' },
  });
  fireEvent.click(row.getByRole('button', { name: 'Проверить' }));
  await row.findByRole('alert');
  fireEvent.click(row.getByRole('button', { name: 'Проверить' }));
  expect(await row.findByText(/Не удалось прочитать XML/)).toBeTruthy();
  const calls = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path.endsWith('/link'));
  expect(calls[0]![3]?.idempotencyKey).toBe(calls[1]![3]?.idempotencyKey);
  fireEvent.click(row.getByRole('button', { name: 'Проверить ещё раз' }));
  await waitFor(() => expect(submissions).toBe(3));
  const fresh = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path.endsWith('/link'))[2]!;
  expect(fresh[3]?.idempotencyKey).not.toBe(calls[1]![3]?.idempotencyKey);
  expect(row.queryByText(/upstream details|key=secret/)).toBeNull();
});
