import { expect, test } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const path = '/api/quant/replay/sessions';

async function connect(page, fixture) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
}

test('A-share finish, freeze, reveal and review stay in one panel and preserve the originals', async ({ page, request }) => {
  const fixture = await startOrderTestServer();
  try {
    await connect(page, fixture);
    const created = await request.post(`${fixture.url}${path}`, { data: { interval: '1d', gameLength: 20 } });
    const { session } = await created.json();
    const read = async () => (await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session;
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    await page.getByRole('button', { name: '结束本局', exact: true }).click();
    await page.getByRole('button', { name: '确认结束', exact: true }).click();
    const review = page.getByRole('dialog', { name: '本次复盘', exact: true });
    await expect(review).toBeVisible();
    await review.getByRole('checkbox', { name: '回踩', exact: true }).check();
    await review.getByPlaceholder('你看到了什么，为什么做出这个判断？').fill('回踩支撑等待确认');
    await review.getByPlaceholder('计划如何开仓、持有、减仓或空仓？').fill('条件未到保持空仓');
    await review.getByPlaceholder('什么情况说明判断错误，如何控制损失？').fill('跌破支撑控制损失');
    await review.getByRole('button', { name: '保存并冻结整局盲评', exact: true }).click();
    const frozen = structuredClone((await read()).review.blindReview);
    const reveal = review.getByRole('button', { name: '揭晓行情', exact: true });
    await expect(reveal).toBeVisible();
    await page.route(`**${path}/${session.id}/reveal`, async route => {
      await route.fulfill({ status: 503, json: { error: { message: '暂时无法揭晓，请重试' } } });
    }, { times: 1 });
    await reveal.click();
    await expect(review.getByText('暂时无法揭晓，请重试', { exact: true })).toBeVisible();
    expect((await read()).revealed).toBe(false);
    await reveal.click();
    const oldBlind = review.locator('details.replay-review__frozen').first();
    await expect(oldBlind).not.toHaveAttribute('open', '');
    await expect(review.getByRole('button', { name: '追加盲评修正', exact: true })).toBeHidden();
    await expect(review.getByRole('heading', { name: '揭晓后复盘', exact: true })).toBeFocused();
    await oldBlind.locator('summary').click();
    await expect(oldBlind).toContainText(frozen.thesis);
    await oldBlind.locator('summary').click();
    await review.getByPlaceholder('实际执行和原计划有哪些一致或偏离？').fill('保持空仓符合原定计划');
    await review.getByPlaceholder('没有明显错误时可填写“无”').fill('无');
    await review.getByPlaceholder('下一次遇到类似行情，你会保留或改变什么？').fill('继续等待明确确认信号');
    await review.getByRole('button', { name: '提交复盘并评分', exact: true }).click();
    await expect(review.getByText('本局评分', { exact: true })).toBeVisible();
    const saved = await read();
    expect(saved.review.blindReview).toEqual(frozen);
    await expect(review.locator('details.replay-review__frozen').nth(1)).not.toHaveAttribute('open', '');
    await page.reload();
    await page.getByRole('button', { name: '查看复盘', exact: true }).click();
    await expect(review).toBeVisible();
    const restored = await read();
    expect(restored.review).toEqual(saved.review);
    expect(restored.scoreCard).toEqual(saved.scoreCard);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('A-share natural completion opens the next stage without another entry click', async ({ page, request }) => {
  const fixture = await startOrderTestServer();
  try {
    await connect(page, fixture);
    let { session } = await (await request.post(`${fixture.url}${path}`, { data: { interval: '1d', gameLength: 20 } })).json();
    for (let i = 0; i < 19; i++) {
      const response = await request.post(`${fixture.url}${path}/${session.id}/advance`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision } });
      expect(response.ok()).toBe(true);
      session = (await response.json()).session;
    }
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    await page.getByRole('button', { name: '空仓观望，推进一天', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '本次复盘', exact: true })).toBeVisible();
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

for (const width of [1440, 390]) {
  test(`crypto ending presents the next stage at ${width}px and keeps its chart`, async ({ page, request }) => {
    const fixture = await startCryptoTestServer();
    try {
      await page.setViewportSize({ width, height: 900 });
      await connect(page, fixture);
      const { session } = await (await request.post(`${fixture.url}${path}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } })).json();
      const read = async () => (await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session;
      await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
      const chart = await page.locator('.crypto-chart-tile').first().elementHandle();
      await page.getByRole('button', { name: '结束练习', exact: true }).click();
      await page.getByRole('button', { name: '结束并进入盲评', exact: true }).click();
      const review = page.getByRole('region', { name: '合约复盘', exact: true });
      await expect(review.getByLabel('盲评判断', { exact: true })).toBeVisible();
      const box = await review.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeLessThan(500);
      expect(await chart.evaluate(el => el.isConnected)).toBe(true);
      await expect(page.getByRole('heading', { name: '下单', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /[展开收起]+下单面板/u })).toHaveCount(0);
      await review.getByLabel('盲评判断', { exact: true }).fill('等待回踩确认行情方向');
      await review.getByLabel('盲评交易计划', { exact: true }).fill('未满足条件所以保持空仓');
      await review.getByRole('button', { name: '保存盲评', exact: true }).click();
      const frozen = structuredClone((await read()).blindReview);
      await review.getByRole('button', { name: '揭晓完整行情', exact: true }).click();
      await expect(review.getByLabel('复盘观察', { exact: true })).toBeVisible();
      await expect(review.getByLabel('复盘观察', { exact: true })).toBeFocused();
      await review.getByLabel('复盘观察', { exact: true }).fill('行情方向尚未得到充分验证');
      await review.getByLabel('执行偏差', { exact: true }).fill('空仓等待符合本次计划');
      await review.getByLabel('下次行动', { exact: true }).fill('继续等待确认后再考虑开仓');
      await review.getByRole('button', { name: '保存事后复盘', exact: true }).click();
      await expect(review.getByRole('button', { name: '按原版本复练', exact: true })).toBeVisible();
      expect((await read()).blindReview).toEqual(frozen);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`crypto-reviewed-${width}.png`), fullPage: true });
    } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
  });
}
