import { expect, test } from '@playwright/test';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';
import { mkdirSync } from 'node:fs';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const path = '/api/quant/replay/sessions';
let fixture;
test.beforeAll(async () => { fixture = await startCryptoTestServer(); });
test.afterAll(async () => { await fixture?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function openPractice(page, request, actionFailure = null, instrumentId = 'BTC-USDT-SWAP') {
  const response = await request.post(`${fixture.url}${path}`, { data: { market: 'crypto-perpetual', instrumentId, actionId: crypto.randomUUID() } });
  const { session } = await response.json();
  const calls = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith(path) && !url.pathname.endsWith('/crypto-pool')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/actions') && req.method() === 'POST') {
      calls.push(req.postDataJSON());
      if (actionFailure && await actionFailure(route, req)) return;
    }
    const result = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
    await route.fulfill({ response: result });
  });
  await page.addInitScript(() => localStorage.setItem('investflow-replay-theme', 'light'));
  await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  return { session, calls };
}

async function prepareOrder(page) {
  await page.getByRole('button', { name: '卖出 / 做空', exact: true }).first().click();
  await page.getByLabel('数量单位', { exact: true }).selectOption('quote');
  await page.getByLabel('委托张数', { exact: true }).fill('5000');
  await page.locator('.order-advanced > summary').click();
  await page.getByLabel('自动止损价', { exact: true }).fill('65373.62');
  await page.getByLabel('自动止盈价', { exact: true }).fill('64003.78');
}

test('USDT order validates both protective prices before writing and keeps the reminder visible when scrolling', async ({ page, request }) => {
  const { session, calls } = await openPractice(page, request);
  await prepareOrder(page);
  await page.getByRole('button', { name: '卖出 / 做空', exact: true }).last().click();
  expect(calls).toHaveLength(0);
  const alert = page.getByTestId('crypto-persistent-alert');
  await expect(alert).toContainText('止损价');
  await expect(alert).toContainText('止盈价');
  await expect(alert).toContainText('0.1 USDT');
  await page.clock.install();
  await page.clock.fastForward(60_000);
  await expect(alert).toBeVisible();
  expect(calls).toHaveLength(0);
  await expect(page.getByLabel('自动止损价', { exact: true })).toHaveValue('65373.62');
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  for (const width of [1864, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bounds = await alert.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(850);
    if (process.env.ALERT_EVIDENCE_DIR) {
      mkdirSync(process.env.ALERT_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.ALERT_EVIDENCE_DIR}/alert-${width}.png`, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  if (process.env.ALERT_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ALERT_EVIDENCE_DIR}/alert-dark.png`, animations: 'disabled' });
  await page.getByLabel('自动止损价', { exact: true }).fill('65373.6');
  await page.getByLabel('自动止盈价', { exact: true }).fill('64003.8');
  await expect(alert).toHaveCount(0);
  await page.getByRole('button', { name: '卖出 / 做空', exact: true }).last().click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  expect(calls[0].command.contracts).toBe('10');
  expect(calls[0].command.protection).toEqual({ stopLoss: { price: '65373.6', reference: 'last' }, takeProfit: { price: '64003.8', reference: 'last' } });
  const final = await (await request.get(`${fixture.url}${path}/${session.id}`)).json();
  expect(final.session.revision).toBe(1);
});

test('a rejected server action has one persistent explanation and resync only reads data', async ({ page, request }) => {
  const { session, calls } = await openPractice(page, request, async route => {
    await route.fulfill({ status: 409, json: { error: { code: 'REPLAY_REVISION_CONFLICT', message: '会话已变化，请重新同步' } } });
    return true;
  });
  await page.getByLabel('委托张数', { exact: true }).fill('1');
  await page.getByRole('button', { name: '买入 / 做多', exact: true }).last().click();
  const alert = page.getByTestId('crypto-persistent-alert');
  await expect(alert).toContainText('需要重新同步');
  await expect(alert).toContainText('不会重复提交订单');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByRole('button', { name: '重新同步', exact: true })).toBeInViewport();
  if (process.env.ALERT_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ALERT_EVIDENCE_DIR}/sync-alert.png` });
  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(alert).toHaveCount(0);
  expect(calls).toHaveLength(1);
  await expect(page.getByLabel('委托张数', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  expect((await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session.revision).toBe(0);
});

test('normal in-flight reads and writes do not flash recovery warnings', async ({ page, request }) => {
  await openPractice(page, request);
  for (const endpoint of ['market?**', 'actions']) {
    let release, started = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/${endpoint}`, async route => {
      started = true;
      await gate;
      await route.fallback();
    }, { times: 1 });
    try {
      if (endpoint === 'market?**') await page.getByRole('combobox', { name: '选中图周期', exact: true }).selectOption('15');
      else {
        await page.getByLabel('委托张数', { exact: true }).fill('1');
        await page.getByRole('button', { name: '买入 / 做多', exact: true }).last().click();
      }
      await expect.poll(() => started).toBe(true);
      await expect(page.getByTestId('crypto-persistent-alert')).toHaveCount(0);
    } finally { release(); }
    await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  }
});

for (const [instrument, invalid, valid, tick] of [['BTC-USDT-SWAP', '49000.03', '49000.0', '0.1'], ['ETH-USDT-SWAP', '49000.003', '49000.01', '0.01']]) {
  test(`${instrument} validates limit prices using its frozen contract precision`, async ({ page, request }) => {
    const { calls } = await openPractice(page, request, null, instrument);
    await page.getByRole('button', { name: '限价', exact: true }).click();
    await page.getByLabel('委托张数', { exact: true }).fill('1');
    await page.getByLabel('委托限价', { exact: true }).fill(invalid);
    await page.getByLabel('委托限价', { exact: true }).press('Tab');
    const alert = page.getByTestId('crypto-persistent-alert');
    await expect(alert).toContainText(`按 ${tick} USDT 递增`);
    await expect(page.getByLabel('委托限价', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
    await page.getByLabel('委托限价', { exact: true }).fill(valid);
    await expect(alert).toHaveCount(0);
    await page.getByRole('button', { name: '买入 / 做多', exact: true }).last().click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].command.limitPrice).toBe(valid);
    await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  });
}

test('a lost committed response keeps the original request and reminder until the exact retry succeeds', async ({ page, request }) => {
  let lose = true;
  const { session, calls } = await openPractice(page, request, async (route, req) => {
    if (!lose) return false;
    lose = false;
    const result = await route.fetch({ url: `${fixture.url}${new URL(req.url()).pathname}` });
    expect(result.status()).toBe(200);
    await route.abort();
    return true;
  });
  await page.getByLabel('委托张数', { exact: true }).fill('1');
  await page.getByRole('button', { name: '买入 / 做多', exact: true }).last().click();
  const alert = page.getByTestId('crypto-persistent-alert');
  await expect(alert).toContainText('上次操作结果尚未确认');
  await expect(page.getByRole('button', { name: '重新同步', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByRole('button', { name: '重试原动作', exact: true })).toBeInViewport();
  await page.getByRole('link', { name: '交易追踪', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await page.getByRole('link', { name: '合约盲测', exact: true }).click();
  await expect(alert).toBeVisible();
  await page.getByRole('button', { name: '重试原动作', exact: true }).click();
  await expect(alert).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect((await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session.revision).toBe(1);
});
