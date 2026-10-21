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
  await page.getByRole("button", { name: "历史演练", exact: true }).click();
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
  await page.goto(`${url}/decision/market-replay`);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog.getByText("首次 1 次 · 已知复练 3 次")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "两阶段复盘 · 决策记录与评分" })).toBeVisible();
});
