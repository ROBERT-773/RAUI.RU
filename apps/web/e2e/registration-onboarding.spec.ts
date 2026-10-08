import { test, expect, type Page, type Response } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const password = 'E2E-only-password-42!';
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
    page.getByRole('heading', { name: 'Мой аккаунт', exact: true }),
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
    await page
      .getByRole('button', { name: 'Регистрация', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: /Тип аккаунта/ })
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
      page.getByRole('heading', { name: 'Мой аккаунт', exact: true }),
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
    await login(staff, 'admin@e2e.test');
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
      page.getByRole('heading', { name: 'Войти в аккаунт', exact: true }),
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
      secondOwner.getByRole('heading', {
        name: 'Войти в аккаунт',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    const rejectedLogin = page.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/login'),
    );
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    expect((await rejectedLogin).status()).toBe(401);
    await expect(
      page.getByRole('heading', { name: 'Войти в аккаунт', exact: true }),
    ).toBeVisible();
  } finally {
    await staffContext.close();
    await secondOwnerContext.close();
  }
});
