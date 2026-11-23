import {
  test,
  expect,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const password = 'E2E-only-password-42!';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
function endpoint(response: Response, method: string, path: string) {
  return (
    response.request().method() === method &&
    new URL(response.url()).pathname === path
  );
}
async function login(
  page: Page,
  email: string,
  heading = 'Кабинет собственника',
) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: heading, exact: true }),
  ).toBeVisible();
}
async function submitDraft(page: Page, draft: Locator, listingId: string) {
  for (let number = 1; number <= 5; number++) {
    const uploaded = page.waitForResponse((value) =>
      endpoint(value, 'POST', '/api/v1/media'),
    );
    await draft
      .getByLabel('Добавить фотографию', { exact: true })
      .setInputFiles({
        name: `apartment-${number}.png`,
        mimeType: 'image/png',
        buffer: png,
      });
    expect((await uploaded).status()).toBe(201);
    await expect(
      draft.getByText(`Загружено фотографий: ${number} из 21.`),
    ).toBeVisible();
  }
  await expect
    .poll(
      async () => {
        const media = await page.request.get(
          `/api/v1/media/listing/${listingId}`,
        );
        expect(media.status()).toBe(200);
        const items = (await media.json()) as { state: string }[];
        return (
          items.length === 5 && items.every((item) => item.state === 'ready')
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await draft
    .getByLabel('Описание', { exact: true })
    .fill('Тестовое объявление для проверки публикации и поиска.');
  const descriptionSaved = page.waitForResponse((value) =>
    endpoint(value, 'PATCH', `/api/v1/listings/${listingId}`),
  );
  await draft
    .getByRole('button', { name: 'Сохранить изменения', exact: true })
    .click();
  expect((await descriptionSaved).status()).toBe(200);
  await draft
    .getByRole('button', { name: 'Обновить состояние', exact: true })
    .click();
  await expect(
    draft.getByRole('button', {
      name: 'Отправить на модерацию',
      exact: true,
    }),
  ).toBeEnabled();
  await draft
    .getByRole('button', { name: 'Отправить на модерацию', exact: true })
    .click();
  await expect(
    draft.getByText('Статус: На модерации', { exact: true }),
  ).toBeVisible();
}

async function approveListing(staff: Page, listingId: string, title: string) {
  await login(staff, 'admin@e2e.test', 'Мой аккаунт');
  await staff.goto('/admin/moderation');
  await staff
    .getByRole('button', {
      name: new RegExp(`Открыть проверку ${listingId}, версия`),
    })
    .click();
  await expect(
    staff.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await expect(
    staff.getByRole('img', { name: 'Фотография объекта для проверки' }),
  ).toHaveCount(5);
  await expect(
    staff.getByRole('button', { name: 'Одобрить', exact: true }),
  ).toBeDisabled();
  await staff
    .getByLabel('Причина решения', { exact: true })
    .fill('Материалы проверены сотрудником, разрешена публикация.');
  await staff.getByRole('button', { name: 'Одобрить', exact: true }).click();
  const decision = staff.waitForResponse(
    (value) =>
      value.request().method() === 'POST' &&
      /\/api\/v1\/admin\/moderation\/[^/]+\/decision$/.test(
        new URL(value.url()).pathname,
      ),
  );
  await staff
    .getByRole('button', { name: 'Подтвердить решение', exact: true })
    .click();
  expect((await decision).status()).toBe(201);
  await expect(staff.locator('main').getByRole('status')).toContainText(
    'Решение сохранено',
  );
}

test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

test('owner saves a draft, uploads five photos and publishes only after staff approval', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  const title = `Проверка публикации ${info.project.name} ${randomUUID()}`;
  let listingId: string | undefined;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  try {
    await login(page, `quota-${info.project.name}@e2e.test`);
    await page.goto('/account/listings');
    const baselineResponse = await page.request.get(
      '/api/v1/account/publication-quota',
    );
    expect(baselineResponse.status()).toBe(200);
    const baseline = (await baselineResponse.json()) as {
      applies: boolean;
      limit: number;
      publishedObjects: number;
      remaining: number;
    };
    expect(baseline.applies).toBe(true);
    expect(baseline.limit).toBe(1);
    expect(baseline.publishedObjects).toBeLessThan(baseline.limit);
    const quotaPanel = page.getByRole('region', {
      name: 'Лимит публикации объектов',
    });
    await expect(quotaPanel).toContainText(
      `Активных объявлений: ${baseline.publishedObjects} из 1. Свободных мест: ${baseline.remaining}.`,
    );
    const creation = page.locator('form').filter({
      has: page.getByRole('heading', {
        name: 'Новое объявление',
        exact: true,
      }),
    });
    await creation
      .getByRole('combobox', { name: 'Категория', exact: true })
      .selectOption('commercial');
    await creation
      .getByRole('combobox', { name: 'Сделка', exact: true })
      .selectOption('long_rent');
    await creation
      .getByLabel('Тип коммерческого помещения')
      .selectOption('Офис');
    const next = creation.getByRole('button', { name: 'Далее', exact: true });
    await next.click();
    await creation
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    await creation
      .getByLabel('Адрес', { exact: true })
      .fill('Москва, Тверская улица, 15');
    await creation
      .getByLabel('Населённый пункт', { exact: true })
      .fill('Москва');
    await creation.getByLabel('Долгота', { exact: true }).fill('37.61');
    await creation.getByLabel('Широта', { exact: true }).fill('55.75');
    await next.click();
    await creation.getByLabel('Площадь, м²', { exact: false }).fill('54');
    await expect(creation.getByLabel(/Площадь кухни, м²/)).toHaveCount(0);
    await creation.getByLabel('Класс здания').selectOption('B+');
    await creation.getByLabel('Отделка помещения').selectOption('С отделкой');
    await next.click();
    await creation.getByLabel('Заголовок', { exact: true }).fill(title);
    await creation.getByLabel('Цена, ₽ в месяц', { exact: true }).fill('50000');
    await creation.getByLabel('Залог, ₽', { exact: true }).fill('0');
    await creation.getByLabel('Комиссия, %', { exact: true }).fill('0');
    const utilities = creation.getByLabel('Коммунальные платежи включены');
    await utilities.check();
    await utilities.uncheck();
    const saved = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/listings'),
    );
    await creation
      .getByRole('button', { name: 'Сохранить черновик', exact: true })
      .click();
    const response = await saved;
    expect(response.status()).toBe(201);
    listingId = ((await response.json()) as { id: string }).id;
    const draft = page
      .locator('article.panel')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(
      draft.getByText('Статус: Черновик', { exact: true }),
    ).toBeVisible();
    await expect(
      draft.getByRole('button', {
        name: 'Отправить на модерацию',
        exact: true,
      }),
    ).toBeDisabled();
    const draftQuota = await page.request.get(
      '/api/v1/account/publication-quota',
    );
    expect(draftQuota.status()).toBe(200);
    expect(await draftQuota.json()).toEqual(baseline);
    // A reload proves the draft was persisted rather than held only in component state.
    await page.reload();
    await page.getByRole('button', { name: title, exact: true }).click();
    await submitDraft(page, draft, listingId);
    expect((await visitor.request.get(`/listings/${listingId}`)).status()).toBe(
      404,
    );
    await approveListing(staff, listingId, title);
    // Public visibility is checked through an independent visitor with no seller session.
    const publicResponse = await visitor.goto(`/listings/${listingId}`);
    expect(publicResponse?.status()).toBe(200);
    await expect(
      visitor.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    const rentalTerms = visitor.locator('section').filter({
      has: visitor.getByRole('heading', {
        name: 'Условия аренды',
        exact: true,
      }),
    });
    await expect(rentalTerms.getByText('0 ₽', { exact: true })).toBeVisible();
    await expect(rentalTerms.getByText('0 %', { exact: true })).toBeVisible();
    await expect(rentalTerms.getByText('Нет', { exact: true })).toBeVisible();
    const searchDefinition = {
      category: 'commercial',
      dealType: 'long_rent',
      attributes: {
        commercial_property_type: 'Офис',
        commercial_building_class: 'B+',
        commercial_finish: 'С отделкой',
        area: { min: 50, max: 60 },
        rent_deposit: { max: 0 },
        rent_commission: { max: 0 },
        utilities_included: false,
      },
    };
    const searchPath =
      '/search?' +
      new URLSearchParams({
        definition: JSON.stringify(searchDefinition),
      });
    await expect(async () => {
      await visitor.goto(searchPath);
      await expect(
        visitor.getByRole('link', { name: title, exact: true }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
    const publishedQuota = await page.request.get(
      '/api/v1/account/publication-quota',
    );
    expect(publishedQuota.status()).toBe(200);
    expect(await publishedQuota.json()).toEqual({
      ...baseline,
      publishedObjects: baseline.publishedObjects + 1,
      remaining: baseline.remaining - 1,
    });
    await page.reload();
    await expect(quotaPanel).toContainText(
      `Активных объявлений: ${baseline.publishedObjects + 1} из 1. Свободных мест: ${baseline.remaining - 1}.`,
    );
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(
      draft.getByText('Статус: Опубликовано', { exact: true }),
    ).toBeVisible();
    const paused = page.waitForResponse((value) =>
      endpoint(value, 'POST', `/api/v1/listings/${listingId}/transitions`),
    );
    await draft
      .getByRole('button', { name: 'Приостановить', exact: true })
      .click();
    expect((await paused).status()).toBe(201);
    await expect(
      draft.getByText('Статус: Приостановлено', { exact: true }),
    ).toBeVisible();
    expect((await visitor.request.get(`/listings/${listingId}`)).status()).toBe(
      404,
    );
    const releasedQuota = await page.request.get(
      '/api/v1/account/publication-quota',
    );
    expect(releasedQuota.status()).toBe(200);
    expect(await releasedQuota.json()).toEqual(baseline);
    await quotaPanel
      .getByRole('button', { name: 'Обновить лимит публикации', exact: true })
      .click();
    await expect(quotaPanel).toContainText(
      `Активных объявлений: ${baseline.publishedObjects} из 1. Свободных мест: ${baseline.remaining}.`,
    );
    // Reload cleared the new-listing form; supply valid fields before checking
    // draft availability, so category-loading validation is not mistaken for quota.
    const secondTitle = `Черновик после освобождения места ${info.project.name} ${randomUUID()}`;
    await creation
      .getByRole('combobox', { name: 'Категория', exact: true })
      .selectOption('apartment');
    await next.click();
    await creation
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    await creation
      .getByLabel('Адрес', { exact: true })
      .fill('Москва, Тверская улица, 17');
    await creation
      .getByLabel('Населённый пункт', { exact: true })
      .fill('Москва');
    await creation.getByLabel('Долгота', { exact: true }).fill('37.62');
    await creation.getByLabel('Широта', { exact: true }).fill('55.76');
    await next.click();
    await creation.getByLabel('Площадь, м² *', { exact: true }).fill('48');
    await creation.getByLabel(/Площадь кухни, м²/).fill('9');
    await next.click();
    await creation.getByLabel('Заголовок', { exact: true }).fill(secondTitle);
    await creation.getByLabel('Цена, ₽', { exact: true }).fill('11000000');
    const saveDraft = creation.getByRole('button', {
      name: 'Сохранить черновик',
      exact: true,
    });
    await expect(saveDraft).toBeEnabled();
    const secondSaved = page.waitForResponse((value) =>
      endpoint(value, 'POST', '/api/v1/listings'),
    );
    await saveDraft.click();
    expect((await secondSaved).status()).toBe(201);
    const secondDraft = page.locator('article.panel').filter({
      has: page.getByRole('heading', { name: secondTitle, exact: true }),
    });
    await expect(
      secondDraft.getByText('Статус: Черновик', { exact: true }),
    ).toBeVisible();
    const finalQuota = await page.request.get(
      '/api/v1/account/publication-quota',
    );
    expect(finalQuota.status()).toBe(200);
    expect(await finalQuota.json()).toEqual(baseline);
    await expect(quotaPanel).toContainText(
      `Активных объявлений: ${baseline.publishedObjects} из 1. Свободных мест: ${baseline.remaining}.`,
    );
  } finally {
    if (listingId) {
      const current = await page.request.get(`/api/v1/listings/${listingId}`);
      if (current.ok()) {
        const listing = (await current.json()) as {
          version: number;
          status: string;
        };
        if (listing.status === 'published') {
          const csrf = await page.request.get('/api/v1/auth/csrf');
          expect(csrf.status()).toBe(200);
          const { csrfToken } = (await csrf.json()) as { csrfToken: string };
          const archived = await page.request.post(
            `/api/v1/listings/${listingId}/transitions`,
            {
              data: { version: listing.version, status: 'archived' },
              headers: {
                Origin: new URL(page.url()).origin,
                'X-CSRF-Token': csrfToken,
                'Idempotency-Key': randomUUID(),
              },
            },
          );
          expect(archived.status()).toBe(201);
          expect(
            (await visitor.request.get(`/listings/${listingId}`)).status(),
          ).toBe(404);
        }
      }
    }
    await staffContext.close();
    await visitorContext.close();
  }
});

async function fillApartmentDetails(form: ReturnType<Page['locator']>) {
  await form.getByLabel('Категория').selectOption('apartment');
  const next = form.getByRole('button', { name: 'Далее', exact: true });
  await next.click();
  await form
    .getByRole('combobox', { name: 'Регион', exact: true })
    .selectOption('moscow');
  for (const [label, value] of [
    ['Адрес', 'Москва, Тверская улица, 19'],
    ['Населённый пункт', 'Москва'],
    ['Долгота', '37.62'],
    ['Широта', '55.76'],
  ] as const)
    await form.getByLabel(label, { exact: true }).fill(value);
  await next.click();
  await form.getByLabel('Площадь, м² *', { exact: true }).fill('48');
  await form.getByLabel(/Площадь кухни, м²/).fill('9');
  await next.click();
}

test('agency creates its first organization and publishes a listing after moderation', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120000);
  await login(
    page,
    `agency-${info.project.name}@e2e.test`,
    'Кабинет агентства',
  );
  const agencyName = `Агентство ${randomUUID()}`;
  await page.getByLabel('Название агентства').fill(agencyName);
  const creating = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/organizations'),
  );
  await page.getByRole('button', { name: 'Создать агентство' }).click();
  const created = await creating;
  expect(created.status()).toBe(201);
  const { id: agencyId } = (await created.json()) as { id: string };
  await page.getByRole('link', { name: 'Перейти к подаче объявления' }).click();
  const form = page.locator('#new-listing');
  await expect(form.getByLabel('От чьего имени')).toHaveValue(agencyId);
  await fillApartmentDetails(form);
  await expect(form.getByText(`Агентство: ${agencyName}`)).toBeVisible();
  const title = `Черновик агентства ${randomUUID()}`;
  await form.getByLabel('Заголовок', { exact: true }).fill(title);
  await form.getByLabel('Цена, ₽', { exact: true }).fill('11000000');
  const saving = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/listings'),
  );
  await form
    .getByRole('button', { name: 'Сохранить черновик', exact: true })
    .click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  const draft = (await saved.json()) as { id: string; organization_id: string };
  expect(draft.organization_id).toBe(agencyId);
  await expect(
    page.getByRole('button', { name: title, exact: true }),
  ).toBeVisible();
  const visitorContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const agentContext = await browser.newContext();
  try {
    const agent = await agentContext.newPage();
    await login(
      agent,
      `agent-${info.project.name}@e2e.test`,
      'Кабинет риелтора',
    );
    const privatePath = `/api/v1/listings/${draft.id}`;
    expect((await agent.request.get(privatePath)).status()).toBe(403);
    const agentCode = agent
      .getByRole('region', { name: 'Агентства' })
      .locator('code');
    await agent
      .getByText('Мой код для добавления в агентство', { exact: true })
      .click();
    const management = await page.context().newPage();
    try {
      await management.goto('/account');
      const members = management.getByRole('region', {
        name: 'Сотрудники агентства',
      });
      await members
        .getByLabel('Код пользователя')
        .fill(await agentCode.innerText());
      await members
        .getByRole('button', { name: 'Добавить сотрудника' })
        .click();
      await expect(
        members.getByRole('button', { name: 'Отключить доступ' }),
      ).toBeVisible();
      await agent.goto('/account/listings');
      await expect(
        agent.getByRole('button', { name: title, exact: true }),
      ).toBeVisible();
      expect((await agent.request.get(privatePath)).status()).toBe(200);
      await members.getByRole('button', { name: 'Отключить доступ' }).click();
      await expect(
        members.getByRole('button', { name: 'Восстановить доступ сотрудника' }),
      ).toBeVisible();
      expect((await agent.request.get(privatePath)).status()).toBe(403);
    } finally {
      await management.close();
    }
    const visitor = await visitorContext.newPage();
    const listingPath = `/listings/${draft.id}`;
    expect((await visitor.request.get(listingPath)).status()).toBe(404);
    const editor = page.locator('article.panel').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
    await submitDraft(page, editor, draft.id);
    expect((await visitor.request.get(listingPath)).status()).toBe(404);
    await approveListing(await staffContext.newPage(), draft.id, title);
    expect((await visitor.goto(listingPath))?.status()).toBe(200);
    await expect(
      visitor.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    const searchPath =
      '/search?' +
      new URLSearchParams({
        definition: JSON.stringify({
          q: title,
          category: 'apartment',
          dealType: 'sale',
        }),
      });
    await expect(async () => {
      await visitor.goto(searchPath);
      await expect(
        visitor.getByRole('link', { name: title, exact: true }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
  } finally {
    await agentContext.close();
    await staffContext.close();
    await visitorContext.close();
  }
});
test('independent agent publishes from the agent cabinet and a guest finds the listing', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90000);
  await login(page, `agent-${info.project.name}@e2e.test`, 'Кабинет риелтора');
  await page.getByRole('link', { name: 'Мои объявления', exact: true }).click();
  const form = page.locator('#new-listing');
  await fillApartmentDetails(form);
  const title = `Объявление риелтора ${randomUUID()}`;
  await form.getByLabel('Заголовок', { exact: true }).fill(title);
  await form.getByLabel('Цена, ₽', { exact: true }).fill('11000000');
  const saving = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/listings'),
  );
  await form
    .getByRole('button', { name: 'Сохранить черновик', exact: true })
    .click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  const draft = (await saved.json()) as {
    id: string;
    organization_id: string | null;
  };
  expect(draft.organization_id).toBeNull();
  await expect(
    page.getByRole('button', { name: title, exact: true }),
  ).toBeVisible();
  const visitorContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    const listingPath = `/listings/${draft.id}`;
    expect((await visitor.request.get(listingPath)).status()).toBe(404);
    const editor = page.locator('article.panel').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
    await submitDraft(page, editor, draft.id);
    expect((await visitor.request.get(listingPath)).status()).toBe(404);
    await approveListing(await staffContext.newPage(), draft.id, title);
    expect((await visitor.goto(listingPath))?.status()).toBe(200);
    await expect(
      visitor.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    const searchPath =
      '/search?' +
      new URLSearchParams({
        definition: JSON.stringify({
          q: title,
          category: 'apartment',
          dealType: 'sale',
        }),
      });
    await expect(async () => {
      await visitor.goto(searchPath);
      await expect(
        visitor.getByRole('link', { name: title, exact: true }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
  } finally {
    await staffContext.close();
    await visitorContext.close();
  }
});
const publicationCases = [
  ['land', 'sale', 'Площадь участка, м² *', '750', '3500000', 'Цена, ₽'],
  ['house', 'sale', 'Площадь дома, м² *', '120', '9500000', 'Цена, ₽'],
  ['commercial', 'sale', 'Площадь, м² *', '320', '15000000', 'Цена, ₽'],
  ['apartment', 'long_rent', 'Площадь, м² *', '48', '50000', 'Цена, ₽ в месяц'],
  [
    'apartment',
    'short_rent',
    'Площадь, м² *',
    '48',
    '4500',
    'Цена, ₽ за сутки',
  ],
] as const;

for (const [
  category,
  dealType,
  areaLabel,
  size,
  price,
  priceLabel,
] of publicationCases) {
  test(`publishes ${category} for ${dealType} and a guest finds it`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(90000);
    await login(
      page,
      `agent-${info.project.name}@e2e.test`,
      'Кабинет риелтора',
    );
    await page.goto('/account/listings');
    const form = page.locator('#new-listing');
    await form.getByLabel('Категория').selectOption(category);
    await form
      .getByRole('combobox', { name: 'Сделка', exact: true })
      .selectOption(dealType, { timeout: 5000 });
    if (category === 'commercial') {
      await form
        .getByLabel(/Тип коммерческого помещения/)
        .selectOption({ label: 'Склад' });
    }
    const next = form.getByRole('button', { name: 'Далее', exact: true });
    await next.click();
    await form
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    for (const [label, value] of [
      ['Адрес', 'Москва, Тверская улица, 19'],
      ['Населённый пункт', 'Москва'],
      ['Долгота', '37.62'],
      ['Широта', '55.76'],
    ] as const) {
      await form.getByLabel(label, { exact: true }).fill(value);
    }
    await next.click();
    const area = form.getByLabel(areaLabel, { exact: true });
    await expect(area).toBeVisible();
    await next.click();
    await expect(area).toBeVisible();
    await area.fill(size);
    if (category === 'apartment')
      await form.getByLabel(/Площадь кухни, м²/).fill('9');
    await next.click();
    const title = `Проверка публикации ${randomUUID()}`;
    await form.getByLabel('Заголовок', { exact: true }).fill(title);
    await form.getByLabel(priceLabel, { exact: true }).fill(price);
    const saving = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/listings'),
    );
    await form
      .getByRole('button', { name: 'Сохранить черновик', exact: true })
      .click();
    const saved = await saving;
    expect(saved.status()).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    const staff = await browser.newContext();
    const guest = await browser.newContext();
    try {
      const visitor = await guest.newPage();
      const path = `/listings/${id}`;
      const draft = page.locator('article.panel').filter({
        has: page.getByRole('heading', { name: title, exact: true }),
      });
      await submitDraft(page, draft, id);
      expect((await visitor.request.get(path)).status()).toBe(404);
      await approveListing(await staff.newPage(), id, title);
      expect((await visitor.goto(path))?.status()).toBe(200);
      await expect(
        visitor.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
      const search =
        '/search?' +
        new URLSearchParams({
          definition: JSON.stringify({
            q: title,
            category,
            dealType,
          }),
        });
      await expect(async () => {
        await visitor.goto(search);
        await expect(
          visitor.getByRole('link', { name: title, exact: true }),
        ).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 20000 });
    } finally {
      await staff.close();
      await guest.close();
    }
  });
}

test('guest and unverified seller cannot use publication controls', async ({
  page,
}) => {
  await page.goto('/account/listings');
  await expect(
    page.getByRole('button', { name: 'Сохранить черновик', exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get('/api/v1/listings')).status()).toBe(401);
  await login(page, 'unverified@e2e.test');
  await page.goto('/account/listings');
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Подтвердите email и телефон',
  );
  await expect(
    page.getByRole('button', { name: 'Сохранить черновик', exact: true }),
  ).toHaveCount(0);
});
