import { test, expect } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';

test('five-character inputs submit orders, original reviews and both correction forms while four characters remain blocked', async ({ page, request }) => {
  const fixture = await startOrderTestServer(), text = '按计划执行', short = '继续观察';
  try {
    const path = '/api/quant/replay/sessions';
    const { session } = await (await request.post(`${fixture.url}${path}`, { data: { interval: 'hybrid', gameLength: 20 } })).json();
    const url = `${fixture.url}${path}/${session.id}`;
    const current = async () => (await (await request.get(url)).json()).session;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
    });
    const pageUrl = `${process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180'}/decision/market-replay?session=${session.id}`;
    await page.goto(pageUrl); await page.getByRole('button', { name: '买入', exact: true }).click();
    const order = page.getByRole('dialog', { name: '买入决策记录' });
    await order.getByRole('spinbutton', { name: '委托股数' }).fill('100'); await order.getByText('回踩', { exact: true }).click();
    const orderFields = [order.getByLabel('核心判断'), order.getByLabel('开仓与持有计划'), order.getByLabel('风险计划')];
    for (const field of orderFields) await field.fill(text);
    await order.getByLabel('止损价', { exact: true }).fill('9.8');
    const submit = order.getByRole('button', { name: '提交买入委托', exact: true });
    for (const field of orderFields) { await field.fill(short); await expect(submit).toBeDisabled(); await field.fill(text); }
    await expect(submit).toBeEnabled(); await order.screenshot({ path: test.info().outputPath('five-character-order.png') });
    let response = page.waitForResponse(response => response.url().endsWith('/orders') && response.request().method() === 'POST'); await submit.click(); expect((await response).status()).toBe(201);
    let saved = await current(); expect(saved.pendingOrders[0].decision.thesis).toBe(text);
    expect((await request.post(`${url}/finish`, { data: { actionId: crypto.randomUUID(), expectedRevision: saved.revision } })).status()).toBe(200);
    await page.reload(); await page.getByRole('button', { name: '填写揭晓前盲评', exact: true }).click();
    let review = page.getByRole('dialog', { name: '两阶段复盘 · 决策记录与评分', exact: true });
    const blindFields = [review.getByPlaceholder('你看到了什么，为什么做出这个判断？'), review.getByPlaceholder('计划如何开仓、持有、减仓或空仓？'), review.getByPlaceholder('什么情况说明判断错误，如何控制损失？')];
    const blindSubmit = review.getByRole('button', { name: '保存并冻结整局盲评', exact: true });
    for (const field of blindFields) { await expect(field).toHaveAttribute('minlength', '5'); await field.fill(text); }
    for (const field of blindFields) { await field.fill(short); await expect(blindSubmit).toBeDisabled(); await field.fill(text); }
    response = page.waitForResponse(response => response.url().endsWith('/reviews/blind') && response.request().method() === 'POST'); await blindSubmit.click(); expect((await response).status()).toBe(200);
    saved = await current(); expect(saved.review.blindReview.tradePlan).toBe(text);
    expect((await request.post(`${url}/reveal`, { data: { actionId: crypto.randomUUID(), expectedRevision: saved.revision } })).status()).toBe(200);
    await page.reload(); await page.getByRole('button', { name: '查看复盘', exact: true }).click();
    review = page.getByRole('dialog', { name: '两阶段复盘 · 决策记录与评分', exact: true });
    const postFields = [review.getByLabel('执行复盘'), review.getByLabel('经验总结')], postSubmit = review.getByRole('button', { name: '保存原始复盘并评分', exact: true });
    await review.getByLabel('错误与不足').fill('无');
    for (const field of postFields) { await expect(field).toHaveAttribute('minlength', '5'); await field.fill(text); }
    for (const field of postFields) { await field.fill(short); await expect(postSubmit).toBeDisabled(); await field.fill(text); }
    await review.screenshot({ path: test.info().outputPath('five-character-review.png') });
    response = page.waitForResponse(response => response.url().endsWith('/reviews/post') && response.request().method() === 'POST'); await postSubmit.click(); expect((await response).status()).toBe(200);
    for (const [stage, label, indexes] of [['blind', '追加盲评修正', [0, 1, 2]], ['post', '追加事后复盘修正', [0, 2]]]) {
      await review.getByRole('button', { name: label, exact: true }).click();
      const form = review.locator('form.replay-correction'), save = form.getByRole('button', { name: '保存为新修正', exact: true });
      await form.getByLabel('修正说明（必填）').fill('修正');
      for (const index of indexes) { const field = form.locator('textarea').nth(index); await expect(field).toHaveAttribute('minlength', '5'); await field.fill(short); await expect(save).toBeDisabled(); await field.fill(text); }
      await expect(save).toBeEnabled();
      response = page.waitForResponse(response => response.url().endsWith(`/reviews/${stage}/corrections`) && response.request().method() === 'POST'); await save.click(); expect((await response).status()).toBe(200); await expect(form).toHaveCount(0);
    }
    saved = await current(); expect(saved.corrections).toHaveLength(2);
    expect(saved.scoreCard.completeness.completedRequiredFields).toBe(saved.scoreCard.completeness.totalRequiredFields);
    await page.reload(); saved = await current(); expect(saved.review.blindReview.thesis).toBe(text); expect(saved.review.postReview.lessons).toBe(text);
  } finally { try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' }); } finally { await fixture.close(); } }
});
