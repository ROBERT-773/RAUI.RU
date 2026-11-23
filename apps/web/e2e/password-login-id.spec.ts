import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

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
  await page.getByLabel('Email', { exact: true }).fill('buyer@e2e.test');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await submit.click();
  await expect(cabinet).toBeVisible();
  const id = page.getByText(/^ID: [1-9][0-9]*$/);
  const accountLabel = await id.innerText();
  const publicId = accountLabel.slice('ID: '.length);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();

  await page.getByRole('button', { name: 'Войти по ID', exact: true }).click();
  await page.getByLabel('ID пользователя', { exact: true }).fill(publicId);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await submit.click();
  await expect(cabinet).toBeVisible();
  await expect(page.getByText(accountLabel, { exact: true })).toBeVisible();
});
