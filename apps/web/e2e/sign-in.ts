import type { Page } from '@playwright/test';

export async function continueWithIdentifier(page: Page, identifier: string) {
  await page.getByLabel('Email или ID', { exact: true }).fill(identifier);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
}

export async function openSignInOptions(page: Page) {
  await page
    .getByRole('dialog', { name: 'Вход или регистрация', exact: true })
    .getByText('Другой способ', { exact: true })
    .click();
}
