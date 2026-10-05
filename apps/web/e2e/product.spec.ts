import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
test.beforeEach(() => {
  execFileSync(process.execPath, ['../api/scripts/e2e-reset-limits.mjs']);
});
async function login(page: Page) {
  await page.goto('/account');
  await page.getByLabel('Email', { exact: true }).fill('buyer@e2e.test');
  await page
    .getByLabel('Пароль', { exact: true })
    .fill('E2E-only-password-42!');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Мой аккаунт' }),
  ).toBeVisible();
  await expect(
    page.getByText('Тестовый пользователь', { exact: true }),
  ).toBeVisible();
}
test('search → filter → detail → favorite and comparison', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await page.getByLabel('Цена до', { exact: true }).fill('15000000');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/search\?definition=/);
  await page.reload();
  await expect(page.getByLabel('Цена до', { exact: true })).toHaveValue(
    '15000000',
  );
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Описание', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'В избранное', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Добавлено в избранное');
  await page.getByRole('button', { name: 'Сравнить', exact: true }).click();
  await page
    .getByRole('link', { name: 'Открыть аккаунт', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Квартира 2 комнаты', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Сравнение', exact: true }).click();
  await expect(
    page.getByRole('table', { name: 'Сравнение объектов' }),
  ).toBeVisible();
});
test('map/list viewport synchronization and keyboard markers', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Карта', exact: true }).click();
  await expect(page.locator('.leaflet-map')).toBeVisible();
  await expect(page.locator('.price-marker').first()).toBeVisible();
  await expect
    .poll(async () =>
      page
        .locator('.price-marker span')
        .evaluateAll((nodes) =>
          nodes.reduce(
            (sum, node) => sum + Number(node.getAttribute('data-count')),
            0,
          ),
        ),
    )
    .toBe(2);
  await expect(page.locator('.price-marker').first()).toHaveAttribute(
    'tabindex',
    '0',
  );
  await page.screenshot({
    path: '../../.cache/map-' + test.info().project.name + '.png',
  });
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Квартира 2 комнаты', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Квартира 3 комнаты', exact: true }),
  ).toBeVisible();
});
test('saved search CRUD and reopening filters', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await page.getByLabel('Цена до', { exact: true }).fill('15000000');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?definition=/);
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Сохранить поиск', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Поиск сохранён' }),
  ).toBeVisible();
  await page.goto('/account');
  await page
    .getByRole('button', { name: 'Сохранённые поиски', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Открыть поиск', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
});
test('inquiry and account messages', async ({ page }, testInfo) => {
  const text = 'Можно посмотреть квартиру? ' + testInfo.project.name;
  await login(page);
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await page.getByLabel('Сообщение продавцу', { exact: true }).fill(text);
  await page
    .getByRole('button', { name: 'Отправить сообщение', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Сообщение отправлено');
  await page.goto('/account');
  await page.getByRole('button', { name: 'Сообщения', exact: true }).click();
  await page
    .getByRole('button', { name: 'Открыть переписку', exact: true })
    .click();
  await expect(page.getByText(text, { exact: false })).toBeVisible();
});
for (const delayed of [false, true]) {
  test(`Account private messages cannot cross identities${delayed ? ' even with a late response' : ''}`, async ({
    page,
  }, info) => {
    const text = `RC private ${delayed} ${info.project.name}`;
    if (delayed)
      await page.addInitScript(() => {
        const state = window as unknown as { rcMessagesRead: number };
        state.rcMessagesRead = 0;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          if (String(args[0]).includes('/messages')) {
            const json = response.json.bind(response);
            response.json = async () => {
              const value: unknown = await json();
              state.rcMessagesRead++;
              return value;
            };
          }
          return response;
        };
      });
    await login(page);
    await page.goto('/');
    await page
      .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
      .click();
    await page.getByLabel('Сообщение продавцу', { exact: true }).fill(text);
    await page
      .getByRole('button', { name: 'Отправить сообщение', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Сообщение отправлено',
    );
    await page.goto('/account');
    const threadsResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/account/threads'),
    );
    await page.getByRole('button', { name: 'Сообщения', exact: true }).click();
    const { items } = (await (await threadsResponse).json()) as {
      items: { id: string }[];
    };
    expect(items).toHaveLength(1);
    const messagesPath = `/api/v1/account/threads/${items[0]!.id}/messages`;
    let release: (() => void) | undefined;
    let delivered: Promise<void> | undefined;
    if (delayed) {
      let prepared!: () => void, finished!: () => void;
      const ready = new Promise<void>((done) => {
        prepared = done;
      });
      delivered = new Promise<void>((done) => {
        finished = done;
      });
      const resume = new Promise<void>((done) => {
        release = done;
      });
      await page.route('**' + messagesPath, async (route) => {
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        const payload = (await actual.json()) as { items: { body: string }[] };
        expect(payload.items.some((item) => item.body === text)).toBe(true);
        prepared();
        await resume;
        await route.fulfill({ response: actual });
        finished();
      });
      await page
        .getByRole('button', { name: 'Открыть переписку', exact: true })
        .click();
      await ready;
    } else {
      await page
        .getByRole('button', { name: 'Открыть переписку', exact: true })
        .click();
      await expect(page.getByText(text, { exact: false })).toBeVisible();
    }
    try {
      await page.getByRole('button', { name: 'Выйти', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Войти в аккаунт' }),
      ).toBeVisible();
      expect((await page.request.get(messagesPath)).status()).toBe(401);
      // Stay in the mounted account component: navigation/reload would hide the regression.
      await page.getByLabel('Email', { exact: true }).fill('outsider@e2e.test');
      await page
        .getByLabel('Пароль', { exact: true })
        .fill('E2E-only-password-42!');
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Мой аккаунт' }),
      ).toBeVisible();
      release?.();
      if (delivered) {
        await delivered;
        await page.waitForFunction(
          () =>
            (window as unknown as { rcMessagesRead: number }).rcMessagesRead >
            0,
        );
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
      }
      await expect(page.getByText(text, { exact: false })).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Сообщения', exact: true })
        .click();
      await expect(
        page.getByText('Напишите продавцу на странице объявления.'),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Переписка' })).toHaveCount(
        0,
      );
      // Participant denial deliberately hides thread existence (existing API contract).
      const denied = await page.request.get(messagesPath);
      expect(denied.status()).toBe(404);
      expect(await denied.text()).not.toContain(text);
    } finally {
      release?.();
      await page.unroute('**' + messagesPath);
    }
  });
}

test('accessibility and responsive search baseline', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused();
});

test('listing SEO metadata and unavailable pages are safe', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Квартира 2 комнаты', exact: true })
    .click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new RegExp('/listings/'),
  );
  const structured = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ??
      '{}',
  );
  expect(structured['@type']).toBe('RealEstateListing');
  const canonical = await page
    .locator('link[rel="canonical"]')
    .getAttribute('href');
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('application/xml');
  const partitions = await page.evaluate(
    (xml) => {
      const document = new DOMParser().parseFromString(xml, 'application/xml');
      if (document.querySelector('parsererror'))
        throw new Error('Invalid sitemap XML');
      return Array.from(
        document.querySelectorAll('sitemap > loc'),
        (loc) => loc.textContent!,
      );
    },
    await sitemap.text(),
  );
  expect(partitions.length).toBeGreaterThan(0);
  const listingUrls: string[] = [];
  for (const partition of partitions) {
    const shard = await page.request.get(partition);
    expect(shard.status()).toBe(200);
    expect(shard.headers()['content-type']).toContain('application/xml');
    const urls = await page.evaluate(
      (xml) => {
        const document = new DOMParser().parseFromString(
          xml,
          'application/xml',
        );
        if (document.querySelector('parsererror'))
          throw new Error('Invalid shard XML');
        return Array.from(
          document.querySelectorAll('url > loc'),
          (loc) => loc.textContent!,
        );
      },
      await shard.text(),
    );
    expect(urls.length).toBeLessThanOrEqual(50000);
    listingUrls.push(...urls);
  }
  expect(listingUrls).toContain(canonical);
  expect(new Set(listingUrls).size).toBe(listingUrls.length);
  const response = await page.goto(
    '/listings/00000000-0000-4000-8000-000000000000',
  );
  expect(response?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    'content',
    /noindex/,
  );
});

test('HTML uses fresh CSP nonces and protected browser headers', async ({
  page,
}) => {
  const first = await page.goto('/');
  const headers = first?.headers() ?? {};
  const policy = headers['content-security-policy'] ?? '';
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("'strict-dynamic'");
  expect(
    policy.split(';').find((value) => value.trim().startsWith('script-src')),
  ).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  const inlineNonces = await page
    .locator('script:not([src])')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLScriptElement).nonce),
    );
  expect(inlineNonces.length).toBeGreaterThan(0);
  expect(inlineNonces.every((value) => value === nonce)).toBe(true);
  const second = await page.reload();
  expect(second?.headers()['content-security-policy']).not.toContain(
    "'nonce-" + nonce + "'",
  );
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
});
