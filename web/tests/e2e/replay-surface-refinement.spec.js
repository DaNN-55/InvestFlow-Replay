import { expect, test } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';
import { startComparisonTestServer } from '../../../backend/src/test-support/comparison-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const sessions = '/api/quant/replay/sessions';

async function connect(page, fixture) {
  const writes = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET') writes.push({ method: req.method(), path: url.pathname });
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
  return writes;
}
const read = async (request, fixture, id) => (await (await request.get(`${fixture.url}${sessions}/${id}`)).json()).session;
const noOverflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('compact A-share account retains cash, holdings and T+1 while chart preferences remain usable', async ({ page, request }) => {
  const fixture = await startOrderTestServer();
  try {
    let { session } = await (await request.post(`${fixture.url}${sessions}`, { data: { interval: '1d', gameLength: 20 } })).json();
    for (const [action, body] of [['orders', { side: 'buy', quantity: 100 }], ['advance', {}]]) {
      const response = await request.post(`${fixture.url}${sessions}/${session.id}/${action}`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision, ...body } });
      expect(response.ok()).toBe(true); session = (await response.json()).session;
    }
    const original = await read(request, fixture, session.id);
    const writes = await connect(page, fixture);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    const account = page.getByRole('region', { name: '虚拟账户摘要', exact: true });
    await expect(account).toBeVisible();
    const money = value => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await expect(account.locator('.replay-account__hero')).toHaveText(`¥${money(original.valuation.totalEquity)}`);
    await expect(account.locator('dl > div').filter({ hasText: '可用现金' }).locator('dd')).toHaveText(`¥${money(original.account.cash)}`);
    await expect(account.locator('dl > div').filter({ hasText: '持仓 / 可卖' }).locator('dd')).toHaveText('100 / 0 股');
    await expect(account.locator('dl > div').filter({ hasText: 'T+1 锁定' }).locator('dd')).toHaveText('100 股');
    expect((await account.boundingBox()).height).toBeLessThan(115);
    await page.getByRole('button', { name: '周', exact: true }).click();
    await page.getByRole('button', { name: '指标计算范围', exact: true }).click();
    await expect(page.locator('.ui-tooltip__content')).toContainText('51 根 K 线');
    await page.keyboard.press('Escape');
    await page.getByLabel('选择主图指标', { exact: true }).click();
    await page.getByRole('group', { name: '主图指标', exact: true }).getByLabel('BOLL', { exact: true }).check();
    await page.getByLabel('选择主图指标', { exact: true }).click();
    await expect(page.getByLabel('选择主图指标', { exact: true })).toContainText('BOLL');
    for (const width of [1100, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      expect(await account.locator('dd').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth))).toBe(true);
    }
    const chartState = () => page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => /\/klinecharts\.js\?v=/u.test(entry.name)).name;
      const { init } = await import(url);
      const chart = init({ id: document.querySelector('[k-line-chart-id]').getAttribute('k-line-chart-id') });
      return {
        closes: chart.getDataList().map(bar => bar.close),
        macd: Boolean(chart.getIndicatorByPaneId('replay-builtin-macd', 'MACD')),
        rsi: Boolean(chart.getIndicatorByPaneId('replay-builtin-rsi', 'RSI')),
        cost: chart.getOverlayById('ashare-position-cost')?.points[0].value,
      };
    });
    const beforeReturn = await chartState();
    expect(beforeReturn.closes.length).toBeGreaterThan(0);
    expect(beforeReturn.macd).toBe(true); expect(beforeReturn.rsi).toBe(true);
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '交易追踪', exact: true }).click();
    await page.getByRole('navigation', { name: '交易追踪分类', exact: true }).getByRole('button', { name: '演练记录', exact: true }).click();
    await page.getByRole('region', { name: '历史演练列表', exact: true }).locator('.replay-history-list__item').first().click();
    await page.getByRole('button', { name: '打开演练', exact: true }).click();
    await expect(account).toBeVisible();
    await expect.poll(chartState).toEqual(beforeReturn);
    expect(await read(request, fixture, session.id)).toEqual(original);
    expect(writes).toEqual([]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('crypto toolbar keeps independent periods, price types and layouts without changing the practice', async ({ page, request }) => {
  const fixture = await startCryptoTestServer();
  try {
    const { session } = await (await request.post(`${fixture.url}${sessions}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } })).json();
    const original = await read(request, fixture, session.id), writes = await connect(page, fixture);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    await page.getByLabel('选中图周期', { exact: true }).selectOption('15');
    const tiles = page.locator('.crypto-chart-tile');
    await expect(tiles.first().locator('header')).toContainText('15min');
    await page.getByLabel('选中图价格类型', { exact: true }).selectOption('mark');
    await expect(tiles.first().locator('header')).toContainText('15min');
    await expect(tiles.first().locator('header')).toContainText('标记价格');
    await tiles.nth(1).locator('header button').click();
    await expect(page.getByLabel('选中图周期', { exact: true })).toHaveValue('5');
    await expect(page.getByLabel('选中图价格类型', { exact: true })).toHaveValue('last');
    await page.getByRole('button', { name: '图表布局与联动', exact: true }).click();
    await page.getByRole('button', { name: '单图', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(tiles).toHaveCount(1);
    await page.reload();
    await expect(tiles).toHaveCount(1);
    await expect(page.getByLabel('选中图周期', { exact: true })).toHaveValue('15');
    await expect(page.getByLabel('选中图价格类型', { exact: true })).toHaveValue('mark');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      await expect(page.getByRole('group', { name: '图表工具', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '图表布局与联动', exact: true }).click();
      const box = await page.locator('.crypto-layout-menu').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
    }
    expect(await read(request, fixture, session.id)).toEqual(original);
    expect(writes).toEqual([]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('narrow history selects a record, returns with filters and focus, and reveals score details on demand', async ({ page, request }) => {
  const fixture = await startComparisonTestServer();
  try {
    const original = await read(request, fixture, fixture.sessionIds.first), writes = await connect(page, fixture);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/decision/trade-records?tab=replay`);
    await page.getByLabel('演练市场筛选', { exact: true }).selectOption('ashare');
    await page.getByLabel('演练次数', { exact: true }).selectOption('first');
    const list = page.getByRole('region', { name: '历史演练列表', exact: true });
    await expect(list.getByText('共 2 局', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '打开演练', exact: true })).toBeHidden();
    const selected = list.locator('.replay-history-list__item').first();
    await selected.click();
    const detail = page.locator('.replay-history-records__detail');
    await expect(detail).toBeFocused();
    await expect(list).toBeHidden();
    await expect(detail.getByRole('button', { name: '打开演练', exact: true })).toBeVisible();
    const explanation = detail.locator('.replay-history-detail__score-explanation');
    await expect(explanation.locator('.replay-history-detail__algorithm')).toBeHidden();
    await explanation.locator('summary').click();
    await expect(explanation).toContainText('权重快照');
    await expect(explanation.locator('.replay-history-detail__algorithm')).toBeVisible();
    await detail.getByRole('button', { name: '首次与复练对照', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(selected).toBeFocused();
    await expect(page.getByLabel('演练市场筛选', { exact: true })).toHaveValue('ashare');
    await expect(page.getByLabel('演练次数', { exact: true })).toHaveValue('first');
    await selected.press('Enter');
    await expect(detail).toBeVisible();
    await noOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(list).toBeVisible(); await expect(detail).toBeVisible();
    expect(await read(request, fixture, fixture.sessionIds.first)).toEqual(original);
    expect(writes).toEqual([]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('direct crypto history link opens details on a narrow screen and cancelling deletion keeps the record', async ({ page, request }) => {
  const fixture = await startCryptoTestServer();
  try {
    const { session } = await (await request.post(`${fixture.url}${sessions}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } })).json();
    const original = await read(request, fixture, session.id), writes = await connect(page, fixture);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${base}/decision/trade-records?tab=replay&market=crypto-perpetual&session=${session.id}`);
    await expect(page.getByRole('button', { name: '打开演练', exact: true })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', { name: '演练记录操作', exact: true }).click();
    await page.getByRole('button', { name: '删除记录', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page.getByRole('region', { name: '历史演练列表', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: '打开演练', exact: true })).toBeVisible();
    expect(await read(request, fixture, session.id)).toEqual(original);
    expect(writes).toEqual([]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('a history refresh error leaves narrow-screen filters available for recovery', async ({ page, request }) => {
  const fixture = await startCryptoTestServer();
  try {
    const created = [];
    for (let i = 0; i < 2; i++) {
      const { session } = await (await request.post(`${fixture.url}${sessions}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } })).json();
      created.push(session);
    }
    const untouched = await read(request, fixture, created[1].id);
    await connect(page, fixture);
    let failRefresh = false;
    await page.route(/\/api\/quant\/replay\/sessions(?:\?|$)/u, route => {
      if (route.request().method() === 'GET' && failRefresh) {
        failRefresh = false;
        return route.fulfill({ status: 503, json: { error: { message: '历史列表暂时不可用' } } });
      }
      return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/decision/trade-records?tab=replay&market=crypto-perpetual&session=${created[0].id}`);
    await page.getByRole('button', { name: '演练记录操作', exact: true }).click();
    await page.getByRole('button', { name: '删除记录', exact: true }).click();
    failRefresh = true;
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('历史列表暂时不可用', { exact: true })).toBeVisible();
    await expect(page.getByLabel('演练市场筛选', { exact: true })).toBeVisible();
    await page.getByLabel('关键词', { exact: true }).fill('');
    await expect(page.getByRole('region', { name: '历史演练列表', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '历史演练列表', exact: true })).toContainText('共 1 局');
    expect(await read(request, fixture, created[1].id)).toEqual(untouched);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});
