import { continueWithIdentifier, openSignInOptions } from './sign-in';
import { test, expect, type Page, type Response } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  await continueWithIdentifier(page, email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: heading, exact: true }),
  ).toBeVisible();
}
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});

test('pending owner verifies onboarding boundaries and staff rejection revokes existing sessions', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(60000);
  const namespace = randomUUID();
  const email = `onboarding-${namespace}@e2e.test`;
  const name = `Новый собственник ${info.project.name} ${namespace}`;
  const staffContext = await browser.newContext();
  const secondOwnerContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const secondOwner = await secondOwnerContext.newPage();
  try {
    await page.goto('/account');
    await openSignInOptions(page);
    await page
      .getByRole('button', { name: 'Регистрация', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Кто вы?', exact: true })
      .selectOption('owner');
    await page.getByLabel('Имя', { exact: true }).fill(name);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    const registration = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/register'),
    );
    await page
      .getByRole('button', { name: 'Создать и войти', exact: true })
      .click();
    const created = await registration;
    expect(created.status()).toBe(201);
    const account = (await created.json()) as {
      public_id: string;
      registration_approval_state: string;
    };
    expect(account.registration_approval_state).toBe('pending');
    await expect(
      page.getByRole('heading', { name: 'Кабинет собственника', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`ID: ${account.public_id}`, { exact: true }),
    ).toBeVisible();
    const profile = page.getByRole('region', {
      name: 'Профиль и подтверждение контактов',
    });
    await expect(
      profile.getByText('Ожидает одобрения сотрудника', { exact: true }),
    ).toBeVisible();
    await expect(
      profile.getByText('Роль: Собственник', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Разделы аккаунта' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Мои объявления', exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get('/api/v1/listings')).status()).toBe(403);
    expect(
      (await page.request.get('/api/v1/account/collections/favorite')).status(),
    ).toBe(403);
    await profile
      .getByLabel('Номер телефона', { exact: true })
      .fill('+79990000000');
    const phoneRequest = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/verification/phone'),
    );
    await profile
      .getByRole('button', {
        name: 'Запросить подтверждение телефона',
        exact: true,
      })
      .click();
    expect((await phoneRequest).status()).toBe(201);
    await expect(profile.getByRole('status')).toContainText(
      'принятие запроса не подтверждает доставку',
    );
    // No token or local delivery spool is read: neither contact is verified by this test.
    await login(secondOwner, email);
    await expect(
      secondOwner.getByText('Ожидает одобрения сотрудника', { exact: true }),
    ).toBeVisible();
    await login(staff, 'admin@e2e.test', 'Мой аккаунт');
    await staff.goto('/admin/registration-approvals');
    await staff
      .getByRole('button', {
        name: `Открыть заявку ${name} — ID ${account.public_id}`,
        exact: true,
      })
      .click();
    await expect(staff.getByText(email, { exact: true })).toBeVisible();
    await staff
      .getByLabel('Причина решения', { exact: true })
      .fill('Контакты не подтверждены; заявка отклонена сотрудником.');
    await expect(
      staff.getByRole('button', { name: 'Одобрить', exact: true }),
    ).toBeDisabled();
    await staff.getByRole('button', { name: 'Отклонить', exact: true }).click();
    const decision = staff.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/admin\/registration-approvals\/[^/]+\/decision$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await staff
      .getByRole('button', { name: 'Подтвердить решение', exact: true })
      .click();
    const resolved = await decision;
    expect(resolved.status()).toBe(201);
    expect(((await resolved.json()) as { state: string }).state).toBe(
      'rejected',
    );
    await expect(staff.locator('main').getByRole('status')).toContainText(
      'Решение сохранено.',
    );
    const refreshed = page.waitForResponse((response) =>
      endpoint(response, 'GET', '/api/v1/auth/me'),
    );
    await profile
      .getByRole('button', { name: 'Обновить профиль', exact: true })
      .click();
    expect((await refreshed).status()).toBe(401);
    await expect(
      page.getByRole('dialog', { name: 'Вход или регистрация', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    // Another already-open onboarding session can exit after the same revocation.
    const logout = secondOwner.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/logout'),
    );
    await secondOwner
      .getByRole('button', { name: 'Выйти', exact: true })
      .click();
    expect((await logout).status()).toBe(401);
    await expect(
      secondOwner.getByRole('dialog', {
        name: 'Вход или регистрация',
        exact: true,
      }),
    ).toBeVisible();
    await continueWithIdentifier(page, email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    const rejectedLogin = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/login'),
    );
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    expect((await rejectedLogin).status()).toBe(401);
    await expect(
      page.getByRole('heading', { name: 'Введите пароль', exact: true }),
    ).toBeVisible();
  } finally {
    await staffContext.close();
    await secondOwnerContext.close();
  }
});

test('new owner registers, saves a draft and publishes after moderation', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const namespace = randomUUID();
  const email = `approved-${namespace}@e2e.test`;
  const name = `Новый собственник ${namespace}`;
  const title = `Первый черновик ${namespace}`;
  const staffContext = await browser.newContext();
  const visitorContext = await browser.newContext();
  try {
    await page.goto('/account');
    await openSignInOptions(page);
    await page
      .getByRole('button', { name: 'Регистрация', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Кто вы?', exact: true })
      .selectOption('owner');
    await page.getByLabel('Имя', { exact: true }).fill(name);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    const registration = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/register'),
    );
    await page
      .getByRole('button', { name: 'Создать и войти', exact: true })
      .click();
    const created = await registration;
    expect(created.status()).toBe(201);
    const account = (await created.json()) as {
      public_id: string;
      registration_approval_state: string;
    };
    expect(account.registration_approval_state).toBe('pending');
    await expect(
      page.getByRole('heading', { name: 'Кабинет собственника', exact: true }),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/listings')).status()).toBe(403);

    const privateDirectory = process.env.LOCAL_PRIVATE_DIR;
    if (process.env.NODE_ENV !== 'test' || !privateDirectory)
      throw Error('Expected a private E2E delivery directory');
    const mailbox = join(privateDirectory, 'verification', 'messages.jsonl');
    async function confirmationToken(destination: string, purpose: string) {
      const deliveries = (await readFile(mailbox, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const token = deliveries
        .reverse()
        .find(
          (item) =>
            item.destination === destination && item.purpose === purpose,
        )?.token;
      if (!token) throw Error('Expected a test verification message');
      return token as string;
    }
    const emailConfirmation = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/verification/email/confirm'),
    );
    await page
      .getByLabel('Код подтверждения email из сообщения')
      .fill(await confirmationToken(email, 'email'));
    await page
      .getByRole('button', { name: 'Подтвердить email', exact: true })
      .click();
    expect((await emailConfirmation).status()).toBe(201);
    const phone =
      '+700000000' + String(test.info().project.name.length).padStart(2, '0');
    const phoneInput = page.getByLabel('Номер телефона', { exact: true });
    await expect(phoneInput).toBeEnabled();
    await expect(phoneInput).toHaveValue('+7');
    await phoneInput.fill('8 ' + phone.slice(2));
    const phoneRequest = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/verification/phone'),
    );
    await page
      .getByRole('button', {
        name: 'Запросить подтверждение телефона',
        exact: true,
      })
      .click();
    expect((await phoneRequest).status()).toBe(201);
    const phoneConfirmation = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/verification/phone/confirm'),
    );
    await page
      .getByLabel('Код подтверждения телефона из сообщения')
      .fill(await confirmationToken(phone, 'phone'));
    await page
      .getByRole('button', { name: 'Подтвердить телефон', exact: true })
      .click();
    expect((await phoneConfirmation).status()).toBe(201);
    await expect
      .poll(async () => {
        const result = await page.request.get('/api/v1/auth/me');
        if (!result.ok()) return false;
        const profile = await result.json();
        return Boolean(profile.email_verified_at && profile.phone_verified_at);
      })
      .toBe(true);

    const staff = await staffContext.newPage();
    await login(staff, 'admin@e2e.test', 'Мой аккаунт');
    await staff.goto('/admin/registration-approvals');
    await staff
      .getByRole('button', {
        name: `Открыть заявку ${name} — ID ${account.public_id}`,
        exact: true,
      })
      .click();
    await staff
      .getByLabel('Причина решения', { exact: true })
      .fill('Контакты подтверждены в тестовом сценарии.');
    await staff.getByRole('button', { name: 'Одобрить', exact: true }).click();
    await staff
      .getByRole('button', { name: 'Подтвердить решение', exact: true })
      .click();
    await expect(staff.locator('main').getByRole('status')).toContainText(
      'Решение сохранено.',
    );

    await page.reload();
    await page
      .getByRole('link', { name: 'Мои объявления', exact: true })
      .click();
    const form = page.locator('form').filter({
      has: page.getByRole('heading', {
        name: 'Новое объявление',
        exact: true,
      }),
    });
    const next = form.getByRole('button', { name: 'Далее', exact: true });
    await form
      .getByRole('combobox', { name: 'Категория', exact: true })
      .selectOption('apartment');
    await next.click();
    await form
      .getByRole('combobox', { name: 'Регион', exact: true })
      .selectOption('moscow');
    await form
      .getByLabel('Адрес', { exact: true })
      .fill('Москва, Тверская улица, 17');
    await form.getByLabel('Населённый пункт', { exact: true }).fill('Москва');
    await form.getByLabel('Долгота', { exact: true }).fill('37.62');
    await form.getByLabel('Широта', { exact: true }).fill('55.76');
    await next.click();
    await form.getByLabel('Площадь, м² *', { exact: true }).fill('48');
    await form.getByLabel(/Площадь кухни, м²/).fill('9');
    await next.click();
    await form.getByLabel('Заголовок', { exact: true }).fill(title);
    await form.getByLabel('Цена, ₽', { exact: true }).fill('11000000');
    const save = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/listings'),
    );
    await form
      .getByRole('button', { name: 'Перейти к фотографиям', exact: true })
      .click();
    const saved = await save;
    expect(saved.status()).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    await expect(
      page.getByText('Статус: Черновик', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(
      page.getByText('Статус: Черновик', { exact: true }),
    ).toBeVisible();
    expect(
      (await page.request.get('/api/v1/listings/' + id + '/public')).status(),
    ).toBe(404);

    const visitor = await visitorContext.newPage();
    expect((await visitor.request.get('/listings/' + id)).status()).toBe(404);
    const listing = page.locator('article.panel').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
    for (let number = 1; number <= 5; number++) {
      const upload = page.waitForResponse((response) =>
        endpoint(response, 'POST', '/api/v1/media'),
      );
      await listing
        .getByLabel('Добавить фотографию', { exact: true })
        .setInputFiles({
          name: `listing-${number}.png`,
          mimeType: 'image/png',
          buffer: png,
        });
      expect((await upload).status()).toBe(201);
      await expect(
        listing.getByText(`Загружено фотографий: ${number} из 21.`),
      ).toBeVisible();
    }
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            '/api/v1/media/listing/' + id,
          );
          if (!response.ok()) return false;
          const media = (await response.json()) as { state: string }[];
          return (
            media.length === 5 && media.every(({ state }) => state === 'ready')
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    await listing
      .getByLabel('Описание', { exact: true })
      .fill('Тестовое объявление для проверки публикации после регистрации.');
    const descriptionSaved = page.waitForResponse((response) =>
      endpoint(response, 'PATCH', '/api/v1/listings/' + id),
    );
    await listing
      .getByRole('button', { name: 'Сохранить изменения', exact: true })
      .click();
    expect((await descriptionSaved).status()).toBe(200);
    await listing
      .getByRole('button', { name: 'Обновить состояние', exact: true })
      .click();
    await listing
      .getByRole('button', { name: 'Перейти к предпросмотру', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Предпросмотр объявления',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Отправить на модерацию', exact: true })
      .click();
    await expect(
      listing.getByText('Статус: На модерации', { exact: true }),
    ).toBeVisible();
    expect((await visitor.request.get('/listings/' + id)).status()).toBe(404);

    await staff.goto('/admin/moderation');
    await staff
      .getByRole('button', {
        name: new RegExp('Открыть проверку ' + id + ', версия'),
      })
      .click();
    await expect(
      staff.getByRole('img', { name: 'Фотография объекта для проверки' }),
    ).toHaveCount(5);
    const rejectionReason = 'Уточните описание квартиры.';
    const correctedDescription =
      'Квартира с отдельной кухней и окнами во двор.';
    await staff
      .getByLabel('Причина решения', { exact: true })
      .fill(rejectionReason);
    await staff.getByRole('button', { name: 'Отклонить', exact: true }).click();
    await staff
      .getByRole('button', { name: 'Подтвердить решение', exact: true })
      .click();
    await expect(staff.locator('main').getByRole('status')).toContainText(
      'Решение сохранено',
    );
    expect((await visitor.request.get('/listings/' + id)).status()).toBe(404);

    await page.reload();
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(
      listing.getByText('Статус: Отклонено', { exact: true }),
    ).toBeVisible();
    await expect(
      listing.getByText('Причина отклонения: ' + rejectionReason, {
        exact: true,
      }),
    ).toBeVisible();
    await listing
      .getByRole('textbox', { name: 'Описание', exact: true })
      .fill(correctedDescription);
    const update = page.waitForResponse((response) =>
      endpoint(response, 'PATCH', '/api/v1/listings/' + id),
    );
    await listing
      .getByRole('button', { name: 'Сохранить изменения', exact: true })
      .click();
    expect((await update).status()).toBe(200);
    await listing
      .getByRole('button', { name: 'Перейти к предпросмотру', exact: true })
      .click();
    const correctedPreview = page.getByRole('region', {
      name: 'Сохранённые данные объявления',
      exact: true,
    });
    await expect(
      correctedPreview.getByText(correctedDescription, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Отправить на модерацию', exact: true })
      .click();
    await expect(
      listing.getByText('Статус: На модерации', { exact: true }),
    ).toBeVisible();

    await staff.reload();
    await staff
      .getByRole('button', {
        name: new RegExp('Открыть проверку ' + id + ', версия'),
      })
      .click();
    await expect(
      staff.getByText(correctedDescription, { exact: true }),
    ).toBeVisible();
    await staff
      .getByLabel('Причина решения', { exact: true })
      .fill('Фото и объявление проверены.');
    await staff.getByRole('button', { name: 'Одобрить', exact: true }).click();
    await staff
      .getByRole('button', { name: 'Подтвердить решение', exact: true })
      .click();
    await expect(staff.locator('main').getByRole('status')).toContainText(
      'Решение сохранено',
    );
    expect((await visitor.goto('/listings/' + id))?.status()).toBe(200);
    await expect(
      visitor.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      visitor.getByText(correctedDescription, { exact: true }),
    ).toBeVisible();
    const search =
      '/search?' +
      new URLSearchParams({
        definition: JSON.stringify({
          category: 'apartment',
          dealType: 'sale',
          regionCode: 'moscow',
        }),
      });
    await expect(async () => {
      await visitor.goto(search);
      await expect(
        visitor.getByRole('link', { name: title, exact: true }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });

    const mapSearch = search + '&mode=map';
    async function mapContainsListing() {
      const result = visitor.waitForResponse((response) =>
        endpoint(response, 'POST', '/api/v1/search/map'),
      );
      await visitor.goto(mapSearch);
      const response = await result;
      expect(response.status()).toBe(201);
      const { markers } = (await response.json()) as {
        markers: { listingIds: string[] }[];
      };
      return markers.some(({ listingIds }) => listingIds.includes(id));
    }
    await expect.poll(mapContainsListing, { timeout: 20000 }).toBe(true);

    await page.reload();
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(
      listing.getByText('Статус: Опубликовано', { exact: true }),
    ).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await listing.getByRole('button', { name: 'В архив', exact: true }).click();
    await expect(
      listing.getByText('Статус: В архиве', { exact: true }),
    ).toBeVisible();
    expect((await visitor.request.get('/listings/' + id)).status()).toBe(404);
    await expect.poll(mapContainsListing, { timeout: 20000 }).toBe(false);
    await expect(async () => {
      await visitor.goto(search);
      await expect(
        visitor.getByRole('status').filter({ hasText: 'Найдено около' }),
      ).toBeVisible({ timeout: 3000 });
      await expect(
        visitor.getByRole('link', { name: title, exact: true }),
      ).toHaveCount(0);
    }).toPass({ timeout: 20000 });
  } finally {
    await staffContext.close();
    await visitorContext.close();
  }
});
