import { expect, test } from "@playwright/test";
import { startComparisonTestServer } from "../../../backend/src/test-support/comparison-server.js";

let fixture;
test.beforeAll(async () => { fixture = await startComparisonTestServer(); });
test.afterAll(async () => { await fixture?.close(); });

test("真实首次与多代复练通过历史详情和揭晓后复盘入口展示同组记录", async ({ page, request }) => {
  const expectedResponse = await request.get(`${fixture.url}/api/quant/replay/sessions/${fixture.sessionIds.retrain3}/comparison`);
  expect(expectedResponse.status()).toBe(200);
  const expected = await expectedResponse.json();
  const original = expected.attempts.find(item => item.id === expected.firstSessionId);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const url = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
  await page.goto(`${url}/decision/trade-records`);
  await page.getByRole("button", { name: "演练记录", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "复练 · 第 3 次" }).click();
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog.getByText("首次 1 次 · 已知复练 3 次")).toBeVisible();
  await expect(dialog.getByRole("row", { name: /原始评分/u })).toContainText(`${Number(original.scoreCard.total).toFixed(2)} 分`);
  await expect(dialog.getByRole("row", { name: /交易费用/u })).toContainText("¥0.00");
  await expect(dialog.getByRole("row", { name: /收益率/u })).not.toContainText("—");
  await expect(dialog.getByText(/买入 5000 股/u)).toBeVisible();
  await dialog.getByLabel("选择对照复练").selectOption(fixture.sessionIds.retrain2);
  await expect(dialog.getByRole("columnheader", { name: "第 2 次复练" })).toBeVisible();
  await dialog.getByLabel("选择对照复练").selectOption(fixture.sessionIds.hidden);
  await expect(dialog.getByText("这次复练尚未揭晓，暂不展示判断、交易或成绩。")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.addInitScript(id => localStorage.setItem("investflow.replay.active-session-id", id), fixture.sessionIds.retrain3);
  await page.goto(`${url}/decision/market-replay?session=${fixture.sessionIds.retrain3}`);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog.getByText("首次 1 次 · 已知复练 3 次")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "两阶段复盘 · 决策记录与评分" })).toBeVisible();
});


test('score algorithm remains at the end of its score row on desktop and fits narrow screens',async({page})=>{
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    const response=await route.fetch({url:`${fixture.url}${url.pathname}${url.search}`});await route.fulfill({response});
  });
  const base=process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
  await page.goto(`${base}/decision/trade-records?tab=replay&market=ashare&session=${fixture.sessionIds.retrain3}`);
  const score=page.locator('.replay-history-detail__score-summary');
  const algorithm=score.locator('.replay-history-detail__score-summary-side .replay-history-detail__algorithm');
  await expect(algorithm).toBeVisible();
  const row=await score.boundingBox(),label=await algorithm.boundingBox();
  expect(label.y).toBeGreaterThanOrEqual(row.y);expect(label.y+label.height).toBeLessThanOrEqual(row.y+row.height);
  await score.screenshot({path:test.info().outputPath('score-row-desktop.png')});
  await score.click();await expect(page.locator('.replay-history-detail__score-body')).not.toBeVisible();
  await score.click();await expect(page.locator('.replay-history-detail__score-body')).toBeVisible();
  await page.setViewportSize({width:390,height:850});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await score.screenshot({path:test.info().outputPath('score-row-mobile.png')});
});

test('cancelling a retrain opened explicitly keeps its source in the URL after reload', async ({ page, request }) => {
  const created = await request.post(`${fixture.url}/api/quant/replay/sessions/${fixture.sessionIds.first}/retrain`);
  expect(created.status()).toBe(201);
  const { session } = await created.json();
  const sourceId = session.attemptInfo.sourceSessionId;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
  const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  await page.getByRole('button', { name: '本局配置', exact: true }).click();
  await page.getByRole('button', { name: '取消复练并返回首次结果', exact: true }).click();
  await page.getByRole('dialog', { name: '取消本次复练？', exact: true }).getByRole('button', { name: '取消复练并返回', exact: true }).click();
  await expect(page).toHaveURL(`${base}/decision/market-replay?session=${sourceId}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '查看复盘', exact: true })).toBeVisible();
  expect((await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).status()).toBe(404);
});
