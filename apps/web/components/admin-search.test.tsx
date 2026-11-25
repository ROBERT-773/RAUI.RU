import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../lib/client';
import { feedbackIdentityEvent } from '../lib/feedback-draft';
import AdminSearch from './admin-search';

vi.mock('../lib/client', async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const admin = {
  id: 'staff-one',
  role: 'admin',
  registration_approval_state: 'approved',
};
const person = {
  id: 'private-user',
  publicId: '442',
  name: 'Марина Иванова',
  email: 'seller@example.test',
  role: 'agent',
  active: true,
  matchedPhone: '+74950000000',
};
const flat = {
  id: 'listed',
  title: 'Квартира с балконом',
  address: 'Москва, Тестовая улица',
  dealType: 'sale',
  status: 'published',
  sellerPublicId: '442',
  publiclyVisible: true,
};
const denied = 'Для поиска нужен доступ администратора.';
type Reply = (path: string, body?: unknown) => unknown;
function setup(search: Reply, me: () => unknown = () => admin) {
  vi.mocked(api).mockImplementation(async (path, _method, body) =>
    path === 'v1/auth/me' ? me() : search(path, body),
  );
  return render(<AdminSearch />);
}
async function find(term: string, label = 'Поиск пользователей') {
  const input = await screen.findByRole('textbox', { name: label });
  fireEvent.change(input, { target: { value: term } });
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  return input;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

test('opens a matched user’s listings and clears the seller filter for a new listing search', async () => {
  setup((path) => ({
    items: path.endsWith('/users') ? [person] : [flat],
    nextCursor: null,
  }));
  await find('8 (495) 000-00-00');
  fireEvent.click(
    await screen.findByRole('button', { name: 'Объявления пользователя' }),
  );
  await screen.findByRole('heading', { name: flat.title });
  expect(api).toHaveBeenCalledWith('v1/admin/search/listings', 'POST', {
    query: person.publicId,
    by: 'seller',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Искать другие объявления' }),
  );
  await find('Тестовая улица', 'Поиск объявлений');
  await screen.findByRole('heading', { name: flat.title });
  expect(api).toHaveBeenCalledWith('v1/admin/search/listings', 'POST', {
    query: 'Тестовая улица',
  });
});

test('waits for a confirmed administrator and never loads the user directory to check access', async () => {
  const identity = deferred<unknown>();
  setup(
    () => {
      throw new Error('unexpected search');
    },
    () => identity.promise,
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => identity.resolve({ ...admin, role: 'buyer' }));
  expect(await screen.findByText(denied)).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(vi.mocked(api).mock.calls).toEqual([['v1/auth/me']]);
});
test('searches privately by formatted phone and can retry a failed next page without losing prior matches', async () => {
  let next = 0;
  setup((_path, body) => {
    if (body && typeof body === 'object' && 'after' in body) {
      if (!next++) throw new Error('offline');
      return {
        items: [
          {
            ...person,
            id: 'another',
            name: 'Второй агент',
            matchedPhone: null,
          },
        ],
        nextCursor: null,
      };
    }
    return { items: [person], nextCursor: 'cursor' };
  });
  const term = '8 (495) 000-00-00';
  await find(term);
  const row = (
    await screen.findByRole('heading', { name: person.name })
  ).closest('li')!;
  expect(within(row).getByText(person.email)).toBeTruthy();
  expect(within(row).getByText(person.matchedPhone)).toBeTruthy();
  expect(within(row).getByText(person.publicId)).toBeTruthy();
  expect(api).toHaveBeenCalledWith('v1/admin/search/users', 'POST', {
    query: term,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByRole('alert');
  expect(screen.getByText(person.name)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await screen.findByText('Второй агент');
  expect(api).toHaveBeenCalledWith('v1/admin/search/users', 'POST', {
    query: term,
    after: 'cursor',
  });
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  expect(window.location.search).toBe('');
  expect(
    [JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join(''),
  ).not.toContain(term);
});
test('a late user result cannot replace listings; hidden listings have no public link', async () => {
  const pending = deferred<unknown>();
  setup((path) =>
    path.endsWith('users')
      ? pending.promise
      : {
          items: [
            flat,
            {
              ...flat,
              id: 'private',
              title: 'Непубличная квартира',
              publiclyVisible: false,
            },
          ],
          nextCursor: null,
        },
  );
  await find('Иванова');
  fireEvent.click(screen.getByRole('button', { name: 'Объявления' }));
  expect(screen.queryByDisplayValue('Иванова')).toBeNull();
  await find('  квартира  ', 'Поиск объявлений');
  await screen.findByRole('heading', { name: flat.title });
  await act(async () => pending.resolve({ items: [person], nextCursor: null }));
  expect(screen.queryByText(person.name)).toBeNull();
  const region = screen.getByRole('region', { name: 'Результаты поиска' });
  expect(within(region).getAllByRole('link')).toHaveLength(1);
  expect(
    within(region)
      .getByRole('link', { name: 'Открыть объявление' })
      .getAttribute('href'),
  ).toBe('/listings/listed');
  expect(api).toHaveBeenCalledWith('v1/admin/search/listings', 'POST', {
    query: 'квартира',
  });
});
test('handles empty and invalid queries and clears all private information when access is revoked on the next page', async () => {
  setup((_path, body) => {
    const { query, after } = body as { query: string; after?: string };
    if (after) throw new ApiError('Access denied', 403);
    return query === 'никто'
      ? { items: [], nextCursor: null }
      : { items: [person], nextCursor: 'next' };
  });
  await find('%');
  expect(
    vi.mocked(api).mock.calls.filter(([p]) => p.includes('/admin/search/')),
  ).toHaveLength(0);
  await find('никто');
  await screen.findByText(/Пользователи не найдены\./);
  await find('Марина');
  await screen.findByText(person.email);
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByText(denied);
  expect(screen.queryByText(person.email)).toBeNull();
  expect(screen.queryByDisplayValue('Марина')).toBeNull();
});
test('rechecks the identity when returning to the page; another administrator starts with no results or query', async () => {
  let current = admin;
  setup(
    () => ({ items: [person], nextCursor: null }),
    () => current,
  );
  await find('Марина');
  await screen.findByText(person.email);
  current = { ...admin, id: 'staff-two' };
  fireEvent.focus(window);
  await screen.findByDisplayValue('');
  expect(screen.queryByText(person.email)).toBeNull();
  await find('Марина');
  await screen.findByText(person.email);
  current = { ...admin, role: 'buyer' };
  fireEvent(
    window,
    new StorageEvent('storage', { key: feedbackIdentityEvent }),
  );
  await screen.findByText(denied);
  expect(screen.queryByText(person.email)).toBeNull();
});
