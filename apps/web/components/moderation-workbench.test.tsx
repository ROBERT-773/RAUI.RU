import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { api } from '../lib/client';
import ModerationWorkbench from './moderation-workbench';
vi.mock('../lib/client', () => ({
  api: vi.fn(),
  money: (value: number) => String(value),
}));
const material = {
  caseId: 'case-1',
  listingVersion: 2,
  listing: {
    id: 'listing-1',
    title: 'Квартира',
    description: 'Реальный объект',
    price: 100,
    deal_type: 'sale',
    version: 2,
  },
  property: { address: 'Москва', category_code: 'flat', attributes: {} },
  media: [],
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(fail = false) {
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST') {
      if (fail) throw new Error('Доступ запрещён.');
      return { status: 'published' };
    }
    if (path.endsWith('/materials')) return material;
    return [
      {
        id: 'case-1',
        listing_id: 'listing-1',
        listing_version: 2,
        state: 'pending',
      },
    ];
  });
  render(<ModerationWorkbench />);
}
async function select() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Открыть проверку/ }),
  );
  await screen.findByText('Квартира');
}
test('manual decision requires reason and separate confirmation', async () => {
  setup();
  await select();
  fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
  expect(api).not.toHaveBeenCalledWith(
    expect.anything(),
    'POST',
    expect.anything(),
    expect.anything(),
  );
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Объект проверен' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
  expect(
    screen.getByRole('button', { name: 'Подтвердить решение' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      'v1/admin/moderation/case-1/decision',
      'POST',
      { decision: 'approve', reason: 'Объект проверен' },
      { idempotencyKey: expect.any(String) },
    ),
  );
  await screen.findByText('Решение сохранено.');
});
test('denial never reports success and retry retains action key', async () => {
  setup(true);
  await select();
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Недостоверные сведения' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Решение сохранено.')).toBeNull();
  const first = vi.mocked(api).mock.calls.find((x) => x[1] === 'POST');
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.filter((x) => x[1] === 'POST'),
    ).toHaveLength(2),
  );
  expect(
    vi.mocked(api).mock.calls.filter((x) => x[1] === 'POST')[1]?.[3],
  ).toEqual(first?.[3]);
});
test('queue denial exposes no private materials or decisions', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Доступ запрещён.'));
  render(<ModerationWorkbench />);
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Причина решения')).toBeNull();
});

test('late materials from earlier selection cannot replace current case', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('case-1/materials'))
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    if (path.endsWith('case-2/materials'))
      return {
        ...material,
        caseId: 'case-2',
        listing: { ...material.listing, title: 'Текущий объект' },
      };
    return [
      {
        id: 'case-1',
        listing_id: 'first',
        listing_version: 2,
        state: 'pending',
      },
      {
        id: 'case-2',
        listing_id: 'second',
        listing_version: 2,
        state: 'pending',
      },
    ];
  });
  render(<ModerationWorkbench />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Открыть проверку first/ }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: /Открыть проверку second/ }),
  );
  await screen.findByText('Текущий объект');
  resolveFirst(material);
  await waitFor(() => expect(screen.queryByText('Квартира')).toBeNull());
  expect(screen.getByText('Текущий объект')).toBeTruthy();
});
test('material denial never reveals decision controls', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/materials')) throw new Error('Forbidden');
    return [
      {
        id: 'case-1',
        listing_id: 'listing-1',
        listing_version: 2,
        state: 'pending',
      },
    ];
  });
  render(<ModerationWorkbench />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Открыть проверку/ }),
  );
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Причина решения')).toBeNull();
});

test('safe ready photos and advisory findings require explicit human decision', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/materials')
      ? {
          ...material,
          listing: {
            ...material.listing,
            description:
              'Требуется предоплата до просмотра и паспорт в telegram',
          },
          media: [
            { id: 'safe-photo', kind: 'photo', state: 'ready' },
            { id: 'pending-photo', kind: 'photo', state: 'pending' },
          ],
        }
      : [
          {
            id: 'case-1',
            listing_id: 'listing-1',
            listing_version: 2,
            state: 'pending',
          },
        ],
  );
  render(<ModerationWorkbench />);
  await select();
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    '/api/v1/admin/moderation/case-1/media/safe-photo/small',
  );
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.getByText(/Проверьте условия аванса/)).toBeTruthy();
  expect(screen.getByText(/Проверьте запрос персональных данных/)).toBeTruthy();
  expect(vi.mocked(api).mock.calls.every((call) => call[1] !== 'POST')).toBe(
    true,
  );
});

test('pending decision disables repeated actions until server responds', async () => {
  let resolveDecision: (value: unknown) => void = () => {};
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === 'POST')
      return new Promise((resolve) => {
        resolveDecision = resolve;
      });
    if (path.endsWith('/materials')) return material;
    return [
      {
        id: 'case-1',
        listing_id: 'listing-1',
        listing_version: 2,
        state: 'pending',
      },
    ];
  });
  render(<ModerationWorkbench />);
  await select();
  fireEvent.change(screen.getByLabelText('Причина решения'), {
    target: { value: 'Проверено вручную' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить решение' }));
  expect(
    (
      screen.getByRole('button', {
        name: 'Подтвердить решение',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole('button', {
        name: /Открыть проверку/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  resolveDecision({ status: 'published' });
  await screen.findByText('Решение сохранено.');
});

test('known scalar attributes use labels and unknown or nested values stay hidden', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/materials')
      ? {
          ...material,
          property: {
            ...material.property,
            attributes: {
              area: 52,
              rooms: 2,
              balcony: true,
              renovation: '<script>unsafe</script>',
              private_contact: 'secret@example.test',
              floor: { internal: 'secret' },
            },
          },
        }
      : [
          {
            id: 'case-1',
            listing_id: 'listing-1',
            listing_version: 2,
            state: 'pending',
          },
        ],
  );
  render(<ModerationWorkbench />);
  await select();
  expect(screen.getByText('Площадь, м²')).toBeTruthy();
  expect(screen.getByText('52')).toBeTruthy();
  expect(screen.getByText('Да')).toBeTruthy();
  expect(screen.getByText('<script>unsafe</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByText(/secret@example/)).toBeNull();
  expect(screen.queryByText('Этаж')).toBeNull();
});

test('stale material failure can recover through explicit queue refresh', async () => {
  let attempt = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/materials')) {
      if (attempt++ === 0) throw new Error('Stale');
      return material;
    }
    return [
      {
        id: 'case-1',
        listing_id: 'listing-1',
        listing_version: 2,
        state: 'pending',
      },
    ];
  });
  render(<ModerationWorkbench />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Открыть проверку/ }),
  );
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Обновить очередь' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await select();
});
