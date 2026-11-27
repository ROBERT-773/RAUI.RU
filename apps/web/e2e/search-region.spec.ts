import { expect, test } from '@playwright/test';

test('a direct deal link searches nationwide or within its selected region on the list and map', async ({
  page,
}) => {
  const nationwide = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/search',
  );
  await page.goto('/search?deal=sale');
  const results = await nationwide;
  expect(results.status()).toBe(201);
  expect(results.request().postDataJSON()).toEqual({
    limit: 20,
    dealType: 'sale',
  });
  await expect(
    page.getByRole('combobox', { name: 'Город', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('link', { name: 'Квартира 2 комнаты', exact: true }),
  ).toBeVisible();

  const map = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/search/map',
  );
  await page.goto('/search?region=tatarstan&deal=sale&mode=map');
  const regional = await map;
  expect(regional.status()).toBe(201);
  expect(regional.request().postDataJSON()).toMatchObject({
    regionCode: 'tatarstan',
    dealType: 'sale',
  });
  expect(regional.request().postDataJSON()).not.toHaveProperty('locality');
  await expect(
    page.getByRole('combobox', { name: 'Регион', exact: true }),
  ).toHaveValue('tatarstan');
  await expect(
    page.getByRole('combobox', { name: 'Город', exact: true }),
  ).toHaveValue('');

  await page.goto('/search?deal=sale&city=moscow');
  await expect(
    page.getByRole('combobox', { name: 'Город', exact: true }),
  ).toHaveValue('Москва');
});

test('the search button fits on a short phone before scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/search');
  const submit = page.getByRole('button', { name: 'Найти', exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
