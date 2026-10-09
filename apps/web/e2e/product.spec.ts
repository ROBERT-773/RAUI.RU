import {
  test,
  expect,
  type Page,
  type Locator,
  type Response as PlaywrightResponse,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import type { SearchDefinition } from '@raui/types/product';
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

type Bounds = [number, number, number, number];
type SavedRow = { id: string; name: string; definition: unknown };
const centerX = (b: Bounds) => (b[0] + b[2]) / 2;
const width = (b: Bounds) => b[2] - b[0];
function currentBounds(page: Page): Bounds {
  return JSON.parse(new URL(page.url()).searchParams.get('definition')!).bounds;
}
function endpoint(response: PlaywrightResponse, method: string, path: string) {
  return (
    response.request().method() === method &&
    new URL(response.url()).pathname === path
  );
}
test('same-route navigation and history restore a saved search URL without reloading the document', async ({
  page,
}) => {
  const definition: SearchDefinition = {
    category: 'apartment',
    dealType: 'sale',
    locality: 'Москва',
    price: { max: 15000000 },
    attributes: { rooms: { min: 2, max: 2 }, area: { min: 40, max: 90 } },
    sort: 'price_asc',
    limit: 20,
  };
  const savedUrl =
    '/search?' +
    new URLSearchParams({
      definition: JSON.stringify(definition),
      mode: 'list',
    });
  await page.goto(savedUrl);
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { raui48Document: string }).raui48Document =
      'same-document';
  });
  // A real Next Link keeps the /search route mounted while its parameters change.
  const clear = page.waitForResponse(
    (response) =>
      endpoint(response, 'POST', '/api/v1/search') &&
      JSON.stringify(response.request().postDataJSON()) ===
        JSON.stringify({ limit: 20 }),
  );
  await page.getByRole('link', { name: 'Недвижимость', exact: true }).click();
  expect((await clear).status()).toBe(201);
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByLabel('Цена до', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Комнат от', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Площадь до, м²', { exact: true })).toHaveValue(
    '',
  );
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toBeVisible();
  const restored = page.waitForResponse(
    (response) =>
      endpoint(response, 'POST', '/api/v1/search') &&
      JSON.stringify(response.request().postDataJSON()) ===
        JSON.stringify(definition),
  );
  await page.goBack();
  expect((await restored).status()).toBe(201);
  await expect(page.getByLabel('Комнат от', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Комнат до', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Площадь от, м²', { exact: true })).toHaveValue(
    '40',
  );
  await expect(page.getByLabel('Площадь до, м²', { exact: true })).toHaveValue(
    '90',
  );
  await expect(
    page.getByRole('combobox', { name: 'Сортировка', exact: true }),
  ).toHaveValue('price_asc');
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { raui48Document: string }).raui48Document,
    ),
  ).toBe('same-document');
  await page.goForward();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByLabel('Комнат до', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toBeVisible();
});
test('bounded and maximum-only room/area ranges survive submit and intentional edits in URL and API', async ({
  page,
}) => {
  for (const attributes of [
    { rooms: { min: 2, max: 3 }, area: { min: 40, max: 60 } },
    { rooms: { max: 3 }, area: { max: 60 } },
  ]) {
    await page.goto(
      '/search?' +
        new URLSearchParams({
          definition: JSON.stringify({ attributes, limit: 20 }),
        }),
    );
    await expect(
      page.getByRole('button', { name: 'Сохранить поиск', exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Комнат до', { exact: true })).toHaveValue(
      '3',
    );
    await expect(
      page.getByLabel('Площадь до, м²', { exact: true }),
    ).toHaveValue('60');
    const submitted = page.waitForResponse(
      (response) =>
        endpoint(response, 'POST', '/api/v1/search') &&
        response.request().postDataJSON().sort === 'newest',
    );
    await page.getByRole('button', { name: 'Найти', exact: true }).click();
    const response = await submitted;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON().attributes).toEqual(attributes);
    await expect
      .poll(
        () =>
          JSON.parse(new URL(page.url()).searchParams.get('definition')!)
            .attributes,
      )
      .toEqual(attributes);
  }
  await page.getByLabel('Комнат от', { exact: true }).fill('0');
  await page.getByLabel('Площадь до, м²', { exact: true }).fill('');
  const changed = page.waitForResponse(
    (response) =>
      endpoint(response, 'POST', '/api/v1/search') &&
      response.request().postDataJSON().attributes?.rooms?.min === 0,
  );
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  const response = await changed;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().attributes).toEqual({
    rooms: { min: 0, max: 3 },
  });
  await expect
    .poll(
      () =>
        JSON.parse(new URL(page.url()).searchParams.get('definition')!)
          .attributes,
    )
    .toEqual({ rooms: { min: 0, max: 3 } });
});
async function moveMap(
  page: Page,
  action: () => Promise<void>,
  accept: (bounds: Bounds) => boolean,
) {
  const pending = page.waitForResponse((response) => {
    if (!endpoint(response, 'POST', '/api/v1/search/map')) return false;
    const candidate = response.request().postDataJSON()?.bounds;
    return (
      Array.isArray(candidate) &&
      candidate.length === 4 &&
      accept(candidate as Bounds)
    );
  });
  await action();
  expect((await pending).status()).toBe(201);
  await expect.poll(() => accept(currentBounds(page))).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Сохранить поиск', exact: true }),
  ).toBeEnabled();
}
function savedResponse(response: PlaywrightResponse, after?: string) {
  return (
    endpoint(response, 'GET', '/api/v1/account/saved-searches') &&
    new URL(response.url()).searchParams.get('after') === (after ?? null)
  );
}
async function savedArticle(page: Page, id: string): Promise<Locator | null> {
  await page.goto('/account');
  await expect(
    page.getByRole('heading', { name: 'Мой аккаунт' }),
  ).toBeVisible();
  let pending = page.waitForResponse((response) => savedResponse(response));
  await page
    .getByRole('button', { name: 'Сохранённые поиски', exact: true })
    .click();
  const entries: SavedRow[] = [];
  for (let count = 0; count < 100; count++) {
    const response = await pending;
    expect(response.status()).toBe(200);
    const data = (await response.json()) as {
      items: SavedRow[];
      cursor: string | null;
    };
    entries.push(...data.items);
    const articles = page.locator('article.panel');
    await expect(articles).toHaveCount(entries.length);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index >= 0) return articles.nth(index);
    if (!data.cursor) return null;
    const after = data.cursor;
    pending = page.waitForResponse((response) =>
      savedResponse(response, after),
    );
    await page
      .getByRole('button', { name: 'Показать ещё', exact: true })
      .click();
  }
  throw new Error('Saved-search fixture pagination did not terminate');
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
test('map viewport, zoom and keyboard selection synchronize the list', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Карта', exact: true }).click();
  const map = page.locator('.leaflet-map'),
    marker = page.locator('.price-marker').first(),
    save = page.getByRole('button', { name: 'Сохранить поиск', exact: true });
  await expect(map).toBeVisible();
  await expect(marker).toBeVisible();
  await expect(save).toBeEnabled();
  await expect
    .poll(() =>
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
  const pending = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/search/selection'),
  );
  await marker.focus();
  await expect(marker).toBeFocused();
  await marker.press('Enter');
  const selection = await pending;
  expect(selection.status()).toBe(201);
  const requested = selection.request().postDataJSON() as { ids: string[] };
  expect(requested.ids.length).toBeGreaterThan(0);
  const selected = (await selection.json()) as { items: { id: string }[] };
  const ids = selected.items.map((item) => item.id).sort();
  expect(ids).toEqual([...requested.ids].sort());
  await expect
    .poll(() =>
      page
        .locator('.cards h2 a')
        .evaluateAll((nodes) =>
          nodes
            .map((node) =>
              new URL((node as HTMLAnchorElement).href).pathname.slice(
                '/listings/'.length,
              ),
            )
            .sort(),
        ),
    )
    .toEqual(ids);
  await page
    .getByRole('button', { name: 'Показать все в области', exact: true })
    .click();
  await expect(save).toBeEnabled();
  const original = currentBounds(page);
  await moveMap(
    page,
    async () => {
      await map.focus();
      await map.press('ArrowRight');
    },
    (bounds) => centerX(bounds) > centerX(original) + 0.000001,
  );
  const panned = currentBounds(page);
  await moveMap(
    page,
    async () => {
      await map.focus();
      await map.press('ArrowLeft');
    },
    (bounds) => centerX(bounds) < centerX(panned) - 0.000001,
  );
  const beforeZoom = currentBounds(page);
  await moveMap(
    page,
    () => page.getByRole('button', { name: 'Приблизить', exact: true }).click(),
    (bounds) => width(bounds) < width(beforeZoom) * 0.9,
  );
  const zoomed = currentBounds(page);
  await moveMap(
    page,
    () => page.getByRole('button', { name: 'Отдалить', exact: true }).click(),
    (bounds) => width(bounds) > width(zoomed) * 1.5,
  );
  await page.screenshot({
    path: '../../.cache/map-' + test.info().project.name + '.png',
  });
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  for (const name of ['Квартира 2 комнаты', 'Квартира 3 комнаты'])
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});
test('saved search create, rename, reopen and delete persist', async ({
  page,
}, info) => {
  await login(page);
  await page.goto('/');
  await page.getByLabel('Цена до', { exact: true }).fill('15000000');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  const pending = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/account/saved-searches'),
  );
  await page
    .getByRole('button', { name: 'Сохранить поиск', exact: true })
    .click();
  const create = await pending;
  expect(create.status()).toBe(201);
  const created = (await create.json()) as SavedRow;
  const article = await savedArticle(page, created.id);
  expect(article).not.toBeNull();
  const name = `RC ${info.project.name} ${created.id}`;
  await article!.getByLabel('Название', { exact: true }).fill(name);
  const path = '/api/v1/account/saved-searches/' + created.id;
  const renamePending = page.waitForResponse((response) =>
    endpoint(response, 'PATCH', path),
  );
  const refresh = page.waitForResponse((response) => savedResponse(response));
  await article!
    .getByRole('button', { name: 'Переименовать', exact: true })
    .click();
  const rename = await renamePending;
  expect(rename.status()).toBe(200);
  expect(await rename.json()).toMatchObject({
    id: created.id,
    name,
    definition: created.definition,
  });
  expect((await refresh).status()).toBe(200);
  const persisted = await savedArticle(page, created.id);
  expect(persisted).not.toBeNull();
  await expect(
    persisted!.getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  await persisted!
    .getByRole('link', { name: 'Открыть поиск', exact: true })
    .click();
  await expect(page.getByLabel('Цена до', { exact: true })).toHaveValue(
    '15000000',
  );
  await expect(
    page.getByRole('heading', { name: 'Квартира 2 комнаты' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Квартира 3 комнаты' }),
  ).toHaveCount(0);
  const deleting = await savedArticle(page, created.id);
  expect(deleting).not.toBeNull();
  const removePending = page.waitForResponse((response) =>
    endpoint(response, 'DELETE', path),
  );
  const removeRefresh = page.waitForResponse((response) =>
    savedResponse(response),
  );
  await deleting!
    .getByRole('button', { name: 'Удалить поиск', exact: true })
    .click();
  const removed = await removePending;
  expect(removed.status()).toBe(200);
  expect(await removed.json()).toEqual({ ok: true });
  expect((await removeRefresh).status()).toBe(200);
  expect(await savedArticle(page, created.id)).toBeNull();
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

test('Cookie session survives a fresh tab without CSRF storage and permits search and logout', async ({
  page,
  context,
}) => {
  await login(page);
  const restored = await context.newPage();
  try {
    const searchResponse = restored.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/search'),
    );
    await restored.goto('/');
    expect(
      await restored.evaluate(() => sessionStorage.getItem('raui_csrf')),
    ).toBeNull();
    expect((await searchResponse).status()).toBe(201);
    await restored.goto('/account');
    await expect(
      restored.getByRole('heading', { name: 'Мой аккаунт' }),
    ).toBeVisible();
    const logoutResponse = restored.waitForResponse((response) =>
      endpoint(response, 'POST', '/api/v1/auth/logout'),
    );
    await restored.getByRole('button', { name: 'Выйти', exact: true }).click();
    expect((await logoutResponse).status()).toBe(201);
    await expect(
      restored.getByRole('heading', { name: 'Войти в аккаунт' }),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  } finally {
    await restored.close();
  }
});

test('Password recovery reaches the API anonymously and removes invalid reset fragments', async ({
  page,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'Забыли пароль?' }).click();
  await expect(
    page.getByRole('heading', { name: 'Восстановить пароль' }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('unknown@e2e.test');
  const request = page.waitForResponse((response) =>
    endpoint(response, 'POST', '/api/v1/auth/password-reset'),
  );
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  expect((await request).status()).toBe(201);
  await expect(page.getByRole('status')).toContainText(
    'Если аккаунт с этим email существует',
  );
  await page.goto('/account/reset-password#token=invalid');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Ссылка недействительна' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/account\/reset-password$/);
  await expect(
    page.getByRole('button', { name: 'Сохранить пароль' }),
  ).toHaveCount(0);
});
