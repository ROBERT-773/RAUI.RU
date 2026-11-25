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
import OwnerListings from './owner-listings';
import {
  api,
  ApiError,
  ListingContactSelectionChangedError,
} from '../lib/client';
import { getListingContactSettings } from '../lib/contact-settings';
vi.mock('../lib/contact-settings', async (original) => ({
  ...(await original<typeof import('../lib/contact-settings')>()),
  getListingContactSettings: vi.fn(async () => ({
    mode: 'messages',
    phones: [],
    selectedPhoneIds: [],
    canEdit: true,
  })),
}));
vi.mock('../lib/client', async (original) => ({
  ...(await original<typeof import('../lib/client')>()),
  api: vi.fn(),
}));
vi.mock('./new-listing', () => ({ default: () => <p>Создание объекта</p> }));
const listing = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Квартира у парка',
  price: '9000000',
  description: 'Реальная квартира',
  terms: { deposit: 100 },
  status: 'draft',
  version: 3,
  deal_type: 'sale',
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup(
  status = 'draft',
  historyUnavailable = false,
  photoCount = 5,
  role = 'owner',
) {
  const savedListing =
    role === 'agency'
      ? { ...listing, organization_id: 'agency-1', seller_id: 'employee-1' }
      : listing;
  vi.mocked(api).mockImplementation(async (path, method, body) => {
    if (path === 'v1/auth/me')
      return {
        role,
        email_verified_at: 'now',
        phone_verified_at: 'now',
      };
    if (path === 'v1/account/publication-quota')
      return { applies: true, limit: 1, publishedObjects: 0, remaining: 1 };
    if (path === 'v1/listings?limit=20') return [{ ...savedListing, status }];
    if (path.startsWith('v1/listings?limit=20&')) return [];
    if (path.endsWith('/history')) {
      if (historyUnavailable) throw new Error('History unavailable');
      return [
        {
          event: 'moderation.decided',
          after_data: { reason: 'Уточните описание' },
        },
      ];
    }
    if (path.startsWith('v1/media/listing/'))
      return Array.from({ length: photoCount }, (_, index) => ({
        id: `photo-${index}`,
        state: 'ready',
        kind: 'photo',
      }));
    if (method === 'PATCH')
      return { ...savedListing, ...(body as object), version: 4 };
    if (path.endsWith('/transitions'))
      return { ...listing, ...(body as object), version: 4 };
    return { ...savedListing, status };
  });
}
test('published listing opens with a warning when history is unavailable', async () => {
  setup('published', true);
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByRole('button', { name: 'Приостановить' });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'История объявления недоступна',
  );
});

test('the seller explicitly selects contact numbers, removes a number and reviews only the saved selection', async () => {
  setup();
  const phones = [
    { id: 'primary', phone: '+79990000001' },
    { id: 'second', phone: '+79990000002' },
    { id: 'third', phone: '+79990000003' },
  ];
  let ids: string[] = [];
  let mode: 'calls' | 'messages' = 'calls';
  const current = () => ({
    mode,
    phones,
    selectedPhoneIds: ids,
    canEdit: true,
  });
  vi.mocked(getListingContactSettings).mockImplementation(async () =>
    current(),
  );
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path.endsWith('/contact-settings') && method === 'PUT') {
      expect(body).toMatchObject({ expectedPhoneIds: ids });
      ids = (body as { phoneIds: string[] }).phoneIds;
      return current();
    }
    return original(path, method, body, options);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const section = within(
    await screen.findByRole('region', { name: 'Контакты объявления' }),
  );
  const box = (suffix: string) =>
    section.getByRole<HTMLInputElement>('checkbox', {
      name: new RegExp(suffix + '$'),
    });
  expect(box('0001').checked).toBe(false);
  const profileLink = section.getByRole('link', {
    name: 'Настройки связи в профиле',
  });
  expect(profileLink.getAttribute('href')).toBe(
    '/account?section=contacts#contact-settings',
  );
  expect(profileLink.getAttribute('target')).toBe('_blank');
  fireEvent.click(box('0002'));
  await waitFor(() => expect(box('0002').checked).toBe(true));
  fireEvent.click(box('0001'));
  await waitFor(() => expect(box('0003').disabled).toBe(true));
  expect(ids).toEqual(['second', 'primary']);
  fireEvent.click(box('0001'));
  await waitFor(() => expect(box('0003').disabled).toBe(false));
  expect(ids).toEqual(['second']);
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  const preview = within(
    await screen.findByRole('region', {
      name: 'Сохранённые данные объявления',
    }),
  );
  expect(preview.getByText('Телефон 1: +79990000002')).toBeTruthy();
  expect(preview.queryByText(/79990000001/)).toBeNull();
  expect(preview.queryByText('Сообщение на портале')).toBeNull();
  mode = 'messages';
  fireEvent.click(
    screen.getByRole('button', { name: 'Отправить на модерацию' }),
  );
  await screen.findByText(/Откройте предпросмотр ещё раз/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  const changed = within(
    await screen.findByRole('region', {
      name: 'Сохранённые данные объявления',
    }),
  );
  expect(changed.getByText('Сообщение на портале')).toBeTruthy();
  expect(changed.queryByText(/79990000002/)).toBeNull();
});

test('a stale contact selection reloads the other tab’s saved choice and asks the seller to confirm it', async () => {
  setup();
  const initial = {
    mode: 'both' as const,
    phones: [
      { id: 'first', phone: '+79990000001' },
      { id: 'second', phone: '+79990000002' },
    ],
    selectedPhoneIds: ['first'],
    canEdit: true,
  };
  vi.mocked(getListingContactSettings)
    .mockResolvedValueOnce(initial)
    .mockResolvedValue({ ...initial, selectedPhoneIds: ['second'] });
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path.endsWith('/contact-settings') && method === 'PUT')
      throw new ListingContactSelectionChangedError();
    return original(path, method, body, options);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const section = within(
    await screen.findByRole('region', { name: 'Контакты объявления' }),
  );
  fireEvent.click(section.getByRole('checkbox', { name: /0002$/ }));
  await screen.findByText(
    'Контакты изменились в другой вкладке. Проверьте номера и подтвердите выбор ещё раз.',
  );
  expect(
    section.getByRole<HTMLInputElement>('checkbox', { name: /0002$/ }).checked,
  ).toBe(true);
  expect(
    section.getByRole<HTMLInputElement>('checkbox', { name: /0001$/ }).checked,
  ).toBe(false);
  expect(
    vi.mocked(api).mock.calls.filter(([p]) => p.endsWith('/contact-settings')),
  ).toEqual([
    [
      `v1/listings/${listing.id}/contact-settings`,
      'PUT',
      { phoneIds: ['first', 'second'], expectedPhoneIds: ['first'] },
    ],
  ]);
});

test('organization editors cannot change another seller’s contacts', async () => {
  setup('draft', false, 5, 'agency');
  vi.mocked(getListingContactSettings).mockResolvedValue({
    mode: 'calls',
    phones: [],
    selectedPhoneIds: [],
    canEdit: false,
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const contacts = within(
    await screen.findByRole('region', { name: 'Способы связи' }),
  );
  expect(contacts.getByText('Публичный номер пока недоступен.')).toBeTruthy();
  expect(contacts.queryByRole('checkbox')).toBeNull();
});
test.each([
  { role: 'owner', representation: null },
  { role: 'agent', representation: 'От своего имени' },
  { role: 'agency', representation: 'От организации' },
])(
  '$role opens an existing draft and saves editable offer fields with its version',
  async ({ role, representation }) => {
    setup('draft', false, 5, role);
    render(<OwnerListings />);
    const draft = await screen.findByRole('button', {
      name: 'Квартира у парка',
    });
    const row = within(draft.closest('tr')!);
    expect(row.getByRole('cell', { name: 'Черновик' })).toBeTruthy();
    if (representation) expect(row.getByText(representation)).toBeTruthy();
    fireEvent.click(draft);
    const details = await screen.findByRole('article');
    if (representation)
      expect(
        within(details).getByText(representation, { exact: true }),
      ).toBeTruthy();
    else
      expect(
        within(details).queryByText(/От организации|От своего имени/),
      ).toBeNull();
    fireEvent.change(await screen.findByLabelText('Цена, ₽'), {
      target: { value: '9100000' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Сохранить изменения' }),
    );
    await screen.findByText('Изменения сохранены.');
    expect(api).toHaveBeenCalledWith(`v1/listings/${listing.id}`, 'PATCH', {
      version: 3,
      title: listing.title,
      price: 9100000,
      description: listing.description,
    });
  },
);
test('the draft editor identifies invalid title and price before sending a patch', async () => {
  setup();
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const title = await screen.findByLabelText('Название');
  const form = title.closest('form');
  if (!form) throw new Error('Listing editor form is missing');
  fireEvent.change(title, { target: { value: '   ' } });
  fireEvent.submit(form);
  expect(screen.getByRole('alert').textContent).toContain(
    'Введите заголовок длиной не менее трёх символов.',
  );
  fireEvent.change(title, { target: { value: listing.title } });
  fireEvent.change(screen.getByLabelText('Цена, ₽'), {
    target: { value: '0' },
  });
  fireEvent.submit(form);
  expect(screen.getByRole('alert').textContent).toContain(
    'Укажите цену больше нуля.',
  );
  expect(
    vi.mocked(api).mock.calls.some(([, method]) => method === 'PATCH'),
  ).toBe(false);
});
test('a stale draft keeps the edits and can be saved after reopening', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  const pathToDraft = `v1/listings/${listing.id}`;
  let latestVersion = listing.version;
  vi.mocked(api).mockImplementation(async (path, method, ...args) => {
    if (path === pathToDraft && method === 'PATCH' && latestVersion === 3) {
      latestVersion = 4;
      throw new ApiError('Conflict', 409);
    }
    if (path === pathToDraft && !method && latestVersion === 4)
      return { ...listing, version: 4, price: '9200000' };
    return respond(path, method, ...args);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const price = (await screen.findByLabelText('Цена, ₽')) as HTMLInputElement;
  fireEvent.change(price, { target: { value: '9100000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Объявление изменилось.',
  );
  expect(price.value).toBe('9100000');
  fireEvent.click(
    screen.getByRole('button', { name: 'Отменить несохранённые изменения' }),
  );
  fireEvent.click(screen.getByRole('button', { name: listing.title }));
  const freshPrice = (await screen.findByLabelText(
    'Цена, ₽',
  )) as HTMLInputElement;
  expect(freshPrice.value).toBe('9200000');
  fireEvent.change(freshPrice, { target: { value: '9100000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await screen.findByText('Изменения сохранены.');
  expect(api).toHaveBeenCalledWith(
    pathToDraft,
    'PATCH',
    expect.objectContaining({ version: 4, price: 9100000 }),
  );
});
test('published offer must be paused before editing and then uses authoritative fresh data', async () => {
  setup('published');
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByRole('button', { name: 'Приостановить' });
  expect(
    screen.queryByRole('button', { name: 'Сохранить изменения' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Приостановить' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      `v1/listings/${listing.id}/transitions`,
      'POST',
      { version: 3, status: 'paused' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    ),
  );
});
test('seller searches by address, deal and status and can clear the selection', async () => {
  setup();
  render(<OwnerListings />);
  await screen.findByRole('button', { name: listing.title });
  fireEvent.change(
    screen.getByLabelText('Адрес, название или номер объявления'),
    { target: { value: 'Парк' } },
  );
  fireEvent.change(screen.getByLabelText('Фильтр по сделке'), {
    target: { value: 'rent' },
  });
  fireEvent.change(screen.getByLabelText('Фильтр по статусу'), {
    target: { value: 'archived' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Найти объявления' }));
  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.some(([path]) => {
        const params = new URLSearchParams(path.split('?')[1]);
        return (
          params.get('q') === 'Парк' &&
          params.get('deal') === 'rent' &&
          params.get('status') === 'archived'
        );
      }),
    ).toBe(true),
  );
  expect(
    await screen.findByText('По этим фильтрам объявлений нет.'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
  expect(
    await screen.findByRole('button', { name: listing.title }),
  ).toBeTruthy();
});
test('owner sees the saved published card and can cancel editing without pausing publication', async () => {
  setup('published');
  render(<OwnerListings />);
  const table = await screen.findByRole('table', {
    name: 'Сохранённые объявления',
  });
  fireEvent.click(within(table).getByRole('button', { name: listing.title }));
  const preview = await screen.findByRole('region', {
    name: 'Сохранённые данные объявления',
  });
  expect(within(preview).getByText(listing.description)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/transitions')),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Приостановить и редактировать' }),
  );
  expect(
    await screen.findByRole('button', { name: 'Сохранить изменения' }),
  ).toBeTruthy();
});
test('archive changes the saved listing only after confirmation', async () => {
  setup('published');
  const confirm = vi
    .spyOn(window, 'confirm')
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  try {
    render(<OwnerListings />);
    const saved = await screen.findByRole('button', { name: listing.title });
    fireEvent.click(saved);
    const archive = await screen.findByRole('button', { name: 'В архив' });
    const transitionPath = `v1/listings/${listing.id}/transitions`;

    fireEvent.click(archive);
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path === transitionPath),
    ).toBe(false);
    expect(
      screen.getByRole('link', { name: 'Открыть опубликованное объявление' }),
    ).toBeTruthy();

    fireEvent.click(archive);
    await screen.findByText('Объявление перенесено в архив.');
    expect(api).toHaveBeenCalledWith(
      transitionPath,
      'POST',
      { version: 3, status: 'archived' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(
      within(saved.closest('tr')!).getByRole('cell', { name: 'В архиве' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'В архив' })).toBeNull();
  } finally {
    confirm.mockRestore();
  }
});
test.each([false, true])(
  'a failed listing request can be retried, session expires: %s',
  async (sessionExpired) => {
    setup();
    const respond = vi.mocked(api).getMockImplementation()!;
    let listReads = 0;
    vi.mocked(api).mockImplementation(async (path, ...args) => {
      if (path === 'v1/listings?limit=20') {
        if (++listReads === 1) throw new Error('Temporary list failure');
        if (sessionExpired)
          throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
      }
      return respond(path, ...args);
    });
    render(<OwnerListings />);
    expect(
      await screen.findByText('Не удалось загрузить список объявлений.'),
    ).toBeTruthy();
    expect(screen.queryByText('Объявлений пока нет.')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Повторить загрузку объявлений' }),
    );
    if (sessionExpired) {
      expect(
        await screen.findByRole('link', {
          name: 'Войти или зарегистрироваться',
        }),
      ).toBeTruthy();
      expect(screen.queryByText('Создание объекта')).toBeNull();
    } else {
      expect(
        await screen.findByRole('button', { name: listing.title }),
      ).toBeTruthy();
    }
    expect(
      screen.queryByText('Не удалось загрузить список объявлений.'),
    ).toBeNull();
  },
);
test('failed pagination keeps saved listings and retries the same cursor', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    ...listing,
    id: `draft-${index}`,
    title: `Черновик ${index}`,
  }));
  const nextPagePath = 'v1/listings?limit=20&after=draft-19';
  let attempts = 0;
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    if (path === 'v1/listings?limit=20') return firstPage;
    if (path === nextPagePath) {
      if (++attempts === 1) throw new Error('Страница временно недоступна.');
      return [{ ...listing, id: 'draft-next', title: 'Следующий черновик' }];
    }
    return respond(path, ...args);
  });

  render(<OwnerListings />);
  const loadMore = await screen.findByRole('button', {
    name: 'Показать ещё объявления',
  });
  fireEvent.click(loadMore);
  await screen.findByText('Страница временно недоступна.');
  expect(screen.getByRole('button', { name: 'Черновик 19' })).toBeTruthy();
  fireEvent.click(loadMore);
  await screen.findByRole('button', { name: 'Следующий черновик' });
  expect(attempts).toBe(2);
  expect(screen.getByRole('button', { name: 'Черновик 19' })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Показать ещё объявления' }),
  ).toBeNull();
});
test('an expired session on opening a draft returns to sign-in', async () => {
  setup();
  const respond = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, ...args) => {
    if (path === `v1/listings/${listing.id}`)
      throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
    return respond(path, ...args);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  expect(
    await screen.findByRole('link', { name: 'Войти или зарегистрироваться' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: listing.title })).toBeNull();
});
test('failed access exposes no draft controls', async () => {
  vi.mocked(api).mockRejectedValue(
    new ApiError('Войдите в аккаунт, чтобы продолжить.', 401),
  );
  render(<OwnerListings />);
  await screen.findByRole('alert');
  expect(
    screen
      .getByRole('link', { name: 'Войти или зарегистрироваться' })
      .getAttribute('href'),
  ).toBe('/account?action=publish');
  expect(screen.queryByLabelText('Цена, ₽')).toBeNull();
});
test('unverified phone does not expose creation or publication controls', async () => {
  setup();
  vi.mocked(api).mockImplementation(async (path) =>
    path === 'v1/auth/me'
      ? { role: 'owner', email_verified_at: 'now', phone_verified_at: null }
      : [],
  );
  render(<OwnerListings />);
  await screen.findByText(/Подтвердите email и телефон/);
  expect(screen.queryByText('Создание объекта')).toBeNull();
});

test('buyer is sent to the catalog without prompting for seller verification', async () => {
  vi.mocked(api).mockResolvedValue({
    role: 'buyer',
    email_verified_at: null,
    phone_verified_at: null,
  });
  render(<OwnerListings />);
  await screen.findByText('Размещение доступно в кабинете продавца.');
  expect(screen.getByRole('link', { name: 'Перейти в каталог' })).toBeTruthy();
  expect(
    screen.queryByRole('link', { name: 'Профиль и подтверждение контактов' }),
  ).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});

test('verified owner awaiting registration approval gets onboarding link and no listings request', async () => {
  vi.mocked(api).mockResolvedValue({
    role: 'owner',
    email_verified_at: 'now',
    phone_verified_at: 'now',
    registration_approval_state: 'pending',
  });
  render(<OwnerListings />);
  await screen.findByText(/Дождитесь одобрения регистрации/);
  expect(
    screen
      .getByRole('link', { name: 'Профиль и подтверждение контактов' })
      .getAttribute('href'),
  ).toBe('/account');
  expect(screen.queryByText('Создание объекта')).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});

test('an existing apartment draft can save corrected areas without replacing other attributes', async () => {
  setup();
  const fallback = vi.mocked(api).getMockImplementation()!;
  const property = {
    id: 'property',
    version: 2,
    category_code: 'apartment',
    attributes: { area: 45, rooms: 2 },
    address: { formatted: 'Москва, улица 1' },
  };
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === `v1/listings/${listing.id}`)
      return { ...listing, property_id: property.id };
    if (path === 'v1/categories/apartment/attributes')
      return [
        {
          code: 'area',
          name: 'Общая площадь, м²',
          kind: 'number',
          required: true,
          options: [],
        },
        {
          code: 'kitchen_area',
          name: 'Площадь кухни, м²',
          kind: 'number',
          required: true,
          options: [],
        },
        {
          code: 'rooms',
          name: 'Комнаты',
          kind: 'number',
          required: false,
          options: [],
        },
      ];
    if (path === 'v1/properties/property')
      return method === 'PATCH'
        ? {
            ...property,
            version: 3,
            attributes: { area: 46, kitchen_area: 9, rooms: 3 },
          }
        : property;
    return fallback(path, method, body, options);
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByText(
    'Заполните обязательные характеристики: Площадь кухни, м².',
  );
  const submit = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Перейти к предпросмотру',
  });
  expect(submit.disabled).toBe(true);
  const areaInput = await screen.findByLabelText('Общая площадь, м² *');
  fireEvent.change(areaInput, { target: { value: '0' } });
  const characteristicsForm = areaInput.closest('form');
  if (!characteristicsForm) throw new Error('Characteristics form is missing');
  fireEvent.submit(characteristicsForm);
  expect(screen.getByRole('alert').textContent).toContain(
    'Заполните: Площадь кухни, м²',
  );
  fireEvent.change(screen.getByLabelText(/Площадь кухни, м²/), {
    target: { value: '9' },
  });
  fireEvent.submit(characteristicsForm);
  expect(screen.getByRole('alert').textContent).toContain(
    'Укажите значение больше нуля в поле «Общая площадь, м²».',
  );
  fireEvent.change(areaInput, {
    target: { value: '46' },
  });
  fireEvent.change(screen.getByLabelText('Комнаты'), {
    target: { value: '3' },
  });
  expect(screen.queryByLabelText('Адрес')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Сохранить характеристики' }),
  );
  await screen.findByText('Характеристики сохранены.');
  expect(submit.disabled).toBe(false);
  expect(screen.getByText('Адрес объекта: Москва, улица 1')).toBeTruthy();
  expect(
    screen.getByText('Адрес сохранённого объявления изменить нельзя.'),
  ).toBeTruthy();
  expect(api).toHaveBeenCalledWith('v1/properties/property', 'PATCH', {
    version: 2,
    attributes: { area: 46, kitchen_area: 9, rooms: 3 },
  });
  fireEvent.change(screen.getByLabelText('Комнаты'), {
    target: { value: '4' },
  });
  expect(submit.disabled).toBe(true);
  const refresh = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Обновить состояние',
  });
  const listingButton = screen.getByRole<HTMLButtonElement>('button', {
    name: listing.title,
  });
  expect(refresh.disabled).toBe(true);
  expect(listingButton.disabled).toBe(true);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    const accountLink = screen.getByRole('link', {
      name: 'Вернуться в аккаунт',
    });
    expect(fireEvent.click(accountLink)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      'В объявлении есть несохранённые правки. Выйти без сохранения?',
    );
  } finally {
    confirm.mockRestore();
  }
  expect(
    window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole('button', { name: 'Отменить правки характеристик' }),
  );
  expect(submit.disabled).toBe(false);
  expect(refresh.disabled).toBe(false);
  expect(listingButton.disabled).toBe(false);
  expect(
    window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
  ).toBe(true);
});

test('published offer links to the actual public route', async () => {
  setup('published');
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  expect(
    (
      await screen.findByRole('link', {
        name: 'Открыть опубликованное объявление',
      })
    ).getAttribute('href'),
  ).toBe(`/listings/${listing.id}`);
});
test('unsaved offer changes cannot be overwritten by media refresh or navigation', async () => {
  setup();
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.change(await screen.findByLabelText('Цена, ₽'), {
    target: { value: '9990000' },
  });
  expect(
    (
      screen.getByRole('button', {
        name: 'Обновить состояние',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText('Добавить фотографию') as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: listing.title }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Отменить несохранённые изменения' }),
  );
  expect((screen.getByLabelText('Цена, ₽') as HTMLInputElement).value).toBe(
    '9000000',
  );
});
test.each([
  { status: 'processing', label: 'Вернуть в черновик', lostResponse: false },
  { status: 'moderation', label: 'Отозвать с модерации', lostResponse: false },
  { status: 'moderation', label: 'Отозвать с модерации', lostResponse: true },
])(
  'a $status listing returns to editing, lost response: $lostResponse',
  async ({ status, label, lostResponse }) => {
    setup(status);
    if (lostResponse) {
      const respond = vi.mocked(api).getMockImplementation()!;
      let withdrawn = false;
      vi.mocked(api).mockImplementation(async (path, method, ...args) => {
        if (path.endsWith('/transitions')) {
          withdrawn = true;
          throw new Error('Connection lost');
        }
        if (withdrawn && path === `v1/listings/${listing.id}`)
          return { ...listing, status: 'draft', version: 4 };
        return respond(path, method, ...args);
      });
    }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<OwnerListings />);
      fireEvent.click(
        await screen.findByRole('button', { name: listing.title }),
      );
      fireEvent.click(await screen.findByRole('button', { name: label }));
      if (lostResponse) {
        await screen.findByText('Connection lost');
        fireEvent.click(screen.getByRole('button', { name: label }));
        await screen.findByText('Объявление уже в черновиках.');
      } else {
        await screen.findByText('Объявление возвращено в черновик.');
      }
      expect(api).toHaveBeenCalledWith(
        `v1/listings/${listing.id}/transitions`,
        'POST',
        { version: 3, status: 'draft' },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
      expect(screen.getByLabelText('Описание')).toBeTruthy();
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(([path]) => path.endsWith('/transitions')),
      ).toHaveLength(1);
      expect(confirm).toHaveBeenCalledTimes(status === 'moderation' ? 1 : 0);
    } finally {
      confirm.mockRestore();
    }
  },
);

test.each(['photos', 'description', 'price', 'characteristics'])(
  'submission rechecks updated %s before advancing the draft',
  async (changed) => {
    setup();
    const respond = vi.mocked(api).getMockImplementation()!;
    let mediaReads = 0;
    let listingReads = 0;
    let propertyReads = 0;
    vi.mocked(api).mockImplementation(async (path, ...args) => {
      if (changed === 'characteristics') {
        if (path === `v1/listings/${listing.id}`)
          return { ...listing, property_id: 'property' };
        if (path === 'v1/properties/property')
          return {
            id: 'property',
            version: ++propertyReads,
            category_code: 'apartment',
            attributes: propertyReads === 1 ? { area: 45 } : {},
          };
        if (path === 'v1/categories/apartment/attributes')
          return [
            {
              code: 'area',
              name: 'Общая площадь',
              kind: 'number',
              required: true,
              options: [],
            },
          ];
      }
      const result = await respond(path, ...args);
      if (
        changed === 'photos' &&
        path.startsWith('v1/media/listing/') &&
        ++mediaReads > 1 &&
        Array.isArray(result)
      )
        return result.slice(0, 4);
      if (
        (changed === 'description' || changed === 'price') &&
        path === `v1/listings/${listing.id}` &&
        ++listingReads > 1
      )
        return changed === 'description'
          ? { ...listing, description: 'Кратко', version: 4 }
          : { ...listing, price: null, version: 4 };
      return result;
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    if (changed === 'characteristics')
      await screen.findByLabelText('Общая площадь *');
    const submit = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Перейти к предпросмотру',
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain(
      changed === 'photos'
        ? 'Список фотографий изменился.'
        : changed === 'description'
          ? 'Описание изменилось.'
          : changed === 'price'
            ? 'Укажите цену больше нуля.'
            : 'Проверьте обязательные характеристики объекта',
    );
    expect(submit.disabled).toBe(true);
    if (changed === 'photos')
      expect(screen.getByText('Загружено фотографий: 4 из 21.')).toBeTruthy();
    if (changed === 'description')
      expect(screen.getByLabelText<HTMLTextAreaElement>('Описание').value).toBe(
        'Кратко',
      );
    if (changed === 'characteristics')
      expect(
        screen.getByText(
          /Заполните обязательные характеристики: Общая площадь/,
        ),
      ).toBeTruthy();
    if (changed === 'price')
      expect(screen.getByLabelText<HTMLInputElement>('Цена, ₽').value).toBe('');
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/transitions')),
    ).toBe(false);
  },
);

test('saving from preview returns to the list and keeps the draft private without a transition', async () => {
  setup();
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Сохранить в черновики' }),
  );
  await screen.findByText(/Черновик сохранён. Продолжить заполнение/);
  expect(
    screen.queryByRole('heading', { name: 'Предпросмотр объявления' }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'Сохранённые объявления' }),
  );
  expect(
    vi.mocked(api).mock.calls.some(([url]) => url.endsWith('/transitions')),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: listing.title }));
  expect(await screen.findByRole('textbox', { name: 'Описание' })).toBeTruthy();
});

test('save and exit writes unfinished edits even when there are no photos', async () => {
  setup('draft', false, 0);
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  const description = await screen.findByRole('textbox', { name: 'Описание' });
  fireEvent.change(description, { target: { value: 'Начало' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить и выйти' }));
  await screen.findByText(/Черновик сохранён. Продолжить заполнение/);
  expect(api).toHaveBeenCalledWith(
    'v1/listings/' + listing.id,
    'PATCH',
    expect.objectContaining({ description: 'Начало' }),
  );
  expect(
    vi.mocked(api).mock.calls.some(([url]) => url.endsWith('/transitions')),
  ).toBe(false);
});

test.each([null, 'processing', 'moderation'])(
  'submission advances with fresh versions, including a lost response: %s',
  async (lostResponse) => {
    setup();
    let status = 'draft',
      version = 3;
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, method, body, options) => {
      if (path === `v1/listings/${listing.id}`)
        return { ...listing, status, version };
      if (path.endsWith('/transitions')) {
        const input = body as { status: string; version: number };
        expect(input.version).toBe(version);
        status = input.status;
        version++;
        if (status === lostResponse) throw new Error('Connection lost');
        return { ...listing, status, version };
      }
      return base(path, method, body, options);
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Перейти к предпросмотру' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Отправить на модерацию' }),
    );
    if (lostResponse) {
      await screen.findByText('Connection lost');
      fireEvent.click(
        screen.getByRole('button', { name: 'Отправить на модерацию' }),
      );
    }
    await screen.findByText(/Объявление отправлено на модерацию/);
    const requests = vi
      .mocked(api)
      .mock.calls.filter((call) => call[0].endsWith('/transitions'));
    expect(requests.map((call) => call[2])).toEqual([
      { version: 3, status: 'processing' },
      { version: 4, status: 'moderation' },
    ]);
    expect(requests[0]?.[3]?.idempotencyKey).not.toBe(
      requests[1]?.[3]?.idempotencyKey,
    );
    expect(
      screen.queryByRole('button', { name: 'Отправить на модерацию' }),
    ).toBeNull();
  },
);
test.each(['listing', 'photos', 'property'])(
  'changed %s after preview requires a second review before submission',
  async (changed) => {
    setup();
    let changedAfterPreview = false;
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, ...args) => {
      if (path === 'v1/listings/' + listing.id)
        return {
          ...listing,
          property_id: 'p',
          ...(changedAfterPreview && changed === 'listing'
            ? { price: '9100000', version: 4 }
            : {}),
        };
      if (path === 'v1/properties/p')
        return {
          id: 'p',
          version: changedAfterPreview && changed === 'property' ? 2 : 1,
          category_code: 'apartment',
          attributes: {},
        };
      if (path === 'v1/categories/apartment/attributes') return [];
      const result = await base(path, ...args);
      if (
        changedAfterPreview &&
        changed === 'photos' &&
        path.startsWith('v1/media/listing/') &&
        Array.isArray(result)
      )
        return [...result].reverse();
      return result;
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Перейти к предпросмотру' }),
    );
    const submit = await screen.findByRole('button', {
      name: 'Отправить на модерацию',
    });
    changedAfterPreview = true;
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Объявление изменилось',
    );
    expect(
      screen.queryByRole('button', { name: 'Отправить на модерацию' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Перейти к предпросмотру' }),
    ).toBeTruthy();
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/transitions')),
    ).toBe(false);
  },
);

test('a replay which returns an archived listing is not sent to moderation', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) =>
    path.endsWith('/transitions')
      ? { ...listing, status: 'archived', version: 6 }
      : base(path, method, body, options),
  );
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Отправить на модерацию' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Статус объявления изменился',
  );
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/transitions')),
  ).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: 'Отправить на модерацию' }),
  ).toBeNull();
});

test.each([4, 5, 21, 22])(
  'enforces publication photo limits for %i ready photos',
  async (count) => {
    setup('draft', false, count);
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    const submit = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Перейти к предпросмотру',
    });
    expect(submit.disabled).toBe(count < 5 || count > 21);
    expect(
      screen.getByLabelText<HTMLInputElement>('Добавить фотографию').disabled,
    ).toBe(count >= 21);
    const floorPlan = screen.getByLabelText<HTMLInputElement>(
      'Добавить планировку',
    );
    expect(floorPlan.disabled).toBe(false);
    if (count === 21) {
      fireEvent.change(floorPlan, {
        target: {
          files: [new File(['plan'], 'plan.png', { type: 'image/png' })],
        },
      });
      await screen.findByText('Планировка загружена и ожидает обработки.');
      expect(api).toHaveBeenCalledWith(
        'v1/media',
        'POST',
        expect.objectContaining({ kind: 'floor_plan', filename: 'plan.png' }),
        expect.any(Object),
      );
    }
  },
);

test('a batch that exceeds the photo limit leaves the final slot available', async () => {
  setup('draft', false, 20);
  const respond = vi.mocked(api).getMockImplementation()!;
  let uploaded = false;
  vi.mocked(api).mockImplementation(async (path, method, ...args) => {
    if (path === 'v1/media' && method === 'POST') {
      uploaded = true;
      return { id: 'last-photo' };
    }
    const result = await respond(path, method, ...args);
    if (
      path.startsWith('v1/media/listing/') &&
      uploaded &&
      Array.isArray(result)
    )
      return [...result, { id: 'last-photo', kind: 'photo', state: 'ready' }];
    return result;
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByText('Загружено фотографий: 20 из 21.');
  const input = screen.getByLabelText<HTMLInputElement>('Добавить фотографию');
  const first = new File(['photo'], 'first.png', { type: 'image/png' });
  const second = new File(['photo'], 'second.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [first, second] } });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Можно добавить ещё 1 фото.',
  );
  expect(uploaded).toBe(false);
  fireEvent.change(input, { target: { files: [first] } });
  await screen.findByText('Загружено фотографий: 21 из 21.');
  expect(input.disabled).toBe(true);
  expect(
    screen.getByLabelText<HTMLInputElement>('Добавить планировку').disabled,
  ).toBe(false);
});

test('the final step shows the saved offer and returns to its editor without submitting', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === `v1/listings/${listing.id}`)
      return {
        ...listing,
        price: '9000000.00',
        deal_type: 'long_rent',
        terms: { deposit: 0, commission: 10, utilitiesIncluded: false },
      };
    const result = await base(path, method, body, options);
    if (path.startsWith('v1/media/listing/') && Array.isArray(result))
      return [{ id: 'plan', state: 'ready', kind: 'floor_plan' }, ...result];
    return result;
  });
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  expect(
    screen.queryByRole('button', { name: 'Отправить на модерацию' }),
  ).toBeNull();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Перейти к предпросмотру' }),
  );
  await screen.findByRole('button', { name: 'Отправить на модерацию' });
  const preview = within(
    screen.getByRole('region', { name: 'Сохранённые данные объявления' }),
  );
  expect(preview.getByText(listing.description)).toBeTruthy();
  expect(preview.getByText('9 000 000 ₽ / мес.')).toBeTruthy();
  expect(preview.getByText('Долгосрочная аренда')).toBeTruthy();
  expect(preview.getByText('0 ₽')).toBeTruthy();
  expect(preview.getByText('10 %')).toBeTruthy();
  expect(preview.getByText('Нет')).toBeTruthy();
  expect(
    preview.getAllByRole('img', { name: 'Фото в предпросмотре' }),
  ).toHaveLength(5);
  expect(preview.getAllByRole('img').at(-1)?.getAttribute('alt')).toBe(
    'Планировка в предпросмотре',
  );
  expect(screen.queryByRole('textbox', { name: 'Описание' })).toBeNull();
  expect(document.activeElement?.textContent).toBe('Предпросмотр объявления');
  fireEvent.click(
    screen.getByRole('button', { name: 'Вернуться к редактированию' }),
  );
  expect(
    screen.queryByRole('button', { name: 'Отправить на модерацию' }),
  ).toBeNull();
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Описание' })
      .value,
  ).toBe(listing.description);
  expect(document.activeElement?.textContent).toBe(listing.title);
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/transitions')),
  ).toBe(false);
});

test('submission requires a saved description of at least fifteen characters', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) =>
    path === `v1/listings/${listing.id}` && method !== 'PATCH'
      ? { ...listing, description: '   ' }
      : base(path, method, body, options),
  );
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  await screen.findByText(/сохраните описание длиной не менее 15 символов/);
  const submit = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Перейти к предпросмотру',
  });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: ' 12345678901234 ' },
  });
  expect(screen.getByText(/Символов в описании: 14/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await screen.findByText('Изменения сохранены.');
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: ' 123456789012345 ' },
  });
  expect(screen.getByText(/Символов в описании: 15/)).toBeTruthy();
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await waitFor(() => expect(submit.disabled).toBe(false));
});

test('a failed refresh after upload blocks the stale count until polling recovers', async () => {
  setup('draft', false, 20);
  const respond = vi.mocked(api).getMockImplementation()!;
  let postUploadReads = 0;
  let uploaded = false;
  vi.mocked(api).mockImplementation(async (path, method, ...args) => {
    if (path === 'v1/media' && method === 'POST') {
      uploaded = true;
      return { id: 'last-photo' };
    }
    if (path === `v1/listings/${listing.id}` && method !== 'PATCH' && uploaded)
      return { ...listing, version: 4 };
    const result = await respond(path, method, ...args);
    if (
      path.startsWith('v1/media/listing/') &&
      uploaded &&
      Array.isArray(result)
    ) {
      if (++postUploadReads === 1) throw new Error('Temporary read failure');
      return [...result, { id: 'last-photo', kind: 'photo', state: 'ready' }];
    }
    return result;
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    await screen.findByText('Загружено фотографий: 20 из 21.');
    const upload = screen.getByLabelText<HTMLInputElement>(
      'Добавить фотографию',
    );
    const submit = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Перейти к предпросмотру',
    });
    fireEvent.change(upload, {
      target: {
        files: [new File(['photo'], 'last.png', { type: 'image/png' })],
      },
    });
    await screen.findByText(
      'Список файлов не обновился. Проверяем его повторно.',
    );
    expect(upload.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    const price = screen.getByLabelText<HTMLInputElement>('Цена, ₽');
    expect(price.matches(':disabled')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await screen.findByText('Загружено фотографий: 21 из 21.');
    expect(upload.disabled).toBe(true);
    expect(submit.disabled).toBe(false);
    fireEvent.change(price, { target: { value: '9100000' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Сохранить изменения' }),
    );
    await screen.findByText('Изменения сохранены.');
    expect(api).toHaveBeenCalledWith(
      `v1/listings/${listing.id}`,
      'PATCH',
      expect.objectContaining({ version: 4, price: 9100000 }),
    );
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test.each(['photos', 'quota'])(
  'photo polling stops when %s detects an expired session',
  async (source) => {
    setup();
    const respond = vi.mocked(api).getMockImplementation()!;
    let reads = 0;
    let quotaReads = 0;
    vi.mocked(api).mockImplementation(async (path, ...args) => {
      if (
        source === 'quota' &&
        path === 'v1/account/publication-quota' &&
        ++quotaReads > 1
      )
        throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
      if (path.startsWith('v1/media/listing/')) {
        if (++reads === 1)
          return [{ id: 'waiting', state: 'queued', kind: 'photo' }];
        throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
      }
      return respond(path, ...args);
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      render(<OwnerListings />);
      fireEvent.click(
        await screen.findByRole('button', { name: listing.title }),
      );
      await screen.findByText('Фотография обрабатывается');
      if (source === 'quota') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Обновить лимит публикации' }),
        );
      } else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(
        await screen.findByRole('link', {
          name: 'Войти или зарегистрироваться',
        }),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(reads).toBe(source === 'quota' ? 1 : 2);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  },
);

test('processed photos unlock submission without a manual refresh', async () => {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  const imageStates = ['queued', 'processing'];
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path.startsWith('v1/media/listing/')) {
      const state = imageStates.shift();
      if (state) return [{ id: 'waiting', state, kind: 'photo' }];
    }
    return base(path, method, body, options);
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    await screen.findByText('Фотография обрабатывается');
    const submit = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Перейти к предпросмотру',
    });
    expect(submit.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(submit.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText('Фотография обрабатывается')).toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  'failed photo removal recovers when refresh fails: %s',
  async (failRefresh) => {
    setup();
    const base = vi.mocked(api).getMockImplementation()!;
    let removed = false;
    let refreshFailed = false;
    vi.mocked(api).mockImplementation(async (path, method, body, options) => {
      if (path === 'v1/media/bad' && method === 'DELETE') {
        removed = true;
        return { ok: true };
      }
      if (path.startsWith('v1/media/listing/')) {
        if (!removed) return [{ id: 'bad', state: 'failed', kind: 'photo' }];
        if (failRefresh && !refreshFailed) {
          refreshFailed = true;
          throw new Error('Temporary read failure');
        }
      }
      return base(path, method, body, options);
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    await screen.findByText('Ошибка обработки фотографии');
    expect(
      (
        screen.getByRole('button', {
          name: 'Перейти к предпросмотру',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      fireEvent.click(
        screen.getByRole('button', { name: 'Удалить фото с ошибкой' }),
      );
      if (failRefresh) {
        await screen.findByText(
          'Список файлов не обновился. Проверяем его повторно.',
        );
        const upload = screen.getByLabelText<HTMLInputElement>(
          'Добавить фотографию',
        );
        expect(upload.disabled).toBe(true);
        fireEvent.click(
          screen.getByRole('button', { name: 'Обновить состояние' }),
        );
        await screen.findByText('Состояние обновлено.');
        expect(upload.disabled).toBe(false);
      } else {
        await screen.findByText('Фотография удалена. Можно загрузить замену.');
      }
      expect(api).toHaveBeenCalledWith('v1/media/bad', 'DELETE');
      expect(screen.queryByText('Ошибка обработки фотографии')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  },
);

test.each(['retry', 'cancel', 'cancel after refresh failure'])(
  'a failed photo batch supports %s',
  async (action) => {
    setup();
    const base = vi.mocked(api).getMockImplementation()!;
    let failed = false;
    let failNextMediaRead = false;
    vi.mocked(api).mockImplementation(async (path, method, body, options) => {
      if (path.startsWith('v1/media/listing/') && failNextMediaRead) {
        failNextMediaRead = false;
        throw new Error('Temporary read failure');
      }
      if (path === 'v1/media' && method === 'POST') {
        if (
          !failed &&
          (body as { filename: string }).filename === 'second.png'
        ) {
          failed = true;
          throw new Error('Connection lost');
        }
        return { id: 'photo', state: 'pending' };
      }
      return base(path, method, body, options);
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    fireEvent.drop(
      await screen.findByRole('group', { name: 'Загрузка фотографий' }),
      {
        dataTransfer: {
          files: [
            new File(['synthetic-image'], 'object.png', { type: 'image/png' }),
            new File(['second'], 'second.png', { type: 'image/png' }),
            new File(['third'], 'third.png', { type: 'image/png' }),
          ],
        },
      },
    );
    await screen.findByText('Connection lost');
    expect(screen.getByText(/Принято файлов 1 из 3.*second\.png/)).toBeTruthy();
    if (action !== 'retry') {
      failNextMediaRead = action === 'cancel after refresh failure';
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Отменить загрузку оставшихся файлов',
        }),
      );
      await screen.findByText('Оставшаяся загрузка отменена.');
      if (action === 'cancel after refresh failure') {
        await screen.findByText(
          'Список файлов не обновился. Проверяем его повторно.',
        );
        expect(
          screen.getByLabelText<HTMLInputElement>('Добавить фотографию')
            .disabled,
        ).toBe(true);
        fireEvent.click(
          screen.getByRole('button', { name: 'Обновить состояние' }),
        );
      }
      await waitFor(() =>
        expect(
          screen.getByLabelText<HTMLInputElement>('Добавить фотографию')
            .disabled,
        ).toBe(false),
      );
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(([path]) => path === 'v1/media')
          .map((call) => (call[2] as { filename: string }).filename),
      ).toEqual(['object.png', 'second.png']);
      expect(
        screen.queryByRole('button', { name: 'Повторить загрузку фотографии' }),
      ).toBeNull();
      return;
    }
    fireEvent.click(
      screen.getByRole('button', { name: 'Повторить загрузку фотографии' }),
    );
    await screen.findByText('Фотографии загружены и ожидают обработки.');
    const calls = vi
      .mocked(api)
      .mock.calls.filter((call) => call[0] === 'v1/media');
    expect(
      calls.map((call) => (call[2] as { filename: string }).filename),
    ).toEqual(['object.png', 'second.png', 'second.png', 'third.png']);
    expect(calls[1]?.[2]).toEqual(calls[2]?.[2]);
    expect(calls[1]?.[3]).toEqual(calls[2]?.[3]);
    expect(
      screen.queryByRole('button', { name: 'Повторить загрузку фотографии' }),
    ).toBeNull();
  },
);

test.each([
  new File(['bytes'], 'x'.repeat(201) + '.png', { type: 'image/png' }),
  new File(['bytes'], 'wrong.png', { type: 'image/jpeg' }),
])(
  'invalid image name or MIME leaves the file chooser usable',
  async (file) => {
    setup();
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    fireEvent.change(await screen.findByLabelText('Добавить фотографию'), {
      target: { files: [file] },
    });
    await screen.findByRole('alert');
    expect(
      vi.mocked(api).mock.calls.filter((call) => call[0] === 'v1/media'),
    ).toHaveLength(0);
    expect(
      (screen.getByLabelText('Добавить фотографию') as HTMLInputElement)
        .disabled,
    ).toBe(false);
  },
);

function quotaSetup(count = 0, role = 'owner', used = 0) {
  setup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === 'v1/auth/me')
      return {
        role,
        email_verified_at: 'now',
        phone_verified_at: 'now',
        registration_approval_state: 'approved',
      };
    if (path === 'v1/account/publication-quota')
      return {
        applies: role === 'owner',
        limit: role === 'owner' ? 1 : null,
        publishedObjects: role === 'owner' ? count : null,
        remaining: role === 'owner' ? Math.max(0, 1 - count) : null,
        monthly:
          role === 'owner'
            ? {
                limit: 3,
                used,
                remaining: Math.max(0, 3 - used),
                resetsAt: '2029-12-31T21:00:00.000Z',
              }
            : null,
      };
    return base(path, method, body, options);
  });
}
test.each([
  [0, 1],
  [1, 0],
  [7, 0],
])(
  'quota shows authoritative %i objects and %i remaining while draft creation stays available',
  async (count, remaining) => {
    quotaSetup(count);
    render(<OwnerListings />);
    await screen.findByText(
      `Активных объявлений: ${count} из 1. Свободных мест: ${remaining}.`,
    );
    expect(screen.getByText('Создание объекта')).toBeTruthy();
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([path]) => path === 'v1/account/publication-quota'),
    ).toHaveLength(1);
  },
);
test.each([0, 2, 3, 4])(
  'shows %i monthly publications and the Moscow reset independently of active slots',
  async (used) => {
    quotaSetup(0, 'owner', used);
    render(<OwnerListings />);
    const panel = await screen.findByRole('region', {
      name: 'Лимит публикации объектов',
    });
    await within(panel).findByText(
      `Публикаций за месяц: ${used} из 3. Осталось: ${Math.max(0, 3 - used)}.`,
    );
    expect(
      within(panel).getByText('1 января 2030 г.').getAttribute('datetime'),
    ).toBe('2029-12-31T21:00:00.000Z');
    expect(
      within(panel).queryByText(/Для следующей публикации дождитесь/) !== null,
    ).toBe(used >= 3);
  },
);
test('non-owner has no owner quota panel or request', async () => {
  quotaSetup(0, 'agent');
  render(<OwnerListings />);
  await screen.findByText('Создание объекта');
  expect(
    screen.queryByRole('region', { name: 'Лимит публикации объектов' }),
  ).toBeNull();
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([path]) => path === 'v1/account/publication-quota'),
  ).toBe(false);
});
test('quota failure offers manual refresh without inventing zero capacity', async () => {
  quotaSetup();
  const base = vi.mocked(api).getMockImplementation()!;
  let fail = true;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === 'v1/account/publication-quota' && fail)
      throw new Error('Unavailable');
    return base(path, method, body, options);
  });
  render(<OwnerListings />);
  await screen.findByText(
    'Не удалось загрузить лимит публикации. Обновите данные.',
  );
  expect(screen.queryByText(/Активных объявлений:/)).toBeNull();
  expect(screen.getByText('Создание объекта')).toBeTruthy();
  fail = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Обновить лимит публикации' }),
  );
  await screen.findByText('Активных объявлений: 0 из 1. Свободных мест: 1.');
});
test('late quota response after unmount never appears in another account', async () => {
  quotaSetup();
  const base = vi.mocked(api).getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path, method, body, options) =>
    path === 'v1/account/publication-quota'
      ? new Promise((done) => {
          resolve = done;
        })
      : base(path, method, body, options),
  );
  const previous = render(<OwnerListings />);
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  previous.unmount();
  quotaSetup(0, 'agent');
  render(<OwnerListings />);
  await screen.findByText('Создание объекта');
  resolve({ applies: true, limit: 1, publishedObjects: 7, remaining: 0 });
  await waitFor(() =>
    expect(screen.queryByText(/Активных объявлений:/)).toBeNull(),
  );
});
test('full quota keeps draft editing, media and moderation submission enabled', async () => {
  quotaSetup(1);
  render(<OwnerListings />);
  await screen.findByText('Активных объявлений: 1 из 1. Свободных мест: 0.');
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  expect(
    (
      (await screen.findByRole('button', {
        name: 'Перейти к предпросмотру',
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole('button', {
        name: 'Сохранить изменения',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (screen.getByLabelText('Добавить фотографию') as HTMLInputElement).disabled,
  ).toBe(false);
});

test.each([false, true])(
  'pausing refreshes authoritative quota, lost response: %s',
  async (lostResponse) => {
    quotaSetup(1);
    const base = vi.mocked(api).getMockImplementation()!;
    let pauseAttempted = false;
    vi.mocked(api).mockImplementation(async (path, method, body, options) => {
      if (path === 'v1/listings?limit=20')
        return [{ ...listing, status: 'published' }];
      if (path === `v1/listings/${listing.id}`)
        return { ...listing, status: 'published' };
      if (lostResponse && path.endsWith('/transitions') && !pauseAttempted) {
        pauseAttempted = true;
        throw new Error('Connection lost');
      }
      return base(path, method, body, options);
    });
    render(<OwnerListings />);
    await screen.findByText('Активных объявлений: 1 из 1. Свободных мест: 0.');
    fireEvent.click(screen.getByRole('button', { name: listing.title }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Приостановить' }),
    );
    if (lostResponse) {
      await screen.findByText('Connection lost');
      fireEvent.click(screen.getByRole('button', { name: 'Приостановить' }));
    }
    await screen.findByText('Размещение приостановлено.');
    const requests = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.endsWith('/transitions'));
    if (lostResponse) {
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    } else {
      expect(requests).toHaveLength(1);
    }
    const monthlyHelp = screen.getByText(
      /Приостановка не уменьшает число публикаций за месяц/,
    );
    expect(monthlyHelp.textContent).toMatch(
      /Повторная\s+публикация тоже учитывается в лимите/,
    );
    expect(monthlyHelp.textContent).toMatch(
      /Календарный месяц\s+считается по московскому времени/,
    );
    expect(
      screen.getByText('Активных объявлений: 1 из 1. Свободных мест: 0.'),
    ).toBeTruthy();
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([path]) => path === 'v1/account/publication-quota'),
    ).toHaveLength(2);
  },
);
test.each([false, true])(
  'refresh shows the new rejection reason, history initially fails: %s',
  async (failHistory) => {
    setup('moderation');
    const respond = vi.mocked(api).getMockImplementation()!;
    let listingReads = 0;
    let rejectionReads = 0;
    vi.mocked(api).mockImplementation(async (path, ...args) => {
      if (path === `v1/listings/${listing.id}` && ++listingReads > 1)
        return { ...listing, status: 'rejected', version: 4 };
      if (path.endsWith('/history') && listingReads > 1) {
        if (++rejectionReads === 1 && failHistory)
          throw new Error('History unavailable');
        return [
          {
            event: 'moderation.decided',
            after_data: { reason: 'Уточните планировку' },
          },
        ];
      }
      return respond(path, ...args);
    });
    render(<OwnerListings />);
    fireEvent.click(await screen.findByRole('button', { name: listing.title }));
    await screen.findByText('Статус: На модерации');
    fireEvent.click(screen.getByRole('button', { name: 'Обновить состояние' }));
    if (failHistory) {
      await screen.findByText(
        /Статус обновлён. Причину отклонения загрузить не удалось./,
      );
      expect(screen.getByText('Статус: Отклонено')).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'Обновить состояние' }),
      );
    }
    expect(
      await screen.findByText('Причина отклонения: Уточните планировку'),
    ).toBeTruthy();
    expect(screen.getByText('Статус: Отклонено')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Сохранить изменения' }),
    ).toBeTruthy();
  },
);
test('explicit listing-state refresh also reloads quota', async () => {
  quotaSetup();
  render(<OwnerListings />);
  fireEvent.click(await screen.findByRole('button', { name: listing.title }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Обновить состояние' }),
  );
  await screen.findByText('Состояние обновлено.');
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === 'v1/account/publication-quota'),
  ).toHaveLength(2);
});

test.each([403, 503])(
  'quota status %i is recoverable and preserves draft access',
  async (status) => {
    quotaSetup();
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, method, body, options) => {
      if (path === 'v1/account/publication-quota')
        throw new ApiError('Unavailable', status);
      return base(path, method, body, options);
    });
    render(<OwnerListings />);
    await screen.findByText(
      'Не удалось загрузить лимит публикации. Обновите данные.',
    );
    expect(screen.getByText('Создание объекта')).toBeTruthy();
    expect(screen.queryByText(/Активных объявлений:/)).toBeNull();
  },
);
test('expired quota session hides seller controls and asks for login', async () => {
  quotaSetup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) => {
    if (path === 'v1/account/publication-quota')
      throw new ApiError('Войдите в аккаунт, чтобы продолжить.', 401);
    return base(path, method, body, options);
  });
  render(<OwnerListings />);
  await screen.findByText('Войдите в аккаунт, чтобы продолжить.');
  expect(screen.queryByText('Создание объекта')).toBeNull();
  expect(screen.queryByText(/Активных объявлений:/)).toBeNull();
});

test('fresh non-applicable quota hides owner panel after a role change', async () => {
  quotaSetup();
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, method, body, options) =>
    path === 'v1/account/publication-quota'
      ? { applies: false, limit: null, publishedObjects: null, remaining: null }
      : base(path, method, body, options),
  );
  render(<OwnerListings />);
  await screen.findByText('Создание объекта');
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Лимит публикации объектов' }),
    ).toBeNull(),
  );
  expect(screen.queryByText(/Активных объявлений:/)).toBeNull();
});
