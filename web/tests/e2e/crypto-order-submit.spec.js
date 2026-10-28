import { expect, test } from '@playwright/test';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const path = '/api/quant/replay/sessions';
let fixture;
test.beforeAll(async () => { fixture = await startCryptoTestServer(); });
test.afterAll(async () => { await fixture?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function practice(page, request, fault) {
  const created = await request.post(`${fixture.url}${path}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
  const { session } = await created.json(), commands = [], advances = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith(path) && !url.pathname.endsWith('/crypto-pool')) return route.fulfill({ json: {} });
    if (req.method() === 'POST') {
      if (url.pathname.endsWith('/actions')) commands.push(req.postDataJSON());
      if (url.pathname.endsWith('/advance')) advances.push(req.postDataJSON());
    }
    if (fault && await fault(route, req, url)) return;
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('investflow-replay-theme', 'light');
    localStorage.setItem('investflow-crypto-workspace-v1', JSON.stringify({ layout: 'dual', periods: [1, 1, 1, 1], kinds: ['mark', 'last', 'last', 'last'] }));
  });
  await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  return { session, commands, advances, read: async () => (await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session };
}

async function ticket(page, side = 'long', limit = false) {
  const panel = page.locator('.crypto-trading'), name = side === 'long' ? '买入 / 做多' : '卖出 / 做空';
  await panel.getByRole('button', { name, exact: true }).first().click();
  if (limit) {
    await panel.getByRole('button', { name: '限价', exact: true }).click();
    await panel.getByLabel('委托限价', { exact: true }).fill('48000');
  }
  await panel.getByLabel('委托张数', { exact: true }).fill('1');
  await panel.locator('.order-advanced > summary').click();
  await panel.getByLabel('自动止损价', { exact: true }).fill(side === 'long' ? '49000' : '51000');
  await panel.getByLabel('自动止盈价', { exact: true }).fill(side === 'long' ? '51000' : '49000');
  await panel.getByLabel('操作理由', { exact: true }).fill('只提交这一笔');
  const button = panel.getByRole('button', { name, exact: true }).last();
  await expect(button).toBeEnabled();
  return { panel, button };
}

async function cleared(panel) {
  for (const label of ['委托张数', '自动止损价', '自动止盈价', '操作理由']) await expect(panel.getByLabel(label, { exact: true })).toHaveValue('');
}

async function chartState(page) {
  return page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').find(entry => /\/klinecharts\.js\?v=/.test(entry.name)).name;
    const { init } = await import(moduleUrl);
    return [...document.querySelectorAll('.crypto-chart-tile')].map(tile => {
      const chart = init({ id: tile.querySelector('[k-line-chart-id]').getAttribute('k-line-chart-id') });
      return { latestMinute: chart.getDataList().at(-1).endSequence, visibleTo: chart.getVisibleRange().to, count: chart.getDataList().length,
        lines: [...tile.querySelectorAll('[data-price-line-id]')].map(node => {
          const overlay = chart.getOverlayById(node.dataset.priceLineId);
          return { id: node.dataset.priceLineId, price: overlay?.points[0]?.value, label: overlay?.extendData?.compactLabel ?? overlay?.extendData?.label };
        }) };
    });
  });
}

for (const side of ['long', 'short']) test(`${side} submission matches in the next minute, shows both protections on mark charts and clears the ticket`, async ({ page, request }) => {
  const c = await practice(page, request), { panel, button } = await ticket(page, side);
  const bounds = await page.locator('[data-chart-index="0"] [k-line-chart-id]').boundingBox();
  await page.mouse.move(bounds.x + 80, bounds.y + 150); await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 150, { steps: 6 }); await page.mouse.up();
  await button.evaluate(node => { node.click(); node.click(); });
  await expect.poll(async () => (await c.read()).elapsedMinutes).toBe(1);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  const state = await c.read();
  expect(state.account.position.side).toBe(side);
  expect(state.revision).toBe(2);
  expect(c.commands).toHaveLength(1); expect(c.advances).toHaveLength(1);
  expect(c.advances[0].minutes).toBe(1);
  await cleared(panel);
  await expect(button).toBeDisabled();
  for (const leg of ['stopLoss', 'takeProfit']) await expect(page.locator(`[data-chart-index="0"] [data-price-line-id="${c.session.id}:${leg}"]`)).toHaveCount(1);
  for (const chart of await chartState(page)) {
    expect(chart.latestMinute).toBe(0); expect(chart.visibleTo).toBeGreaterThanOrEqual(chart.count - 1);
    for (const leg of ['stopLoss', 'takeProfit']) {
      const line = chart.lines.find(item => item.id === `${c.session.id}:${leg}`);
      expect(line.price).toBe(Number(state.protection[leg].price)); expect(line.label).toContain('最新价触发');
    }
  }
  if (process.env.ORDER_EVIDENCE_DIR) {
    await page.setViewportSize({ width: 1864, height: 1050 }); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.ORDER_EVIDENCE_DIR}/${side}-filled.png`, animations: 'disabled' });
  }
});

test('an unfilled limit order advances once and retains visible pending protective lines after clearing inputs', async ({ page, request }) => {
  const c = await practice(page, request), { panel, button } = await ticket(page, 'long', true);
  await button.click();
  await expect.poll(async () => (await c.read()).elapsedMinutes).toBe(1);
  await cleared(panel); await expect(panel.getByLabel('委托限价', { exact: true })).toHaveValue('');
  const state = await c.read(); expect(state.account.position).toBe(null); expect(state.orders).toHaveLength(1);
  for (const leg of ['stopLoss', 'takeProfit']) await expect(page.locator(`[data-chart-index="0"] [data-price-line-id="${c.session.id}:order-${state.orders[0].id}-${leg}"]`)).toHaveCount(1);
  expect(c.commands).toHaveLength(1); expect(c.advances).toHaveLength(1);
});

for (const lost of ['actions', 'advance']) test(`losing the ${lost} response retries only that original request and never adds another minute`, async ({ page, request }) => {
  let lose = true;
  const c = await practice(page, request, async (route, req, url) => {
    if (!lose || req.method() !== 'POST' || !url.pathname.endsWith(`/${lost}`)) return false;
    lose = false;
    const result = await route.fetch({ url: `${fixture.url}${url.pathname}` }); expect(result.status()).toBe(200);
    await route.abort(); return true;
  });
  const { panel, button } = await ticket(page);
  await button.click();
  await expect(page.getByRole('button', { name: '重试原动作', exact: true })).toBeVisible();
  if (lost === 'advance') { await cleared(panel); await page.reload(); }
  else await expect(panel.getByLabel('委托张数', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: '重试原动作', exact: true }).click();
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  await cleared(panel);
  const state = await c.read(); expect(state.elapsedMinutes).toBe(1); expect(state.revision).toBe(2);
  expect(c.commands).toHaveLength(lost === 'actions' ? 2 : 1); expect(c.advances).toHaveLength(lost === 'advance' ? 2 : 1);
  const repeated = lost === 'actions' ? c.commands : c.advances; expect(repeated[1]).toEqual(repeated[0]);
});

test('a rejected order preserves all fields and never advances', async ({ page, request }) => {
  const c = await practice(page, request, async (route, req, url) => {
    if (req.method() !== 'POST' || !url.pathname.endsWith('/actions')) return false;
    await route.fulfill({ status: 409, json: { error: { message: '会话版本已变化' } } }); return true;
  });
  const { panel, button } = await ticket(page);
  await button.click(); await expect(page.getByTestId('crypto-persistent-alert')).toBeVisible();
  await expect(panel.getByLabel('委托张数', { exact: true })).toHaveValue('1');
  await expect(panel.getByLabel('自动止损价', { exact: true })).toHaveValue('49000');
  expect((await c.read()).elapsedMinutes).toBe(0); expect(c.advances).toHaveLength(0);
});

test('a confirmed order clears a budget ticket while retaining its input mode', async ({ page, request }) => {
  const c = await practice(page, request), { panel, button } = await ticket(page);
  await panel.getByLabel('仓位输入方式', { exact: true }).selectOption('margin');
  await panel.getByLabel('保证金预算', { exact: true }).fill('100');
  await button.click();
  await expect.poll(async () => (await c.read()).elapsedMinutes).toBe(1);
  await expect(panel.getByLabel('保证金预算', { exact: true })).toHaveValue('');
  for (const label of ['自动止损价', '自动止盈价', '操作理由']) await expect(panel.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('仓位输入方式', { exact: true })).toHaveValue('margin');
  await panel.getByLabel('仓位输入方式', { exact: true }).selectOption('contracts');
  await expect(panel.getByLabel('委托张数', { exact: true })).toHaveValue('');
  expect(c.commands).toHaveLength(1);
});

test('a failed read after both commits keeps the ticket empty and resync never writes again', async ({ page, request }) => {
  let failRead = false;
  const c = await practice(page, request, async (route, req, url) => {
    if (req.method() === 'POST' && url.pathname.endsWith('/advance')) failRead = true;
    if (failRead && req.method() === 'GET' && /^\/api\/quant\/replay\/sessions\/[^/]+$/.test(url.pathname)) {
      failRead = false; await route.abort(); return true;
    }
    return false;
  });
  const { panel, button } = await ticket(page);
  await button.click(); await expect(page.getByTestId('crypto-read-stale')).toBeVisible(); await cleared(panel);
  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  expect((await c.read()).elapsedMinutes).toBe(1); expect(c.commands).toHaveLength(1); expect(c.advances).toHaveLength(1);
});

test('a rejected automatic advance keeps the accepted order clear and does not replay it during resync', async ({ page, request }) => {
  const c = await practice(page, request, async (route, req, url) => {
    if (req.method() !== 'POST' || !url.pathname.endsWith('/advance')) return false;
    await route.fulfill({ status: 409, json: { error: { message: '推进版本冲突' } } }); return true;
  });
  const { panel, button } = await ticket(page);
  await button.click(); await expect(page.getByTestId('crypto-persistent-alert')).toContainText('委托已提交'); await cleared(panel);
  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  const state = await c.read(); expect(state.elapsedMinutes).toBe(0); expect(state.orders).toHaveLength(1);
  expect(c.commands).toHaveLength(1); expect(c.advances).toHaveLength(1);
});

test('keys 1, 2 and 3 advance 1, 5 and 15 minutes and ignore input, modal, repeats and other pages', async ({ page, request }) => {
  const c = await practice(page, request);
  for (const [key, minutes, elapsed] of [['1', 1, 1], ['2', 5, 6], ['3', 15, 21]]) {
    const button = page.getByRole('button', { name: `推进 ${minutes} 分钟`, exact: true });
    await expect(button).toHaveAttribute('aria-keyshortcuts', key);
    await expect(button).toHaveAttribute('title', `快捷键 ${key}`);
    await expect(button).toHaveText(`推进 ${minutes} 分钟`);
    await page.locator('.crypto-header h1').click(); await page.keyboard.press(key);
    await expect.poll(async () => (await c.read()).elapsedMinutes).toBe(elapsed);
    await expect(button).toBeEnabled();
  }
  expect(c.advances.map(body => body.minutes)).toEqual([1, 5, 15]);
  await page.getByLabel('委托张数', { exact: true }).fill('1'); await page.keyboard.press('2');
  await page.getByRole('button', { name: '交易与显示设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '交易与显示设置', exact: true })).toBeVisible();
  await page.keyboard.press('3'); await page.keyboard.press('Escape');
  await page.locator('.crypto-header h1').click();
  await page.keyboard.down('1'); await expect.poll(async () => (await c.read()).elapsedMinutes).toBe(22);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  await page.keyboard.down('1'); await page.keyboard.up('1');
  await page.getByRole('link', { name: '交易追踪', exact: true }).click();
  await expect(page).toHaveURL(/\/decision\/trade-records/); await expect(page.locator('.crypto-workspace')).toHaveCount(0);
  await page.keyboard.press('3');
  expect(c.advances.map(body => body.minutes)).toEqual([1, 5, 15, 1]);
});

test('advance shortcuts cannot queue extra requests while busy or when a result is pending', async ({ page, request }) => {
  let release, started = false;
  const gate = new Promise(resolve => { release = resolve; });
  const c = await practice(page, request, async (route, req, url) => {
    if (req.method() !== 'POST' || !url.pathname.endsWith('/advance')) return false;
    started = true; await gate; await route.abort(); return true;
  });
  try {
    await page.locator('.crypto-header h1').click(); await page.keyboard.press('1');
    await expect.poll(() => started).toBe(true); await page.keyboard.press('2'); await page.keyboard.press('3');
    expect(c.advances).toHaveLength(1);
  } finally { release(); }
  await expect(page.getByRole('button', { name: '重试原动作', exact: true })).toBeVisible();
  await page.keyboard.press('2'); await page.keyboard.press('3');
  expect(c.advances).toHaveLength(1); expect((await c.read()).elapsedMinutes).toBe(0);
});

test('long stays bold red and short stays bold green when selected or unselected in both themes', async ({ page, request }) => {
  await practice(page, request);
  const directions = page.getByRole('group', { name: '交易方向' }).or(page.locator('.order-directions'));
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '切换主题', exact: true }).click();
    for (const name of ['买入 / 做多', '卖出 / 做空']) {
      await directions.getByRole('button', { name, exact: true }).click();
      const styles = await directions.locator('button').evaluateAll(nodes => nodes.slice(0, 2).map(node => ({ color: getComputedStyle(node).color, weight: getComputedStyle(node).fontWeight })));
      const red = styles[0].color.match(/\d+/g).map(Number), green = styles[1].color.match(/\d+/g).map(Number);
      expect(red[0]).toBeGreaterThan(red[1]); expect(green[1]).toBeGreaterThan(green[0]);
      expect(styles.every(style => Number(style.weight) >= 700)).toBe(true);
    }
  }
  if (process.env.ORDER_EVIDENCE_DIR) {
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(page.getByRole('button', { name: '推进 15 分钟', exact: true })).toHaveText('推进 15 分钟');
    await page.locator('.crypto-playback').screenshot({ path: `${process.env.ORDER_EVIDENCE_DIR}/shortcuts-390.png` });
    await page.locator('.crypto-trading').screenshot({ path: `${process.env.ORDER_EVIDENCE_DIR}/direction-colors-390.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  }
});
