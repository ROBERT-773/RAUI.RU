import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { continueWithIdentifier } from './sign-in';

test('the header sign-in dialog returns a guest to their unfinished search filters', async ({
  page,
}) => {
  await page.goto('/search?deal=sale');
  const searchUrl = page.url();
  const price = page.getByLabel('Цена до', { exact: true });
  await price.fill('15000000');
  const entry = page
    .getByRole('banner')
    .getByRole('link', { name: 'Войти в кабинет', exact: true });
  const dialog = page.getByRole('dialog', {
    name: 'Вход или регистрация',
    exact: true,
  });

  for (const close of ['button', 'Escape'] as const) {
    await entry.click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(searchUrl);
    await expect(dialog.getByRole('textbox')).toHaveCount(1);
    await expect(
      dialog.getByLabel('Email или ID', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Пароль', { exact: true })).toHaveCount(0);
    if (close === 'Escape') await page.keyboard.press('Escape');
    else
      await dialog
        .getByRole('button', { name: 'Закрыть', exact: true })
        .click();
    await expect(dialog).toBeHidden();
    await expect(entry).toBeFocused();
    await expect(page).toHaveURL(searchUrl);
    await expect(price).toHaveValue('15000000');
  }
  const publish = page.getByRole('banner').getByRole('link', {
    name: 'Разместить объявление',
    exact: true,
  });
  await publish.click();
  const publishDialog = page.getByRole('dialog', {
    name: 'Войдите, чтобы разместить объявление',
    exact: true,
  });
  await expect(
    publishDialog.getByText('Служба поддержки', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(searchUrl);
  await publishDialog
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
  await expect(publishDialog).toBeHidden();
  await expect(publish).toBeFocused();
  await expect(price).toHaveValue('15000000');

  const search = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/search',
  );
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  const response = await search;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    price: { max: 15000000 },
  });
});

test('a buyer sees their publication access status after signing in from the search header', async ({
  page,
}) => {
  await page.goto('/search');
  await page
    .getByRole('banner')
    .getByRole('link', {
      name: 'Разместить объявление',
      exact: true,
    })
    .click();
  await continueWithIdentifier(page, 'buyer@e2e.test');
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/account\?action=publish$/);
  await expect(
    page.getByRole('heading', { name: 'Кабинет покупателя', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Продолжить подачу объявления' }),
  ).toHaveCount(0);
});

test('a buyer returns to the same cabinet by public ID and password', async ({
  page,
}) => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
  const password = 'E2E-only-password-42!';
  const submit = page.getByRole('button', { name: 'Войти', exact: true });
  const cabinet = page.getByRole('heading', {
    name: 'Кабинет покупателя',
    exact: true,
  });

  await page.goto('/account');
  const dialog = page.getByRole('dialog', { name: 'Вход или регистрация' });
  await expect(
    dialog.getByLabel('Email или ID', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Пароль', { exact: true })).toHaveCount(0);
  const viewport = page.viewportSize();
  if (viewport) await page.setViewportSize({ ...viewport, height: 360 });
  await continueWithIdentifier(page, 'buyer@e2e.test');
  await page.getByLabel('Пароль', { exact: true }).fill('short');
  await page.getByLabel('Пароль', { exact: true }).press('Enter');
  const alert = page.locator('form').getByRole('alert');
  await expect(alert).toContainText('Проверьте адрес почты и пароль');
  await expect(alert).toBeInViewport();
  await expect(alert).toBeFocused();
  if (viewport) await page.setViewportSize(viewport);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await expect(alert).toHaveCount(0);
  await submit.click();
  await expect(cabinet).toBeVisible();
  const id = page.getByText(/^ID: [1-9][0-9]*$/);
  const accountLabel = await id.innerText();
  const publicId = accountLabel.slice('ID: '.length);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();

  await continueWithIdentifier(page, publicId);
  await page.getByLabel('Пароль', { exact: true }).fill('wrong-password');
  await submit.click();
  await expect(alert).toContainText('Проверьте ID пользователя и пароль');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await submit.click();
  await expect(cabinet).toBeVisible();
  await expect(page.getByText(accountLabel, { exact: true })).toBeVisible();
});
