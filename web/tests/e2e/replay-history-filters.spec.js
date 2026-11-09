import { expect, test } from '@playwright/test';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';

async function openHistory(page) {
  const queries = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/quant/replay/sessions') {
      queries.push(Object.fromEntries(url.searchParams));
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } });
    }
    await route.fulfill({ json: { items: [] } });
  });
  await page.goto(`${base}/decision/trade-records?tab=replay`);
  const filters = page.locator('.replay-history-filters');
  await expect(filters).toBeVisible();
  await expect.poll(() => queries.length).toBe(1);
  await expect(filters).toHaveAttribute('aria-busy', 'false');
  return { queries, filters };
}

test('history filter row removes duplicate headings and query button while selects apply immediately', async ({ page }) => {
  const { queries, filters } = await openHistory(page);
  await expect(filters.locator('label, [title]')).toHaveCount(0);
  await expect(filters.getByRole('button', { name: '查询', exact: true })).toHaveCount(0);
  await filters.getByLabel('演练市场筛选', { exact: true }).selectOption('ashare');
  await expect.poll(() => queries.length).toBe(2);
  expect(queries.at(-1).market).toBe('ashare');
  await filters.getByLabel('状态筛选', { exact: true }).selectOption('active');
  await expect.poll(() => queries.length).toBe(3);
  expect(queries.at(-1).state).toBe('active');
  await filters.getByLabel('演练次数', { exact: true }).selectOption('first');
  await expect.poll(() => queries.length).toBe(4);
  expect(queries.at(-1)).toMatchObject({ market: 'ashare', state: 'active', attemptKind: 'first' });
  await filters.screenshot({ path: test.info().outputPath('history-filters-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await filters.screenshot({ path: test.info().outputPath('history-filters-mobile.png') });
});

test('history keyword pauses debounce, Enter applies once, and clear remains usable', async ({ page }) => {
  const { queries, filters } = await openHistory(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const keyword = filters.getByLabel('关键词', { exact: true });
  await keyword.fill('短');
  await page.clock.fastForward(250);
  expect(queries).toHaveLength(1);
  await keyword.fill('完整关键词');
  await page.clock.fastForward(299);
  expect(queries).toHaveLength(1);
  await page.clock.fastForward(1);
  await expect.poll(() => queries.length).toBe(2);
  expect(queries.at(-1).keyword).toBe('完整关键词');
  await keyword.fill('立即查询');
  await keyword.press('Enter');
  await expect.poll(() => queries.length).toBe(3);
  expect(queries.at(-1).keyword).toBe('立即查询');
  await page.clock.fastForward(1000);
  expect(queries).toHaveLength(3);
  await expect(filters).toHaveAttribute('aria-busy', 'false');
  await keyword.press('Enter');
  await expect.poll(() => queries.length).toBe(4);
  await page.clock.fastForward(1000);
  expect(queries).toHaveLength(4);
  await keyword.fill('');
  await page.clock.fastForward(300);
  await expect.poll(() => queries.length).toBe(5);
  expect(queries.at(-1)).not.toHaveProperty('keyword');
});

test('history filters accept changes while loading and ignore older responses', async ({ page }) => {
  const { filters } = await openHistory(page);
  const pending = [];
  await page.route(/\/api\/quant\/replay\/sessions(?:\?|$)/u, route => {
    pending.push({ route, query: Object.fromEntries(new URL(route.request().url()).searchParams) });
  });
  await filters.getByLabel('演练市场筛选', { exact: true }).selectOption('ashare');
  await expect.poll(() => pending.length).toBe(1);
  await expect(filters).toHaveAttribute('aria-busy', 'true');
  await filters.getByLabel('状态筛选', { exact: true }).selectOption('active');
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[1].query).toMatchObject({ market: 'ashare', state: 'active' });
  await pending[1].route.fulfill({ json: { items: [], total: 7, page: 1, pageSize: 10 } });
  await expect(filters).toHaveAttribute('aria-busy', 'false');
  const list = page.getByRole('region', { name: '历史演练列表', exact: true });
  await expect(list.getByText('共 7 局', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(pending[0].route.request().url());
  await pending[0].route.fulfill({ json: { items: [], total: 99, page: 1, pageSize: 10 } });
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(list.getByText('共 7 局', { exact: true })).toBeVisible();
  await expect(list.getByText('共 99 局', { exact: true })).toHaveCount(0);
  await expect(filters.getByLabel('状态筛选', { exact: true })).toHaveValue('active');
});

test('history keyword waits for Chinese composition and cancels pending work when leaving records', async ({ page }) => {
  const { queries, filters } = await openHistory(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const keyword = filters.getByLabel('关键词', { exact: true });
  await keyword.dispatchEvent('compositionstart');
  await keyword.fill('正在输入');
  await page.clock.fastForward(500);
  expect(queries).toHaveLength(1);
  await keyword.dispatchEvent('compositionend');
  await page.clock.fastForward(300);
  await expect.poll(() => queries.length).toBe(2);
  expect(queries.at(-1).keyword).toBe('正在输入');
  await keyword.fill('退出后不应查询');
  await page.getByRole('navigation', { name: '交易追踪分类' }).getByRole('button', { name: '实盘与模拟', exact: true }).click();
  await page.clock.fastForward(1000);
  expect(queries).toHaveLength(2);
});
