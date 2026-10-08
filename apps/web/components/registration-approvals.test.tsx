import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { api } from '../lib/client';
import RegistrationApprovals from './registration-approvals';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
const item = {
  id: 'request-1',
  user_id: 'user-1',
  public_id: '42',
  display_name: 'Заявитель',
  role: 'owner',
  email_verified_at: 'today',
  phone_verified_at: 'today',
  requested_at: '2026-10-08',
};
const detail = {
  ...item,
  email: 'user@example.test',
  phone: '+79990000000',
  state: 'pending',
  reason: null,
  resolved_at: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(fail = false, verified = true) {
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST') {
      if (fail) throw new Error('Forbidden');
      return {
        id: item.id,
        user_id: item.user_id,
        state: 'approved',
        reason: 'Проверено вручную',
        resolved_at: 'today',
      };
    }
    if (path.endsWith(item.id))
      return { ...detail, phone_verified_at: verified ? 'today' : null };
    return { items: [item], cursor: null };
  });
  render(<RegistrationApprovals />);
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Открыть заявку/ }),
  );
  await screen.findByText('user@example.test');
}
async function prepare() {
  await open();
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Проверено вручную' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
}
test('decision requires contact verification, reason and explicit confirmation', async () => {
  setup();
  await open();
  expect(
    (screen.getByRole('button', { name: 'Одобрить' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Проверено вручную' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
  expect(vi.mocked(api).mock.calls.some((call) => call[1] === 'POST')).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await screen.findByText('Решение сохранено.');
  expect(api).toHaveBeenCalledWith(
    'v1/admin/registration-approvals/request-1/decision',
    'POST',
    { decision: 'approve', reason: 'Проверено вручную' },
    { idempotencyKey: expect.any(String) },
  );
});
test('unverified phone prevents approval but allows reasoned rejection', async () => {
  setup(false, false);
  await open();
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Проверено вручную' },
  });
  expect(
    (screen.getByRole('button', { name: 'Одобрить' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Отклонить' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
test('denied decision reports no success and retains exact retry payload/key', async () => {
  setup(true);
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await screen.findByRole('alert');
  const first = vi.mocked(api).mock.calls.find((call) => call[1] === 'POST');
  expect(screen.queryByText('Решение сохранено.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.filter((call) => call[1] === 'POST'),
    ).toHaveLength(2),
  );
  expect(
    vi.mocked(api).mock.calls.filter((call) => call[1] === 'POST')[1],
  ).toEqual(first);
});
test('queue denial reveals no applicant contacts or decisions', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Forbidden'));
  render(<RegistrationApprovals />);
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Причина решения')).toBeNull();
  expect(screen.queryByText('user@example.test')).toBeNull();
});
test('pagination encodes opaque cursor and appends applicants', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('?after=')
      ? {
          items: [{ ...item, id: 'request-2', display_name: 'Следующий' }],
          cursor: null,
        }
      : { items: [item], cursor: 'opaque+/=' },
  );
  render(<RegistrationApprovals />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Загрузить ещё заявки' }),
  );
  await screen.findByRole('button', { name: /Следующий/ });
  expect(api).toHaveBeenCalledWith(
    'v1/admin/registration-approvals?after=opaque%2B%2F%3D',
  );
});
test('late earlier applicant details cannot replace current selection', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('request-1'))
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    if (path.endsWith('request-2'))
      return { ...detail, id: 'request-2', email: 'current@example.test' };
    return {
      items: [item, { ...item, id: 'request-2', display_name: 'Следующий' }],
      cursor: null,
    };
  });
  render(<RegistrationApprovals />);
  fireEvent.click(await screen.findByRole('button', { name: /Заявитель/ }));
  fireEvent.click(screen.getByRole('button', { name: /Следующий/ }));
  await screen.findByText('current@example.test');
  resolveFirst(detail);
  await waitFor(() =>
    expect(screen.queryByText('user@example.test')).toBeNull(),
  );
});

test('success remains honest when queue refresh fails and can reload', async () => {
  let queueCalls = 0;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST')
      return { id: item.id, user_id: item.user_id, state: 'approved' };
    if (path.endsWith(item.id)) return detail;
    if (++queueCalls === 2) throw new Error('Network');
    return { items: [item], cursor: null };
  });
  render(<RegistrationApprovals />);
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await screen.findByText('Решение сохранено.');
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: /Открыть заявку/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Обновить очередь' }));
  await screen.findByRole('button', { name: /Открыть заявку/ });
});
test('pending decision disables navigation and cannot repeat dispatch', async () => {
  let resolveDecision: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST')
      return new Promise((resolve) => {
        resolveDecision = resolve;
      });
    if (path.endsWith(item.id)) return detail;
    return { items: [item], cursor: null };
  });
  render(<RegistrationApprovals />);
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  expect(
    (
      screen.getByRole('button', {
        name: /Открыть заявку/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole('button', {
        name: 'Подтвердить решение',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  resolveDecision({ id: item.id, user_id: item.user_id, state: 'approved' });
  await screen.findByText('Решение сохранено.');
});
test('unmounted decision cannot refresh queue or report a late success', async () => {
  let resolveDecision: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST')
      return new Promise((resolve) => {
        resolveDecision = resolve;
      });
    if (path.endsWith(item.id)) return detail;
    return { items: [item], cursor: null };
  });
  const rendered = render(<RegistrationApprovals />);
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  rendered.unmount();
  resolveDecision({ id: item.id, user_id: item.user_id, state: 'approved' });
  await waitFor(() =>
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          (call) => call[0] === 'v1/admin/registration-approvals',
        ),
    ).toHaveLength(1),
  );
});
