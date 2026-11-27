import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import NewListing from './new-listing';
import { api, ApiError } from '../lib/client';
vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(fail: boolean | ApiError = false) {
  let failed = false;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === 'v1/account/listing-drafts') return [];
    if (path.startsWith('v1/geo/geocode?'))
      return [
        {
          formatted: 'Москва, улица 1',
          locality: 'Москва',
          regionCode: 'moscow',
          longitude: 37.6,
          latitude: 55.7,
        },
        {
          formatted: 'Тула, улица 1',
          locality: 'Тула',
          regionCode: 'tula',
          longitude: 37.6,
          latitude: 54.2,
        },
      ];
    if (path === 'v1/organizations')
      return [
        {
          id: 'agency-1',
          name: 'Город',
          kind: 'agency',
          active: true,
          membership_active: true,
        },
        {
          id: 'agency-2',
          name: 'Архивное агентство',
          kind: 'agency',
          active: true,
          membership_active: false,
        },
      ];
    if (path === 'v1/categories')
      return [
        { code: 'apartment', name: 'Квартира' },
        { code: 'land', name: 'Участок' },
        { code: 'commercial', name: 'Коммерческая недвижимость' },
      ];
    if (path === 'v1/categories/commercial/attributes')
      return [
        {
          code: 'commercial_property_type',
          name: 'Тип коммерческого помещения',
          kind: 'enum',
          required: true,
          options: ['Офис', 'Склад', 'Коммерческая земля'],
        },
        {
          code: 'area',
          name: 'Площадь',
          kind: 'number',
          required: true,
          options: [],
        },
        {
          code: 'floor',
          name: 'Этаж',
          kind: 'number',
          required: false,
          options: [],
        },
        {
          code: 'floors',
          name: 'Этажей',
          kind: 'number',
          required: false,
          options: [],
        },
      ];
    if (path.endsWith('/attributes'))
      return [
        {
          code: 'area',
          name: 'Площадь',
          kind: 'number',
          required: true,
          options: [],
        },
        {
          code: 'floor',
          name: 'Этаж',
          kind: 'number',
          required: false,
          options: [],
        },
        {
          code: 'floors',
          name: 'Этажей',
          kind: 'number',
          required: false,
          options: [],
        },
      ];
    if (path === 'v1/properties' && method === 'POST')
      return { id: 'property-1' };
    if (path === 'v1/listings' && method === 'POST') {
      if (fail && !failed) {
        failed = true;
        throw fail instanceof ApiError ? fail : new Error('Недоступно');
      }
      return { id: 'listing-1' };
    }
    throw new Error(path);
  });
}
function setupListingDrafts(failFirstListing = false) {
  setup(failFirstListing);
  const fallback = vi.mocked(api).getMockImplementation()!;
  const drafts = new Map<
    string,
    { id: string; version: number; form: Record<string, unknown> }
  >();
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === 'v1/account/listing-drafts') return [...drafts.values()];
    if (path.startsWith('v1/account/listing-drafts/') && method === 'PUT') {
      const id = path.split('/').at(-1)!;
      const { version, form } = body as {
        version: number;
        form: Record<string, unknown>;
      };
      if ((drafts.get(id)?.version ?? 0) !== version)
        throw new ApiError('Conflict', 409);
      const existing = drafts.get(id);
      if (existing && JSON.stringify(existing.form) === JSON.stringify(form))
        return existing;
      const row = { id, version: version + 1, form };
      drafts.set(id, row);
      return row;
    }
    return fallback(path, method, body, options);
  });
  return drafts;
}

test('an incomplete address and its step return from the account after a remount, alongside another draft', async () => {
  const drafts = setupListingDrafts();
  const saved = vi.fn();
  const view = render(<NewListing onCreated={saved} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Далее' });
  await waitFor(() => expect(next.disabled).toBe(false));
  fireEvent.click(next);
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'Москва, Тверская' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  expect(drafts.size).toBe(1);
  expect([...drafts.values()][0]?.form).toMatchObject({
    step: 1,
    category: 'apartment',
    address: 'Москва, Тверская',
    longitude: '',
    latitude: '',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Начать другое объявление' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await waitFor(() => expect(drafts.size).toBe(2));
  expect(saved).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([path]) =>
        ['v1/properties', 'v1/listings'].includes(path),
      ),
  ).toBe(false);
  view.unmount();
  render(<NewListing onCreated={saved} />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Продолжить.*Тверская/ }),
  );
  expect(screen.getByRole('group', { name: 'Расположение' })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>('Адрес').value).toBe(
    'Москва, Тверская',
  );
  expect(screen.getByRole('button', { name: 'Далее' })).toBeTruthy();
});

test('protects unsaved address edits on reload and releases the warning after saving', async () => {
  setup();
  const view = render(<NewListing onCreated={() => {}} />);
  const canLeave = () =>
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  await screen.findByRole('option', { name: 'Квартира' });
  expect(canLeave()).toBe(true);
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Далее' });
  await waitFor(() => expect(next.disabled).toBe(false));
  fireEvent.click(next);
  const address = screen.getByLabelText('Адрес');
  fireEvent.change(address, { target: { value: 'Москва, Тверская' } });
  expect(canLeave()).toBe(false);

  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  expect(canLeave()).toBe(true);

  fireEvent.change(address, { target: { value: 'Москва, Тверская, 10' } });
  expect(canLeave()).toBe(false);
  fireEvent.change(address, { target: { value: 'Москва, Тверская' } });
  expect(canLeave()).toBe(true);

  fireEvent.change(address, { target: { value: 'Москва, Тверская, 12' } });
  view.unmount();
  expect(canLeave()).toBe(true);
});

test('conflicting partial saves keep local text and require an explicit reload', async () => {
  const drafts = setupListingDrafts();
  render(<NewListing onCreated={() => {}} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  const [row] = [...drafts.values()];
  drafts.set(row!.id, {
    ...row!,
    version: 2,
    form: { ...row!.form, title: 'Другая версия' },
  });
  fireEvent.change(screen.getByLabelText('Сделка'), {
    target: { value: 'long_rent' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик изменился/);
  expect(screen.getByLabelText<HTMLSelectElement>('Сделка').value).toBe(
    'long_rent',
  );
  expect(drafts.get(row!.id)?.form.title).toBe('Другая версия');
  expect(drafts.get(row!.id)?.version).toBe(2);
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить отдельным черновиком' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  expect(drafts.size).toBe(2);
  expect(
    [...drafts.values()].find((draft) => draft.id !== row!.id)?.form.deal,
  ).toBe('long_rent');
});

test('finishing a saved form binds one listing to its last saved version', async () => {
  const drafts = setupListingDrafts();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  const [id] = drafts.keys();
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(drafts.get(id!)?.form).toMatchObject({
    step: 3,
    title: 'Квартира рядом с парком',
  });
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/properties'),
  ).toHaveLength(0);
  expect(api).toHaveBeenCalledWith(
    'v1/listings',
    'POST',
    expect.objectContaining({
      formDraft: { id, version: 2 },
      property: expect.objectContaining({ category: 'apartment' }),
    }),
    { idempotencyKey: 'draft-listing-' + id + '-2' },
  );
});

test('reopening the saved final step after interruption replays one atomic listing request', async () => {
  setupListingDrafts(true);
  const created = vi.fn();
  const first = render(<NewListing onCreated={created} />);
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён в кабинете/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await screen.findByText(/Не удалось перейти к фотографиям/);
  first.unmount();
  render(<NewListing onCreated={created} />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Продолжить.*Квартира рядом/ }),
  );
  const submit = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Перейти к фотографиям',
  });
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/properties'),
  ).toHaveLength(0);
  const writes = vi
    .mocked(api)
    .mock.calls.filter(
      ([path, method]) => path === 'v1/listings' && method === 'POST',
    );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

async function fill(
  deal = 'sale',
  agency?: string,
  region?: string,
  checkFloors = false,
) {
  await screen.findByRole('option', { name: 'Квартира' });
  if (agency) {
    await screen.findByRole('option', { name: 'Город' });
    expect(
      screen.queryByRole('option', { name: 'Архивное агентство' }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('От чьего имени'), {
      target: { value: agency },
    });
  }
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  fireEvent.change(screen.getByLabelText('Сделка'), {
    target: { value: deal },
  });
  await screen.findByLabelText('Площадь *');
  const next = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  next();
  if (region) {
    fireEvent.change(screen.getByLabelText('Регион'), {
      target: { value: region },
    });
  }
  for (const [label, value] of [
    ['Адрес', 'Москва, улица 1'],
    ['Населённый пункт', 'Москва'],
    ['Долгота', '0'],
    ['Широта', '0'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  next();
  if (checkFloors) {
    const form = screen.getByLabelText('Площадь *').closest('form');
    if (!form) throw new Error('Listing form is missing');
    fireEvent.submit(form);
    expect(screen.getByRole('alert').textContent).toBe('Заполните: Площадь');
    fireEvent.change(screen.getByLabelText('Площадь *'), {
      target: { value: '0' },
    });
    next();
    expect(screen.getByRole('alert').textContent).toBe(
      'Укажите значение больше нуля в поле «Площадь».',
    );
  }
  fireEvent.change(screen.getByLabelText('Площадь *'), {
    target: { value: '40' },
  });
  if (checkFloors) {
    fireEvent.change(screen.getByLabelText('Этаж'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Этажей'), {
      target: { value: '5' },
    });
    next();
    expect(screen.getByRole('alert').textContent).toBe(
      'Этаж не может быть больше количества этажей в доме.',
    );
    fireEvent.change(screen.getByLabelText('Этаж'), { target: { value: '5' } });
  }
  next();
  for (const [label, value] of [
    ['Заголовок', 'Квартира рядом с парком'],
    [
      deal === 'long_rent'
        ? 'Цена, ₽ в месяц'
        : deal === 'short_rent'
          ? 'Цена, ₽ за сутки'
          : 'Цена, ₽',
      deal === 'long_rent'
        ? '50000'
        : deal === 'short_rent'
          ? '5000'
          : '5000000',
    ],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
test('an expired session during creation keeps the typed fields and offers sign-in', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    if (path === 'v1/properties')
      throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
    return respond(path, ...args);
  });
  render(<NewListing onCreated={vi.fn()} />);
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  const link = await screen.findByRole('link', { name: 'Войти снова' });
  expect(link.getAttribute('href')).toBe('/account?action=publish');
  expect(screen.getByLabelText<HTMLInputElement>('Заголовок').value).toBe(
    'Квартира рядом с парком',
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Повторить сохранение',
    }).disabled,
  ).toBe(true);
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path === 'v1/listings'),
  ).toBe(false);
});
test.each([
  { role: 'agent', replacement: '', step: 3 },
  { role: 'agency', replacement: 'agency-3', step: 2 },
  { role: 'agency', replacement: '', step: 3 },
])(
  'restored $role draft at step $step requires explicit representation when access is lost (replacement $replacement)',
  async ({ role, replacement, step }) => {
    const drafts = setupListingDrafts();
    const created = vi.fn();
    const initial = render(
      <NewListing sellerRole={role} onCreated={created} />,
    );
    await fill('sale', 'agency-1');
    if (step === 2)
      fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Сохранить в черновики' }),
    );
    await screen.findByText(/Черновик сохранён в кабинете/);
    expect([...drafts.values()][0]?.form.organizationId).toBe('agency-1');
    initial.unmount();
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, ...args) =>
      path === 'v1/organizations'
        ? replacement
          ? [
              {
                id: replacement,
                name: 'Новое агентство',
                kind: 'agency',
                active: true,
                membership_active: true,
              },
            ]
          : []
        : base(path, ...args),
    );
    render(<NewListing sellerRole={role} onCreated={created} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Продолжить.*Квартира рядом/ }),
    );
    const advance = () =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Далее' });
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: step === 3 ? 'Перейти к фотографиям' : 'Далее',
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Изменить выбор на первом шаге',
      }),
    );
    const who = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'От чьего имени',
    });
    expect(who.selectedOptions[0]?.textContent).toContain('недоступно');
    if (role === 'agency' && !replacement) {
      expect(
        screen.queryByRole('option', { name: 'От своего имени' }),
      ).toBeNull();
      expect(advance().disabled).toBe(true);
      return;
    }
    const option = screen.getByRole<HTMLOptionElement>('option', {
      name: replacement ? 'Новое агентство' : 'От своего имени',
    });
    fireEvent.change(who, { target: { value: option.value } });
    fireEvent.click(advance());
    expect(screen.getByLabelText<HTMLInputElement>('Адрес').value).toBe(
      'Москва, улица 1',
    );
    fireEvent.click(advance());
    fireEvent.click(advance());
    fireEvent.click(
      screen.getByRole('button', { name: 'Перейти к фотографиям' }),
    );
    await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
    const write = vi
      .mocked(api)
      .mock.calls.find(
        ([path, method]) => path === 'v1/listings' && method === 'POST',
      );
    const payload = write?.[2] as { property: { organizationId?: string } };
    expect(payload.property.organizationId).toBe(replacement || undefined);
  },
);

test.each([false, true])(
  'restoring coordinates preserves their manual or suggestion origin (%s)',
  async (suggested) => {
    setupListingDrafts();
    const initial = render(<NewListing onCreated={vi.fn()} />);
    await screen.findByRole('option', { name: 'Квартира' });
    fireEvent.change(screen.getByLabelText('Категория'), {
      target: { value: 'apartment' },
    });
    await screen.findByLabelText('Площадь *');
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.change(screen.getByLabelText('Адрес'), {
      target: { value: 'улица 1' },
    });
    if (suggested) {
      fireEvent.click(screen.getByRole('button', { name: 'Найти адрес' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Москва, улица 1' }),
      );
    } else {
      fireEvent.change(screen.getByLabelText('Долгота'), {
        target: { value: '37.6' },
      });
      fireEvent.change(screen.getByLabelText('Широта'), {
        target: { value: '55.7' },
      });
    }
    fireEvent.click(
      screen.getByRole('button', { name: 'Сохранить в черновики' }),
    );
    await screen.findByText(/Черновик сохранён в кабинете/);
    initial.unmount();
    render(<NewListing onCreated={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Продолжить.*улица 1/ }),
    );
    fireEvent.change(screen.getByLabelText('Адрес'), {
      target: { value: 'Москва, улица 2' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Долгота').value).toBe(
      suggested ? '' : '37.6',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Широта').value).toBe(
      suggested ? '' : '55.7',
    );
  },
);

test('an agency without an organization can open its setup section', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) =>
    path === 'v1/organizations' ? [] : respond(path, ...args),
  );
  render(<NewListing onCreated={vi.fn()} sellerRole="agency" />);
  const link = await screen.findByRole('link', {
    name: 'создайте агентство в кабинете',
  });
  expect(link.getAttribute('href')).toBe('/account#agencies');
  expect(
    (screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
test('a revoked agency selection refreshes choices and keeps entered fields', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  let revoked = false;
  vi.mocked(api).mockImplementation(async (path, method, ...args) => {
    if (path === 'v1/properties') {
      revoked = true;
      throw new ApiError('Forbidden', 403);
    }
    if (path === 'v1/organizations' && revoked) return [];
    return respond(path, method, ...args);
  });
  render(<NewListing onCreated={vi.fn()} sellerRole="agent" />);
  await fill('sale', 'agency-1');
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Введённые данные сохранены в форме.',
  );
  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/organizations'),
    ).toHaveLength(2),
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Далее' }).disabled,
  ).toBe(true);
  const personal = await screen.findByRole<HTMLOptionElement>('option', {
    name: 'От своего имени',
  });
  fireEvent.change(screen.getByLabelText('От чьего имени'), {
    target: { value: personal.value },
  });
  const next = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  next();
  expect((screen.getByLabelText('Адрес') as HTMLInputElement).value).toBe(
    'Москва, улица 1',
  );
  next();
  next();
  expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe(
    'Квартира рядом с парком',
  );
});
test('an agency account with multiple organizations submits the explicitly selected one', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    const result = await respond(path, ...args);
    if (path !== 'v1/organizations' || !Array.isArray(result)) return result;
    return [
      ...result,
      {
        id: 'agency-3',
        name: 'Квартал',
        kind: 'agency',
        active: true,
        membership_active: true,
      },
    ];
  });
  const created = vi.fn();
  render(<NewListing onCreated={created} sellerRole="agency" />);
  await screen.findByRole('option', { name: 'Квартал' });
  const representation = screen.getByLabelText(
    'От чьего имени',
  ) as HTMLSelectElement;
  expect(representation.value).toBe('');
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  await screen.findByLabelText('Площадь *');
  expect(
    (screen.getByRole('button', { name: 'Далее' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await fill('sale', 'agency-3');
  expect(screen.getByText('Агентство: Квартал', { exact: true })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/properties',
    'POST',
    expect.objectContaining({ organizationId: 'agency-3' }),
    expect.any(Object),
  );
});
test.each([
  { initialAgencyId: 'agency-1', expected: 'agency-1' },
  { initialAgencyId: 'agency-2', expected: '' },
])(
  'an agent link preselects only an active agency ($initialAgencyId)',
  async ({ initialAgencyId, expected }) => {
    setup();
    render(
      <NewListing
        onCreated={vi.fn()}
        sellerRole="agent"
        initialAgencyId={initialAgencyId}
      />,
    );
    await screen.findByRole('option', { name: 'Город' });
    expect(
      (screen.getByLabelText('От чьего имени') as HTMLSelectElement).value,
    ).toBe(expected);
  },
);
test('an agency account defaults to its only active organization', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} sellerRole="agency" />);
  await screen.findByRole('option', { name: 'Город' });
  expect(
    (screen.getByLabelText('От чьего имени') as HTMLSelectElement).value,
  ).toBe('agency-1');
  expect(
    screen.queryByRole('option', { name: 'Архивное агентство' }),
  ).toBeNull();
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/properties',
    'POST',
    expect.objectContaining({ organizationId: 'agency-1' }),
    expect.any(Object),
  );
});
test('commercial offers select their subtype before moving to the address', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await screen.findByRole('option', { name: 'Коммерческая недвижимость' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'commercial' },
  });
  const subtype = await screen.findByLabelText('Тип коммерческого помещения *');
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  expect(screen.getByRole('group', { name: 'Сделка и объект' })).toBeTruthy();
  fireEvent.change(subtype, { target: { value: 'Склад' } });
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  expect(screen.getByRole('group', { name: 'Расположение' })).toBeTruthy();
  for (const [label, value] of [
    ['Адрес', 'Москва, улица 1'],
    ['Населённый пункт', 'Москва'],
    ['Долгота', '37.6'],
    ['Широта', '55.7'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  const next = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  const back = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  next();
  fireEvent.change(screen.getByLabelText('Площадь *'), {
    target: { value: '40' },
  });
  fireEvent.change(screen.getByLabelText('Этаж'), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText('Этажей'), { target: { value: '5' } });
  back();
  back();
  fireEvent.change(screen.getByLabelText('Тип коммерческого помещения *'), {
    target: { value: 'Коммерческая земля' },
  });
  next();
  next();
  const landArea = screen.getByLabelText('Площадь участка, м² *');
  const landForm = landArea.closest('form');
  if (!landForm) throw new Error('Listing form is missing');
  fireEvent.change(landArea, { target: { value: '' } });
  fireEvent.submit(landForm);
  expect(screen.getByRole('alert').textContent).toBe(
    'Заполните: Площадь участка, м²',
  );
  fireEvent.change(landArea, { target: { value: '0' } });
  next();
  expect(screen.getByRole('alert').textContent).toBe(
    'Укажите значение больше нуля в поле «Площадь участка, м²».',
  );
  fireEvent.change(landArea, { target: { value: '40' } });
  next();
  expect(screen.getByRole('group', { name: 'Цена и условия' })).toBeTruthy();
  expect(screen.queryByLabelText('Описание')).toBeNull();
  fireEvent.change(screen.getByLabelText('Заголовок'), {
    target: { value: 'Коммерческий участок' },
  });
  fireEvent.change(screen.getByLabelText('Цена, ₽'), {
    target: { value: '5000000' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/properties',
    'POST',
    expect.objectContaining({
      attributes: { area: 40, commercial_property_type: 'Коммерческая земля' },
    }),
    expect.any(Object),
  );
});

test('selecting a geocoded address fills its locality and coordinates', async () => {
  setup();
  render(<NewListing onCreated={vi.fn()} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  await screen.findByLabelText('Площадь *');
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'улица 1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Найти адрес' }));
  const suggestion = await screen.findByRole('button', {
    name: 'Москва, улица 1',
  });
  expect(screen.queryByRole('button', { name: 'Тула, улица 1' })).toBeNull();
  fireEvent.click(suggestion);
  expect(
    (screen.getByLabelText('Населённый пункт') as HTMLInputElement).value,
  ).toBe('Москва');
  expect((screen.getByLabelText('Долгота') as HTMLInputElement).value).toBe(
    '37.6',
  );
  expect((screen.getByLabelText('Широта') as HTMLInputElement).value).toBe(
    '55.7',
  );
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'Москва, улица 2' },
  });
  expect((screen.getByLabelText('Долгота') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Широта') as HTMLInputElement).value).toBe('');
});
test('the location step rejects a blank locality before continuing', async () => {
  setup();
  render(<NewListing onCreated={vi.fn()} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  await screen.findByLabelText('Площадь *');
  const next = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  next();
  for (const [label, value] of [
    ['Адрес', 'Москва, улица 1'],
    ['Населённый пункт', '   '],
    ['Долгота', '0'],
    ['Широта', '0'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  next();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Укажите адрес, населённый пункт и корректные координаты объекта.',
  );
  fireEvent.change(screen.getByLabelText('Населённый пункт'), {
    target: { value: 'Москва' },
  });
  next();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(
    screen.getByRole('group', { name: 'Характеристики объекта' }),
  ).toBeTruthy();
});
test('a pending address lookup is ignored after the region changes', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, ...args) =>
    path.startsWith('v1/geo/geocode?') ? pending : respond(path, ...args),
  );
  render(<NewListing onCreated={vi.fn()} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  await screen.findByLabelText('Площадь *');
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'улица 1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Найти адрес' }));
  await screen.findByRole('button', { name: 'Ищем адрес…' });
  fireEvent.change(screen.getByLabelText('Регион'), {
    target: { value: 'moscow_oblast' },
  });
  await act(async () => {
    finish([
      {
        formatted: 'Москва, улица 1',
        locality: 'Москва',
        longitude: 37.6,
        latitude: 55.7,
      },
    ]);
  });
  expect(screen.queryByRole('list', { name: 'Найденные адреса' })).toBeNull();
  expect((screen.getByLabelText('Адрес') as HTMLInputElement).value).toBe(
    'улица 1',
  );
  expect((screen.getByLabelText('Долгота') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('button', { name: 'Найти адрес' })).toBeTruthy();
});
test('long rental offers use rent-specific terms when saving a draft', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill('long_rent');
  expect(screen.queryByLabelText('Возможен торг')).toBeNull();
  fireEvent.change(screen.getByLabelText('Залог, ₽'), {
    target: { value: '10000' },
  });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Коммунальные платежи' }),
    {
      target: { value: 'false' },
    },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/listings',
    'POST',
    expect.objectContaining({
      dealType: 'long_rent',
      terms: { deposit: 10000, utilitiesIncluded: false },
    }),
    expect.any(Object),
  );
});
test('an invalid checkout stays editable and a corrected stay can proceed to photos', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill('short_rent');
  const arrival = screen.getByLabelText('Доступно с');
  const departure = screen.getByLabelText(
    'Доступно до (дата выезда)',
  ) as HTMLInputElement;
  const next = screen.getByRole('button', { name: 'Перейти к фотографиям' });
  fireEvent.change(arrival, { target: { value: '2030-05-02' } });
  for (const day of ['2030-05-01', '2030-05-02']) {
    fireEvent.change(departure, { target: { value: day } });
    expect(departure.checkValidity()).toBe(false);
    fireEvent.click(next);
    expect(api).not.toHaveBeenCalledWith(
      'v1/properties',
      'POST',
      expect.anything(),
      expect.anything(),
    );
    expect(api).not.toHaveBeenCalledWith(
      'v1/listings',
      'POST',
      expect.anything(),
      expect.anything(),
    );
  }
  fireEvent.change(arrival, { target: { value: '2030-05-01' } });
  expect(departure.checkValidity()).toBe(true);
  fireEvent.click(next);
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
});

test('short rental drafts save guest capacity and the minimum stay', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill('short_rent');
  fireEvent.change(screen.getByLabelText('Максимум гостей'), {
    target: { value: '4' },
  });
  fireEvent.change(screen.getByLabelText('Минимум ночей'), {
    target: { value: '2' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/listings',
    'POST',
    expect.objectContaining({
      dealType: 'short_rent',
      terms: { guestCapacity: 4, minimumNights: 2 },
    }),
    expect.any(Object),
  );
});
test('creates a draft with explicit region and zero coordinates', async () => {
  setup();
  const created = vi.fn();
  render(
    <NewListing
      onCreated={created}
      regions={[
        { code: 'moscow', name: 'Москва' },
        { code: 'novosibirsk', name: 'Новосибирская область' },
      ]}
    />,
  );
  await fill('sale', undefined, 'novosibirsk');
  expect(screen.getByText('Регион: Новосибирская область')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
  expect(api).toHaveBeenCalledWith(
    'v1/properties',
    'POST',
    expect.objectContaining({
      address: expect.objectContaining({
        regionCode: 'novosibirsk',
        longitude: 0,
        latitude: 0,
      }),
      attributes: { area: 40 },
    }),
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
});
test('an invalid floor keeps the user on the characteristics step until corrected', async () => {
  setup();
  render(<NewListing onCreated={vi.fn()} />);
  await fill('sale', undefined, undefined, true);
  expect(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  ).toBeTruthy();
});
test.each([undefined, 'agency-1'])(
  'retains created property on retry for agency %s',
  async (agency) => {
    setup(agency ? new ApiError('Forbidden', 403) : true);
    const created = vi.fn();
    render(
      <NewListing
        onCreated={created}
        sellerRole={agency ? 'agent' : 'owner'}
      />,
    );
    await fill('sale', agency);
    fireEvent.click(
      screen.getByRole('button', { name: 'Перейти к фотографиям' }),
    );
    const alert = await screen.findByRole('alert');
    if (agency)
      expect(alert.textContent).toContain('Проверьте доступ к агентству');
    expect(
      (screen.getByLabelText('Заголовок') as HTMLInputElement).closest(
        'fieldset',
      )?.disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Повторить сохранение' }),
    );
    await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
    const calls = vi.mocked(api).mock.calls;
    expect(calls.filter(([path]) => path === 'v1/properties')).toHaveLength(1);
    const listingCalls = calls.filter(([path]) => path === 'v1/listings');
    expect(listingCalls[0]).toEqual(listingCalls[1]);
  },
);
test('the final step identifies an invalid title and price', async () => {
  setup();
  render(<NewListing onCreated={vi.fn()} />);
  await fill();
  const title = screen.getByLabelText('Заголовок');
  const form = title.closest('form');
  if (!form) throw new Error('Listing form is missing');
  fireEvent.change(title, { target: { value: '   ' } });
  fireEvent.submit(form);
  expect(screen.getByRole('alert').textContent).toBe(
    'Введите заголовок длиной не менее трёх символов.',
  );
  fireEvent.change(title, { target: { value: 'Квартира рядом с парком' } });
  fireEvent.change(screen.getByLabelText('Цена, ₽'), {
    target: { value: '0' },
  });
  fireEvent.submit(form);
  expect(screen.getByRole('alert').textContent).toBe(
    'Укажите цену больше нуля.',
  );
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path === 'v1/properties'),
  ).toBe(false);
});
test('the address can be reviewed and corrected without losing the price or title', async () => {
  setup();
  render(<NewListing onCreated={vi.fn()} />);
  await fill();
  expect(screen.getByText('Адрес объекта: Москва, улица 1')).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByText('Цена и условия', { selector: 'legend' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Исправить адрес' }));
  expect(document.activeElement).toBe(
    screen.getByText('Расположение', { selector: 'legend' }),
  );
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'Москва, улица 2' },
  });
  for (let step = 0; step < 2; step++)
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
  expect(screen.getByText('Адрес объекта: Москва, улица 2')).toBeTruthy();
  expect((screen.getByLabelText('Цена, ₽') as HTMLInputElement).value).toBe(
    '5000000',
  );
  expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe(
    'Квартира рядом с парком',
  );
});
test('changing category clears category-specific values', async () => {
  setup();
  render(<NewListing onCreated={() => {}} />);
  await fill();
  for (let step = 0; step < 3; step++)
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'land' },
  });
  await waitFor(() =>
    expect((screen.getByLabelText('Площадь *') as HTMLInputElement).value).toBe(
      '',
    ),
  );
});

test('ignores late definitions from a previous category', async () => {
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === 'v1/account/listing-drafts') return [];
    if (path === 'v1/categories')
      return [
        { code: 'apartment', name: 'Квартира' },
        { code: 'land', name: 'Участок' },
      ];
    if (path === 'v1/categories/apartment/attributes')
      return new Promise((resolve) => {
        release = resolve;
      });
    return [
      {
        code: 'area',
        name: 'Площадь участка',
        kind: 'number',
        required: true,
        options: [],
      },
    ];
  });
  render(<NewListing onCreated={() => {}} />);
  await screen.findByRole('option', { name: 'Квартира' });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'apartment' },
  });
  fireEvent.change(screen.getByLabelText('Категория'), {
    target: { value: 'land' },
  });
  await screen.findByLabelText('Площадь участка *');
  release?.([
    {
      code: 'rooms',
      name: 'Комнаты квартиры',
      kind: 'number',
      required: true,
      options: [],
    },
  ]);
  await waitFor(() =>
    expect(screen.queryByLabelText('Комнаты квартиры *')).toBeNull(),
  );
  expect(screen.getByLabelText('Площадь участка *')).toBeTruthy();
});

test('completed creation cannot resubmit and explicit reset creates a new attempt', async () => {
  setup();
  const created = vi.fn();
  render(<NewListing onCreated={created} />);
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await screen.findByRole('status');
  fireEvent.submit(screen.getByLabelText('Заголовок').closest('form')!);
  expect(created).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Создать ещё объявление' }),
  );
  await fill();
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(created).toHaveBeenCalledTimes(2));
  const properties = vi
    .mocked(api)
    .mock.calls.filter(([path]) => path === 'v1/properties');
  expect(properties).toHaveLength(2);
  expect(properties[0]?.[3]).not.toEqual(properties[1]?.[3]);
});
test('parent disabled state prevents new requests', async () => {
  setup();
  render(<NewListing disabled onCreated={() => {}} />);
  await screen.findByRole('option', { name: 'Квартира' });
  expect(
    (screen.getByLabelText('Категория') as HTMLSelectElement).closest(
      'fieldset',
    )?.disabled,
  ).toBe(true);
});
test('unmount during property creation does not create a listing or notify parent', async () => {
  setup();
  const created = vi.fn();
  const view = render(<NewListing onCreated={created} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  view.unmount();
  await act(async () => {
    release?.({ id: 'property-1' });
  });
  expect(created).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/listings'),
  ).toHaveLength(0);
});

test('parent disabling while property request is pending pauses before listing creation', async () => {
  setup();
  const created = vi.fn();
  const view = render(<NewListing onCreated={created} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/properties'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : { id: 'listing-1' },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  view.rerender(<NewListing disabled onCreated={created} />);
  await act(async () => {
    release?.({ id: 'property-1' });
  });
  expect(created).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === 'v1/listings'),
  ).toHaveLength(0);
  view.rerender(<NewListing onCreated={created} />);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сохранение' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('listing-1'));
});

test('reports busy until the final listing request settles', async () => {
  setup();
  const created = vi.fn();
  const busy = vi.fn();
  render(<NewListing onCreated={created} onBusyChange={busy} />);
  await fill();
  let release: ((value: unknown) => void) | undefined;
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/properties'
      ? { id: 'property-1' }
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к фотографиям' }),
  );
  await waitFor(() => expect(release).toBeDefined());
  expect(busy.mock.calls).toEqual([[true]]);
  await act(async () => {
    release?.({ id: 'listing-1' });
  });
  expect(created).toHaveBeenCalledWith('listing-1');
  expect(busy.mock.calls).toEqual([[true], [false]]);
});
