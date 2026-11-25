import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import AgentPublicProfile from './agent-public-profile';
import { api, ApiError } from '../lib/client';

vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
const request = vi.mocked(api);
const personal = 'v1/search/professional-profile';
const company = personal + '/agency/organization';
const profile = {
  id: 'professional',
  name: 'Анна',
  regionCodes: ['moscow'],
  published: false,
  imageId: null as string | null,
};
const regions = { items: [{ code: 'moscow', name: 'Москва' }] };
const png = () =>
  new File([new Uint8Array([1, 2, 3])], 'портрет.png', { type: 'image/png' });
function show(agency = false) {
  const result = render(
    agency ? (
      <AgentPublicProfile agencyId="organization" />
    ) : (
      <AgentPublicProfile />
    ),
  );
  fireEvent.click(
    screen.getByText(
      agency ? 'Публичный профиль агентства' : 'Публичный профиль агента',
    ),
  );
  return result;
}
const choose = (file: File) =>
  fireEvent.change(screen.getByLabelText('Файл изображения'), {
    target: { files: [file] },
  });
afterEach(() => {
  cleanup();
  request.mockReset();
});

test('saves a new unpublished profile first, then adds, replaces and removes its private portrait', async () => {
  let created = false;
  request.mockImplementation(async (path, method) => {
    if (path === 'v1/regions') return regions;
    if (path === personal && method === 'PATCH') {
      created = true;
      return profile;
    }
    if (path === personal) return { profile: created ? profile : null };
    if (path === personal + '/image' && method === 'PUT')
      return {
        imageId:
          request.mock.calls.filter(([, verb]) => verb === 'PUT').length === 1
            ? 'first'
            : 'second',
      };
    if (path === personal + '/image/second' && method === 'DELETE')
      return { imageId: null };
    throw Error(path);
  });
  show();
  await screen.findByText('Сохраните профиль, чтобы добавить фото агента.');
  expect(screen.queryByLabelText('Файл изображения')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Публичное имя' }), {
    target: { value: 'Анна' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }));
  const editor = await screen.findByRole('region', { name: 'Фото агента' });
  choose(png());
  fireEvent.click(
    within(editor).getByRole('button', { name: 'Загрузить фото' }),
  );
  const first = await within(editor).findByRole('img', { name: 'Фото агента' });
  expect(first.getAttribute('src')).toBe('/api/' + personal + '/image/first');
  expect(request).toHaveBeenCalledWith(personal + '/image', 'PUT', {
    filename: 'портрет.png',
    mime: 'image/png',
    base64: 'AQID',
    expectedImageId: null,
  });
  choose(png());
  fireEvent.click(
    within(editor).getByRole('button', { name: 'Заменить фото' }),
  );
  await waitFor(() =>
    expect(within(editor).getByRole('img').getAttribute('src')).toBe(
      '/api/' + personal + '/image/second',
    ),
  );
  expect(request).toHaveBeenCalledWith(
    personal + '/image',
    'PUT',
    expect.objectContaining({ expectedImageId: 'first' }),
  );
  fireEvent.click(within(editor).getByRole('button', { name: 'Удалить фото' }));
  await within(editor).findByText('Изображение удалено.');
  expect(within(editor).queryByRole('img')).toBeNull();
  expect(request).toHaveBeenCalledWith(personal + '/image/second', 'DELETE');
  expect(
    screen.queryByRole('link', { name: 'Открыть публичный профиль' }),
  ).toBeNull();
});

test('on an agency conflict shows the current logo and requires an explicit new selection, preserving unsaved metadata', async () => {
  let reads = 0;
  request.mockImplementation(async (path, method) => {
    if (path === 'v1/regions') return regions;
    if (path === company)
      return {
        profile: { ...profile, imageId: ++reads === 1 ? 'old' : 'changed' },
      };
    if (method === 'PUT') throw new ApiError('changed', 409);
    throw Error(path);
  });
  show(true);
  await screen.findByRole('region', { name: 'Логотип агентства' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Публичное имя' }), {
    target: { value: 'Название в работе' },
  });
  choose(png());
  fireEvent.click(screen.getByRole('button', { name: 'Заменить логотип' }));
  await screen.findByText(/Изображение уже изменилось/);
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      '/api/' + company + '/image/changed',
    ),
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Заменить логотип' })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>('textbox', { name: 'Публичное имя' })
      .value,
  ).toBe('Название в работе');
  expect(request.mock.calls.filter(([, verb]) => verb === 'PUT')).toHaveLength(
    1,
  );
});

test('invalid file is rejected locally and loss of permissions removes the private preview and editing controls', async () => {
  request.mockImplementation(async (path, method) => {
    if (path === 'v1/regions') return regions;
    if (path === company) return { profile: { ...profile, imageId: 'logo' } };
    if (method === 'DELETE') throw new ApiError('denied', 403);
    throw Error(path);
  });
  show(true);
  await screen.findByRole('img', { name: 'Логотип агентства' });
  choose(new File(['svg'], 'logo.svg', { type: 'image/svg+xml' }));
  expect(screen.getByRole('alert').textContent).toContain('JPG, PNG или WebP');
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Заменить логотип' })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Удалить логотип' }));
  await screen.findByText(/Доступ к изменению этого профиля закрыт/);
  expect(screen.queryByRole('img')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Сохранить профиль' }),
  ).toBeNull();
});

test('switching an organization during upload cannot place its logo on another profile', async () => {
  let complete: (data: { imageId: string }) => void = () => {
    throw Error('Not uploading');
  };
  request.mockImplementation(async (path, method) => {
    if (path === 'v1/regions') return regions;
    if (path.endsWith('/image') && method === 'PUT')
      return new Promise((resolve) => {
        complete = resolve;
      });
    return {
      profile: {
        ...profile,
        id: path.endsWith('/second') ? 'second' : 'first',
      },
    };
  });
  const view = show(true);
  await screen.findByLabelText('Файл изображения');
  choose(png());
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить логотип' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      company + '/image',
      'PUT',
      expect.any(Object),
    ),
  );
  view.rerender(<AgentPublicProfile agencyId="second" />);
  fireEvent.click(screen.getByText('Публичный профиль агентства'));
  await screen.findByLabelText('Файл изображения');
  await act(async () => {
    complete({ imageId: 'old-logo' });
  });
  expect(screen.queryByRole('img')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Загрузить логотип' }),
  ).toBeTruthy();
});

test('a lost upload response and unavailable refresh keep stale replacement disabled until the profile is fetched again', async () => {
  let reads = 0;
  request.mockImplementation(async (path, method) => {
    if (path === 'v1/regions') return regions;
    if (method === 'PUT') throw Error('lost response');
    if (path === personal) {
      reads++;
      if (reads === 2) throw Error('offline');
      return {
        profile: { ...profile, imageId: reads === 1 ? 'before' : 'after' },
      };
    }
    throw Error(path);
  });
  show();
  await screen.findByRole('img', { name: 'Фото агента' });
  choose(png());
  fireEvent.click(screen.getByRole('button', { name: 'Заменить фото' }));
  const retry = await screen.findByRole('button', {
    name: 'Проверить текущее изображение',
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Удалить фото' })
      .disabled,
  ).toBe(true);
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      '/api/' + personal + '/image/after',
    ),
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Удалить фото' })
      .disabled,
  ).toBe(false);
  expect(request.mock.calls.filter(([, verb]) => verb === 'PUT')).toHaveLength(
    1,
  );
});
