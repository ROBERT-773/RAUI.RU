import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import StaffPermissions from './staff-permissions';
import { api } from '../lib/client';
vi.mock('../lib/client', () => ({ api: vi.fn() }));
const target = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test('admin selects a user and grants an explicitly named permission with a reason', async () => {
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === 'v1/admin/users')
      return [
        { id: target, email: 'staff@example.test', display_name: 'Модератор' },
      ];
    if (method === 'PATCH')
      return { userId: target, permission: 'moderation.read', granted: true };
    return { userId: target, permissions: [] };
  });
  render(<StaffPermissions />);
  await screen.findByRole('option', { name: 'Модератор — staff@example.test' });
  fireEvent.change(screen.getByLabelText('Сотрудник'), {
    target: { value: target },
  });
  await screen.findByText('Нет выданных разрешений.');
  fireEvent.change(screen.getByLabelText('Причина изменения'), {
    target: { value: 'Назначение проверки объявлений' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Выдать разрешение' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `v1/admin/users/${target}/permissions`,
      'PATCH',
      {
        permission: 'moderation.read',
        granted: true,
        reason: 'Назначение проверки объявлений',
      },
    ),
  );
  await screen.findByText('Разрешение выдано.');
});
test('rejected admin access reveals no controls or private user data', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Доступ запрещён.'));
  render(<StaffPermissions />);
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Сотрудник')).toBeNull();
});

test('admin can reach staff beyond the first page of users', async () => {
  const users = Array.from({ length: 100 }, (_, index) => ({
    id: `user-${index}`,
    email: `${index}@example.test`,
    display_name: `Staff ${index}`,
  }));
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/admin/users'
      ? users
      : [
          {
            id: target,
            email: 'later@example.test',
            display_name: 'Later staff',
          },
        ],
  );
  render(<StaffPermissions />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Загрузить ещё сотрудников' }),
  );
  await screen.findByRole('option', {
    name: 'Later staff — later@example.test',
  });
  expect(api).toHaveBeenCalledWith('v1/admin/users?after=user-99');
});
