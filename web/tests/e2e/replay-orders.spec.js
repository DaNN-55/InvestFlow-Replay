import { test, expect } from "@playwright/test";
import { startOrderTestServer } from "../../../backend/src/test-support/order-server.js";

let fixture;
test.beforeAll(async () => { fixture = await startOrderTestServer(); });
test.afterAll(async () => { await fixture?.close(); });

test("limit partial fill, cancel, stop latch and reload use the real temporary backend", async ({ page, request }) => {
  const created = await request.post(`${fixture.url}/api/quant/replay/sessions`, { data: { gameLength: 20, interval: "hybrid" } });
  expect(created.status()).toBe(201);
  const { session } = await created.json();
  await page.route("**/api/**", async (route) => {
    const original = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.url}${original.pathname}${original.search}` });
    await route.fulfill({ response });
  });
  await page.addInitScript((id) => localStorage.setItem("investflow.replay.active-session-id", id), session.id);
  await page.goto(`${process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180"}/decision/market-replay`);
  await page.getByRole("button", { name: "买入", exact: true }).click();
  const form = page.getByRole("dialog", { name: "买入决策记录" });
  await form.getByRole("combobox", { name: "委托类型" }).selectOption("limit");
  await form.getByRole("spinbutton", { name: "委托限价" }).fill("10");
  await form.getByRole("spinbutton", { name: "委托股数" }).fill("5000");
  await form.getByText("回踩", { exact: true }).click();
  await expect(form.getByRole("checkbox", { name: "回踩", exact: true })).toBeChecked();
  await form.getByLabel("核心判断").fill("价格回踩到事先确定的支撑范围");
  await form.getByLabel("开仓与持有计划").fill("等待限价成交后按原计划持有观察");
  await form.getByLabel("风险计划").fill("跌破防守价则持续退出当前剩余持仓");
  await form.getByLabel("止损价", { exact: true }).fill("9.8");
  await form.getByRole("button", { name: "提交买入委托", exact: true }).click();
  await expect(page.getByText("限价 ¥10.00 · 当日有效")).toBeVisible();
  const advance = async () => {
    const done = page.waitForResponse((response) => response.url().endsWith("/advance") && response.request().method() === "POST");
    await page.getByRole("button", { name: "推进 5 分钟", exact: true }).click();
    expect((await done).status()).toBe(200);
  };
  await advance();
  await expect(page.getByText("未到限价，继续等待")).toBeVisible();
  await advance();
  await expect(page.getByText("已成交 1000 股 · 剩余 4000 股")).toBeVisible();
  await page.getByRole("button", { name: "撤销未成交余量" }).click();
  await expect(page.getByRole("button", { name: "撤销未成交余量" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消止损保护" })).toBeVisible();
  await advance();
  await advance();
  await expect(page.getByText("止损 ¥9.80 · 已触发，持续退出")).toBeVisible();
  await advance();
  await expect(page.getByText("已成交 500 股 · 剩余 500 股")).toBeVisible();
  await page.reload();
  await expect(page.getByText("已成交 500 股 · 剩余 500 股")).toBeVisible();
  await advance();
  await expect(page.getByRole("button", { name: "取消止损保护" })).toHaveCount(0);
  const restored = await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json();
  expect(restored.session.account.positionQuantity).toBe(0);
  expect(restored.session.executions.filter((item) => item.side === "sell" && item.status === "filled").map((item) => item.quantity)).toEqual([500, 500]);
});
