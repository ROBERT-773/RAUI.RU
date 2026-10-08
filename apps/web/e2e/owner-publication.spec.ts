import { test, expect, type Page, type Response } from '@playwright/test';
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
async function login(page: Page, email: string) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Мой аккаунт' }),
  ).toBeVisible();
}
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

test('owner saves a draft, uploads a real photo and publishes only after staff approval', async ({
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
    await login(page, 'seller@e2e.test');
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
    expect(baseline.limit).toBe(6);
    expect(baseline.publishedObjects).toBeLessThan(baseline.limit);
    const quotaPanel = page.getByRole('region', {
      name: 'Лимит публикации объектов',
    });
    await expect(quotaPanel).toContainText(
      `Опубликовано объектов: ${baseline.publishedObjects} из 6. Свободных мест: ${baseline.remaining}.`,
    );
    const creation = page.locator('form').filter({
      has: page.getByRole('heading', {
        name: 'Новое объявление',
        exact: true,
      }),
    });
    await creation
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    await creation
      .getByRole('combobox', { name: 'Категория', exact: true })
      .selectOption('apartment');
    await creation
      .getByLabel('Адрес', { exact: true })
      .fill('Москва, Тверская улица, 15');
    await creation
      .getByLabel('Населённый пункт', { exact: true })
      .fill('Москва');
    await creation.getByLabel('Долгота', { exact: true }).fill('37.61');
    await creation.getByLabel('Широта', { exact: true }).fill('55.75');
    await creation.getByLabel('Площадь, м²', { exact: false }).fill('54');
    await creation.getByLabel('Заголовок', { exact: true }).fill(title);
    await creation.getByLabel('Цена, ₽', { exact: true }).fill('12000000');
    await creation
      .getByLabel('Описание', { exact: true })
      .fill('Реальная квартира для проверки полного процесса публикации.');
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
    const uploaded = page.waitForResponse((value) =>
      endpoint(value, 'POST', '/api/v1/media'),
    );
    await draft
      .getByLabel('Добавить фотографию', { exact: true })
      .setInputFiles({
        name: 'apartment.png',
        mimeType: 'image/png',
        buffer: png,
      });
    expect((await uploaded).status()).toBe(201);
    await expect
      .poll(
        async () => {
          const media = await page.request.get(
            `/api/v1/media/listing/${listingId}`,
          );
          expect(media.status()).toBe(200);
          const items = (await media.json()) as { state: string }[];
          return (
            items.length === 1 && items.every((item) => item.state === 'ready')
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
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
    expect((await visitor.request.get(`/listings/${listingId}`)).status()).toBe(
      404,
    );
    await login(staff, 'admin@e2e.test');
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
    ).toBeVisible();
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
    // Public visibility is checked through an independent visitor with no seller session.
    const publicResponse = await visitor.goto(`/listings/${listingId}`);
    expect(publicResponse?.status()).toBe(200);
    await expect(
      visitor.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
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
      `Опубликовано объектов: ${baseline.publishedObjects + 1} из 6. Свободных мест: ${baseline.remaining - 1}.`,
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
      `Опубликовано объектов: ${baseline.publishedObjects} из 6. Свободных мест: ${baseline.remaining}.`,
    );
    // Reload cleared the new-listing form; supply valid fields before checking
    // draft availability, so category-loading validation is not mistaken for quota.
    const secondTitle = `Черновик после освобождения места ${info.project.name} ${randomUUID()}`;
    await creation
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    await creation
      .getByRole('combobox', { name: 'Категория', exact: true })
      .selectOption('apartment');
    await creation
      .getByLabel('Адрес', { exact: true })
      .fill('Москва, Тверская улица, 17');
    await creation
      .getByLabel('Населённый пункт', { exact: true })
      .fill('Москва');
    await creation.getByLabel('Долгота', { exact: true }).fill('37.62');
    await creation.getByLabel('Широта', { exact: true }).fill('55.76');
    await creation.getByLabel('Площадь, м²', { exact: false }).fill('48');
    await creation.getByLabel('Заголовок', { exact: true }).fill(secondTitle);
    await creation.getByLabel('Цена, ₽', { exact: true }).fill('11000000');
    await creation
      .getByLabel('Описание', { exact: true })
      .fill('Черновик остаётся доступным после освобождения места публикации.');
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
      `Опубликовано объектов: ${baseline.publishedObjects} из 6. Свободных мест: ${baseline.remaining}.`,
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
