import { expect, test } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
const metrics = { totalReturnPct: -2, maxDrawdownPct: 3, totalTradingCosts: 20, averageCapitalUtilizationPct: 30, maxCapitalUtilizationPct: 60, buyFillCount: 2, sellFillCount: 1 };
function attempt(id, number, overrides = {}) {
  return { id, attemptNumber: number, kind: number === 1 ? "first" : "retrain", available: true, status: "completed", createdAt: "2026-10-20T01:00:00Z",
    conditions: { initialCapital: 100000, completedSteps: 20, totalSteps: 20 }, metrics, scoreCard: { total: number === 1 ? 70 : 80 },
    originalReview: { blindReview: { thesis: number === 1 ? "首次原始判断" : "复练原始判断", tradePlan: "等待回踩后逐步买入", riskPlan: "跌破风险边界退出" }, postReview: { outcome: "partial", mistakes: "首次原始问题", lessons: "原始教训保留不覆盖" } },
    corrections: number === 1 ? [{ id: "correction-first", stage: "post", revisionNumber: 1, createdAt: "2026-10-20", fullReviewSnapshot: { outcome: "correct", mistakes: "首次修正问题", lessons: "复盘修正单独保留" } }] : [],
    executions: [{ executionId: `${id}-fill`, status: "filled", side: "buy", step: 2, quantity: 501, price: 10, totalFee: 5, decision: { thesis: "回踩计划" } }],
    comparison: { comparable: true, reasons: [], delta: { totalReturnPct: 3, maxDrawdownPct: -1, totalTradingCosts: 2, averageCapitalUtilizationPct: 0, maxCapitalUtilizationPct: 0, buyFillCount: 0, sellFillCount: 0, scoreTotal: 10 } }, ...overrides };
}
function group() {
  return { selectedSessionId: "first", firstSessionId: "first", firstUnavailable: null, counts: { first: 1, retrain: 3 }, attempts: [
    attempt("first", 1), attempt("r2", 2), attempt("r3", 3, { comparison: { comparable: false, reasons: ["初始资金不同"], delta: null } }),
    { id: "r4", attemptNumber: 4, kind: "retrain", status: "active", available: false },
  ] };
}
async function openHistory(page, { payload = group(), revealed = true, failOnce = false } = {}) {
  let calls = 0;
  const first = attempt("first", 1);
  const historyItem = { id: "first", revealed, reviewState: revealed ? "reviewed" : "active", status: revealed ? "completed" : "active", interval: "1d", gameLength: 20, attemptInfo: { attemptNumber: 1, kind: "first", countsTowardFirstScore: true }, progress: { current: 20, total: 20 }, review: { blindReview: first.originalReview.blindReview, postReview: first.originalReview.postReview }, reveal: { tsCode: "600000.SH", name: "对照测试" } };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/first/comparison")) {
      calls++;
      if (failOnce && calls === 1) return route.fulfill({ status: 503, json: { error: { message: "对照暂时无法读取" } } });
      return route.fulfill({ json: payload });
    }
    if (path === "/api/quant/replay/sessions") return route.fulfill({ json: { items: [historyItem], total: 1, page: 1, pageSize: 10 } });
    if (path.endsWith("/sessions/first")) return route.fulfill({ json: { session: historyItem } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`${baseUrl}/decision/trade-records`);
  await page.getByRole("button", { name: "历史演练", exact: true }).click();
  await expect(page.getByRole("button", { name: "首次与复练对照", exact: true })).toBeVisible();
  return () => calls;
}

test("首次固定保留，可切换多次复练，未揭晓与条件不同比较不显示差值", async ({ page }) => {
  await openHistory(page);
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog).toBeVisible();
  const select = dialog.getByLabel("选择对照复练");
  await select.selectOption("r2");
  await expect(dialog.getByRole("row", { name: /原始评分/u })).toContainText("+10.00 分");
  await expect(dialog.getByText("首次原始判断", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("首次修正问题", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText(/买入 501 股/u).first()).toBeVisible();
  await select.selectOption("r3");
  await expect(dialog.getByText("初始资金不同", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("row", { name: /原始评分/u })).toContainText("—");
  await select.selectOption("r4");
  await expect(dialog.getByText("这次复练尚未揭晓，暂不展示判断、交易或成绩。")).toBeVisible();
  await expect(dialog.getByRole("row", { name: /原始评分/u })).toContainText("70.00 分");
  await expect(dialog.getByRole("row", { name: /原始评分/u })).not.toContainText("80.00 分");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("首次缺失时不会把复练提升为首次，窄屏仍能查看与切换", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const payload = group();
  payload.firstSessionId = null;
  payload.firstUnavailable = "deleted";
  payload.counts.first = 0;
  payload.attempts.shift();
  await openHistory(page, { payload });
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog.getByText(/首次记录已删除/u)).toBeVisible();
  await dialog.getByLabel("选择对照复练").selectOption("r2");
  const scoreRow = dialog.getByRole("row", { name: /原始评分/u });
  await expect(scoreRow).toContainText("—");
  await expect(scoreRow).toContainText("80.00 分");
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("未揭晓入口禁用且不请求对照；读取失败可以重试", async ({ page }) => {
  const calls = await openHistory(page, { revealed: false });
  await expect(page.getByRole("button", { name: "首次与复练对照", exact: true })).toBeDisabled();
  expect(calls()).toBe(0);
  await page.unrouteAll({ behavior: "wait" });
  await openHistory(page, { failOnce: true });
  await page.getByRole("button", { name: "首次与复练对照", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "首次与复练对照", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("对照暂时无法读取");
  await dialog.getByRole("button", { name: "重新加载对照" }).click();
  await expect(dialog.getByRole("table", { name: "首次与复练结果对照" })).toBeVisible();
});
