import { expect, test } from "@playwright/test";

const replayUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";

function replayBars(count) {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    displayLabel: `第 ${index + 1} 日`,
    open: 10 + index / 100,
    high: 10.2 + index / 100,
    low: 9.8 + index / 100,
    close: 10.1 + index / 100,
    volume: 1000 + index,
    amount: 10000 + index,
    weekIndex: Math.floor(index / 5) + 1,
    monthIndex: Math.floor(index / 20) + 1,
  }));
}

function replaySession(revision = 0) {
  const revealedFutureBars = revision;
  const bars = replayBars(250 + revealedFutureBars);
  return {
    id: "e2e-replay-session",
    sourceDataVersion: "e2e-source",
    interval: "1d",
    gameLength: 20,
    observationBars: 250,
    revealedFutureBars,
    status: "active",
    completionReason: null,
    benchmarkCode: "000001.SH",
    revealed: false,
    revision,
    marketEvent: revision ? { sequence: 251, status: "normal" } : null,
    attemptInfo: {
      attemptNumber: 1,
      kind: "first",
      countsTowardFirstScore: true,
      sourceSessionId: null,
    },
    trainingConfig: { mode: "free" },
    costConfig: {
      commissionRate: 0.0003,
      minCommission: 5,
      stampTaxRate: 0.0005,
      transferFeeRate: 0.00001,
      slippageBps: 0,
    },
    account: {
      initialCapital: 100000,
      cash: 100000,
      positionQuantity: 0,
      availableQuantity: 0,
      lockedQuantity: 0,
      averageCost: 0,
      totalFees: 0,
    },
    pendingOrders: [],
    executions: [],
    valuation: {
      markPrice: bars.at(-1).close,
      marketValue: 0,
      totalEquity: 100000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
    },
    review: {
      blindSaved: false,
      postSaved: false,
      blindLocked: false,
      legacyBlindMissing: false,
      blindReview: null,
      postReview: null,
    },
    reviewDrafts: { blind: null, post: null },
    corrections: [],
    scoreCard: null,
    bars,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/quant/replay/benchmarks*", (route) => route.fulfill({
    json: {
      sourceDataVersion: "e2e-source",
      items: [{
        code: "000001.SH",
        name: "上证指数",
        supportedGameLengths: [20, 60, 120],
      }],
      initialization: { state: "ready", ready: true },
    },
  }));
  await page.route("**/api/quant/replay/playbooks", (route) =>
    route.fulfill({ json: { items: [] } }));
  await page.route("**/api/quant/replay/cache/status", (route) => route.fulfill({
    json: {
      state: "ready",
      initialization: { state: "ready", ready: true },
      stockPool: { state: "ready" },
      market: {},
      minute: {},
      storage: { marketBytes: 0, minuteBytes: 0, totalBytes: 0 },
      lastSuccessAt: "2026-08-09T10:00:00Z",
    },
  }));
  await page.route("**/api/quant/replay/sessions", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { session: replaySession(0) } });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/quant/replay/sessions/e2e-replay-session/advance", (route) =>
    route.fulfill({ json: { session: replaySession(1) } }));

  await page.goto(`${replayUrl}/decision/market-replay`);
  await page.evaluate(() => window.localStorage.removeItem("investflow.replay.active-session-id"));
  await page.reload();
});

test("创建、推进和周期切换通过 Attempt 与 Chart interface 工作", async ({ page }) => {
  await page.getByRole("button", { name: "开始日线盲测" }).click();

  await expect(page.getByRole("heading", { name: "历史行情盲测" })).toBeVisible();
  await expect(page.getByText("已推进 0 / 20 日")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  await page.getByRole("button", { name: "空仓观望，推进一天" }).click();

  await expect(page.getByText("已推进 1 / 20 日")).toBeVisible();
  await expect(page.getByText("REV 1")).toBeVisible();
  await expect(page.getByText("第 251 日", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "周", exact: true }).click();

  await expect(page.getByRole("button", { name: "周", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("仅根据当前已揭示的 51 根 K 线计算")).toBeVisible();
});

test("light 与 dark 使用同一组红涨绿跌图表颜色", async ({ page }) => {
  await page.getByRole("button", { name: "开始日线盲测" }).click();

  const colors = async () => page.evaluate(async () => {
    const module = await import("/src/utils/replayKlineConfig.js");
    return {
      rise: module.REPLAY_RISE_COLOR,
      fall: module.REPLAY_FALL_COLOR,
    };
  });

  const darkColors = await colors();
  await page.getByRole("button", { name: "切换主题" }).click();
  const lightColors = await colors();

  expect(darkColors).toEqual({ rise: "#df7180", fall: "#38ae86" });
  expect(lightColors).toEqual(darkColors);
});
