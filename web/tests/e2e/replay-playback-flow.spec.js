import { expect, test } from '@playwright/test';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const sessions = '/api/quant/replay/sessions';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const leave of [false, true]) test(`crypto in-flight playback ${leave ? 'stays paused after leaving and returning' : 'drains before allowing restart'}`, async ({ page, request }) => {
  const fixture = await startCryptoTestServer(), entered = deferred(), release = deferred(), advances = [];
  try {
    const created = await request.post(`${fixture.url}${sessions}`, { data: { market: 'crypto-perpetual', actionId: crypto.randomUUID(), instrumentId: 'BTC-USDT-SWAP' } });
    expect(created.status()).toBe(201); const { session } = await created.json();
    const sessionPath = `${sessions}/${session.id}`;
    const read = async () => (await (await request.get(`${fixture.url}${sessionPath}`)).json()).session;
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'POST' && url.pathname.endsWith('/advance')) {
        advances.push(req.postDataJSON());
        if (advances.length === 1) { entered.resolve(); await release.promise; }
      }
      await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
    });
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    const panel = page.getByRole('region', { name: '回放控制', exact: true });
    const play = panel.getByRole('button', { name: '自动回放', exact: true });
    await expect(play).toBeEnabled();
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await play.click(); await page.clock.runFor(900); await entered.promise;
    await panel.getByRole('combobox', { name: '自动回放倍率' }).selectOption('4');
    if (leave) {
      await page.getByRole('link', { name: '交易追踪', exact: true }).click();
      await expect(page).toHaveURL(/\/decision\/trade-records/);
    } else {
      await panel.getByRole('button', { name: '暂停回放', exact: true }).click();
      await expect(play).toBeDisabled();
    }
    release.resolve();
    await expect.poll(async () => (await read()).elapsedMinutes).toBe(1);
    if (leave) await page.goBack();
    await expect(play).toBeEnabled();
    await page.clock.runFor(5000); expect(advances).toHaveLength(1);
    expect((await read()).elapsedMinutes).toBe(1);
    if (!leave) {
      await play.click(); await page.clock.runFor(224); expect(advances).toHaveLength(1);
      await page.clock.runFor(1); await expect.poll(() => advances.length).toBe(2);
      await panel.getByRole('button', { name: '暂停回放', exact: true }).click();
      await expect(play).toBeEnabled();
      expect((await read()).elapsedMinutes).toBe(2);
      await panel.screenshot({ path: test.info().outputPath('crypto-playback-desktop.png') });
      await page.setViewportSize({ width: 390, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await panel.screenshot({ path: test.info().outputPath('crypto-playback-mobile.png') });
    }
    expect(advances.every(body => body.minutes === 1)).toBe(true);
    expect(advances.map(body => body.expectedRevision)).toEqual(advances.map((_body, i) => session.revision + i));
    expect(new Set(advances.map(body => body.actionId)).size).toBe(advances.length);
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('ashare autoplay continues while a limit order rests, then pauses on its real partial fill', async ({ page, request }) => {
  const fixture = await startOrderTestServer(), advances = [];
  try {
    const created = await request.post(`${fixture.url}${sessions}`, { data: { interval: 'hybrid', gameLength: 20 } });
    expect(created.status()).toBe(201); let { session } = await created.json();
    const sessionPath = `${sessions}/${session.id}`;
    const submitted = await request.post(`${fixture.url}${sessionPath}/orders`, { data: {
      actionId: crypto.randomUUID(), expectedRevision: session.revision, side: 'buy', orderType: 'limit', limitPrice: 10, quantity: 5000,
      decision: { reasonTags: ['回踩'], confidence: 3, thesis: '等待价格回踩', plan: '限价成交后持有', riskPlan: '跌破防线时退出', stopLossPrice: 9.8, invalidationRule: null },
    } });
    expect(submitted.status()).toBe(201); session = (await submitted.json()).session;
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const response = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
      if (url.pathname.endsWith('/advance')) advances.push({ body: req.postDataJSON(), response: await response.json() });
      await route.fulfill({ response });
    });
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    const panel = page.getByRole('region', { name: '回放控制', exact: true });
    await expect(panel.getByRole('button', { name: '自动播放', exact: true })).toBeEnabled();
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await panel.getByRole('button', { name: '自动播放', exact: true }).click();
    await page.clock.runFor(1100); await expect.poll(() => advances.length).toBe(1);
    await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    expect(advances[0].response.session.executions).toHaveLength(0);
    expect(advances[0].response.session.pendingOrders).toHaveLength(1);
    await page.clock.runFor(1100); await expect.poll(() => advances.length).toBe(2);
    await expect(panel.getByRole('button', { name: '自动播放', exact: true })).toBeVisible();
    await expect(panel.getByRole('status')).toHaveText('委托已有成交或状态变化，自动播放已暂停，请查看交易台。');
    const latest = advances[1].response.session;
    expect(latest.account.positionQuantity).toBe(1000);
    expect(latest.pendingOrders).toHaveLength(2);
    expect(latest.pendingOrders.find(order => order.side === 'buy')).toMatchObject({ status: 'partially_filled', remainingQuantity: 4000 });
    expect(latest.pendingOrders.find(order => order.orderType === 'stop')).toMatchObject({ stopPrice: 9.8, remainingQuantity: 1000, status: 'pending' });
    await page.clock.runFor(5000); expect(advances).toHaveLength(2);
    expect(advances.map(row => row.body.mode)).toEqual(['minute', 'minute']);
    expect(advances.map(row => row.body.expectedRevision)).toEqual([session.revision, session.revision + 1]);
    expect((await (await request.get(`${fixture.url}${sessionPath}`)).json()).session).toEqual(latest);
    await panel.screenshot({ path: test.info().outputPath('ashare-playback-desktop.png') });
    await page.setViewportSize({ width: 390, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.screenshot({ path: test.info().outputPath('ashare-playback-mobile.png') });
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});
