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
const read = async (request, fixture, id) => (await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
async function fillOrder(panel) {
  await panel.getByText('回踩', { exact: true }).click();
  await panel.getByPlaceholder('你看到了什么，为什么现在可以买入？').fill('回踩后企稳所以小仓试探');
  await panel.getByPlaceholder('计划如何开仓、加仓、持有？').fill('买入一百股再观察确认');
  await panel.getByPlaceholder('什么情况说明判断错误，如何控制损失？').fill('跌破支撑按原风险计划退出');
  await panel.getByLabel('止损价', { exact: true }).fill('9');
}

for (const [interval, width] of [['1d', 1366], ['hybrid', 1366], ['1d', 390]]) {
  test(`order submit stays visible outside the scroll body at ${interval}/${width}`, async ({ page, request }) => {
    const fixture = await startOrderTestServer();
    try {
      await connect(page, fixture);
      const { session } = await (await request.post(`${fixture.url}${path}`, { data: { interval, gameLength: 20 } })).json();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/decision/market-replay?session=${session.id}`);
      await page.getByRole('button', { name: '买入', exact: true }).click();
      const panel = page.getByRole('dialog', { name: '买入决策记录', exact: true });
      const submit = panel.getByRole('button', { name: '提交买入委托', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel).toBeFocused();
      await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeHidden();
      const box = await submit.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(900);
      expect(await submit.evaluate(el => !el.closest('.replay-order-dialog__body'))).toBe(true);
      await expect(submit).toBeDisabled();
      await fillOrder(panel);
      await expect(submit).toBeEnabled();
      const before = await submit.boundingBox();
      await panel.locator('.replay-order-dialog__body').evaluate(el => { el.scrollTop = 0; });
      expect((await submit.boundingBox()).y).toBeCloseTo(before.y, 0);
      await panel.getByRole('button', { name: '暂时收起', exact: true }).click();
      await page.getByRole('button', { name: '买入', exact: true }).click();
      await expect(panel.getByPlaceholder('你看到了什么，为什么现在可以买入？')).toHaveValue('回踩后企稳所以小仓试探');
      await submit.click();
      await expect(panel).toBeHidden();
      await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
      const saved = await read(request, fixture, session.id);
      expect(saved.pendingOrders).toHaveLength(1);
      expect(saved.pendingOrders[0].decision.thesis).toBe('回踩后企稳所以小仓试探');
      expect(saved.pendingOrders[0].decision.stopLossPrice).toBe(9);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
  });
}

test('completed A-share presents one next action and keeps detailed score data available without rewriting records', async ({ page, request }) => {
  const fixture = await startOrderTestServer();
  try {
    await connect(page, fixture);
    const { session } = await (await request.post(`${fixture.url}${path}`, { data: { interval: '1d', gameLength: 20 } })).json();
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    await page.getByRole('button', { name: '结束本局', exact: true }).click();
    await page.getByRole('button', { name: '确认结束', exact: true }).click();
    const review = page.getByRole('dialog', { name: '本次复盘', exact: true });
    await expect(review).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: '回放控制', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '买入', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '卖出', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '填写揭晓前盲评', exact: true }).click();
    await review.getByRole('checkbox', { name: '回踩', exact: true }).check();
    await review.getByPlaceholder('你看到了什么，为什么做出这个判断？').fill('回踩确认前先保持观察');
    await review.getByPlaceholder('计划如何开仓、持有、减仓或空仓？').fill('条件不够所以本次空仓');
    await review.getByPlaceholder('什么情况说明判断错误，如何控制损失？').fill('出现破位就放弃入场');
    await review.getByRole('button', { name: '保存并冻结整局盲评', exact: true }).click();
    const frozen = structuredClone((await read(request, fixture, session.id)).review.blindReview);
    const reveal = review.getByRole('button', { name: '揭晓行情', exact: true });
    const correction = review.getByRole('button', { name: '追加修正', exact: true });
    expect(await reveal.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(await correction.evaluate(el => getComputedStyle(el).backgroundColor));
    await reveal.click();
    await expect(review.getByRole('heading', { name: '揭晓后复盘', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '继续事后复盘', exact: true }).click();
    await review.getByPlaceholder('实际执行和原计划有哪些一致或偏离？').fill('保持空仓符合本次原计划');
    await review.getByPlaceholder('没有明显错误时可填写“无”').fill('无');
    await review.getByPlaceholder('下一次遇到类似行情，你会保留或改变什么？').fill('继续等待条件确认后操作');
    await review.getByRole('button', { name: '提交复盘并评分', exact: true }).click();
    await expect(review.getByText('本局评分', { exact: true })).toBeVisible();
    const saved = await read(request, fixture, session.id);
    expect(saved.review.blindReview).toEqual(frozen);
    const detail = review.locator('.replay-review__score-details');
    await expect(detail.getByText('平均资金使用率', { exact: true })).toBeHidden();
    expect(await review.locator('.replay-review__dimensions').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
    await detail.locator('summary').click();
    await expect(detail.getByText('平均资金使用率', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '查看复盘', exact: true }).click();
    expect((await read(request, fixture, session.id)).scoreCard).toEqual(saved.scoreCard);
    expect((await read(request, fixture, session.id)).review).toEqual(saved.review);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '新开一局', exact: true })).toBeVisible();
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});

test('crypto review has a neutral blind label and promotes retraining only after post-review is saved', async ({ page, request }) => {
  const fixture = await startCryptoTestServer();
  try {
    await connect(page, fixture);
    const { session } = await (await request.post(`${fixture.url}${path}`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } })).json();
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    await page.getByRole('button', { name: '结束练习', exact: true }).click();
    await page.getByRole('button', { name: '结束并进入盲评', exact: true }).click();
    const review = page.getByRole('region', { name: '合约复盘', exact: true });
    await review.getByLabel('盲评判断', { exact: true }).fill('行情未确认前保持观察');
    await review.getByLabel('盲评交易计划', { exact: true }).fill('暂时空仓等待有效信号');
    await review.getByRole('button', { name: '保存盲评', exact: true }).click();
    const frozen = structuredClone((await read(request, fixture, session.id)).blindReview);
    await review.getByRole('button', { name: '揭晓完整行情', exact: true }).click();
    const retrain = review.getByRole('button', { name: '按原版本复练', exact: true });
    await expect(retrain).toHaveClass(/ql-ui-button--ghost/u);
    await review.getByLabel('复盘观察', { exact: true }).fill('方向未确认所以继续观察');
    await review.getByLabel('执行偏差', { exact: true }).fill('保持空仓符合原定计划');
    await review.getByLabel('下次行动', { exact: true }).fill('先确认退出条件再考虑入场');
    await review.getByRole('button', { name: '保存事后复盘', exact: true }).click();
    await expect(retrain).toHaveClass(/ql-ui-button--primary/u);
    expect((await read(request, fixture, session.id)).blindReview).toEqual(frozen);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
});
