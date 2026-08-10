import { expect, test } from "@playwright/test";

const replayUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
const benchmark = {
  code: "FIXTURE.IDX",
  name: "合成指数",
  supportedGameLengths: [20, 60, 120],
};

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

function replaySession() {
  const bars = replayBars(250);
  return {
    id: "e2e-evidence-session",
    sourceDataVersion: "fixture-v1",
    interval: "1d",
    gameLength: 60,
    observationBars: 250,
    revealedFutureBars: 0,
    status: "active",
    completionReason: null,
    benchmarkCode: benchmark.code,
    revealed: false,
    revision: 0,
    marketEvent: null,
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

function readyInitialization(message = "离线合成行情已就绪") {
  return {
    provider: "fixture",
    mode: "fixture",
    state: "ready",
    ready: true,
    completed: 1,
    total: 1,
    message,
    error: "",
  };
}

function cacheStatus(activeTask = readyInitialization()) {
  return {
    provider: activeTask.provider,
    state: "ready",
    activeTask,
    initialization: activeTask,
    stockPool: { state: "ready" },
    market: {
      instrumentCount: 2,
      stockCount: 2,
      stockDailyBarCount: 740,
      adjustFactorCount: 740,
      indexCount: 1,
      indexDailyBarCount: 370,
      tradeDateCount: 370,
    },
    minute: {
      oneMinuteInstrumentCount: 0,
      oneMinuteBarCount: 0,
      fiveMinuteInstrumentCount: 0,
      fiveMinuteBarCount: 0,
    },
    storage: { marketBytes: 0, minuteBytes: 0, totalBytes: 0 },
    lastSuccessAt: "2026-08-10T09:00:00Z",
  };
}

async function mockReplayApi(page, {
  benchmarks,
  status = cacheStatus(),
  createResponse = { status: 200, json: { session: replaySession() } },
}) {
  await page.route("**/api/quant/replay/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/quant/replay/benchmarks") {
      await route.fulfill({ json: benchmarks });
      return;
    }
    if (pathname === "/api/quant/replay/cache/status") {
      await route.fulfill({ json: status });
      return;
    }
    if (pathname === "/api/quant/replay/playbooks") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (pathname === "/api/quant/replay/sessions" && request.method() === "POST") {
      await route.fulfill(createResponse);
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function openReplay(page) {
  await page.addInitScript(() => {
    window.localStorage.removeItem("investflow.replay.active-session-id");
  });
  await page.goto(`${replayUrl}/decision/market-replay`);
}

test("正常 fixture 行情可以创建演练并进入工作区", async ({ page }) => {
  await mockReplayApi(page, {
    benchmarks: {
      provider: "fixture",
      sourceDataVersion: "fixture-v1",
      items: [benchmark],
      initialization: readyInitialization(),
    },
  });
  await openReplay(page);

  await expect(page.getByRole("status")).toContainText("离线合成数据");
  await page.getByRole("button", { name: "开始日线盲测" }).click();

  await expect(page.getByRole("heading", { name: "历史行情盲测" })).toBeVisible();
  await expect(page.getByText("盲测场景已创建，已展示 250 根观察日线。")).toBeVisible();
  await expect(page.getByText("已推进 0 / 60 日")).toBeVisible();
});

test("缓存不足时显示明确的初始化错误", async ({ page }) => {
  const cacheError = "通达信连接失败且本地缓存不足，无法初始化行情演练：没有可用服务器";
  await mockReplayApi(page, {
    benchmarks: {
      provider: "tdx",
      sourceDataVersion: null,
      items: [],
      initialization: {
        provider: "tdx",
        state: "failed",
        ready: false,
        error: cacheError,
      },
    },
    status: {
      ...cacheStatus(),
      state: "failed",
      activeTask: { state: "failed", message: cacheError },
    },
  });
  await openReplay(page);

  await expect(
    page.getByRole("region", { name: "指数基准设置" })
      .getByText(cacheError, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
});

test("创建场景返回 409 时显示缓存不足业务错误且不进入工作区", async ({ page }) => {
  const cacheError = "通达信连接失败且本地缓存不足，无法初始化行情演练：演示连接不可用";
  await mockReplayApi(page, {
    benchmarks: {
      provider: "tdx",
      sourceDataVersion: "cached-v1",
      items: [benchmark],
      initialization: readyInitialization("本地行情缓存已就绪"),
    },
    createResponse: {
      status: 409,
      json: {
        error: {
          code: "MARKET_CACHE_INSUFFICIENT",
          message: cacheError,
          details: null,
        },
      },
    },
  });
  await openReplay(page);

  await page.getByRole("button", { name: "开始日线盲测" }).click();

  await expect(page.getByRole("status").filter({ hasText: cacheError })).toBeVisible();
  await expect(page.getByText(cacheError, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "历史行情盲测" })).toHaveCount(0);
});

test("连接失败但缓存可用时缓存面板显示降级文案", async ({ page }) => {
  const fallbackMessage = "通达信连接失败，继续使用本地缓存：network unavailable";
  const fallbackTask = {
    provider: "tdx",
    mode: "cache",
    state: "ready",
    ready: true,
    message: fallbackMessage,
    error: "",
  };
  await mockReplayApi(page, {
    benchmarks: {
      provider: "tdx",
      sourceDataVersion: "cached-v1",
      items: [benchmark],
      initialization: fallbackTask,
    },
    status: cacheStatus(fallbackTask),
  });
  await openReplay(page);

  await page.getByRole("button", { name: "行情缓存状态" }).click();

  await expect(page.getByRole("status").filter({ hasText: fallbackMessage })).toBeVisible();
  await expect(page.getByText(fallbackMessage, { exact: true })).toBeVisible();
});

test("创建 API 返回 400 时显示后端 INVALID_REQUEST 文案", async ({ page }) => {
  const invalidRequestMessage = "初始资金必须大于 0";
  await mockReplayApi(page, {
    benchmarks: {
      provider: "fixture",
      sourceDataVersion: "fixture-v1",
      items: [benchmark],
      initialization: readyInitialization(),
    },
    createResponse: {
      status: 400,
      json: {
        error: {
          code: "INVALID_REQUEST",
          message: invalidRequestMessage,
          details: null,
        },
      },
    },
  });
  await openReplay(page);

  await page.getByRole("button", { name: "开始日线盲测" }).click();

  await expect(page.getByRole("status").filter({ hasText: invalidRequestMessage })).toBeVisible();
  await expect(page.getByText(invalidRequestMessage, { exact: true })).toBeVisible();
});

test("刷新缓存状态后再次点击入口可以收起面板", async ({ page }) => {
  await mockReplayApi(page, {
    benchmarks: {
      provider: "fixture",
      sourceDataVersion: "fixture-v1",
      items: [benchmark],
      initialization: readyInitialization(),
    },
  });
  await openReplay(page);
  const trigger = page.getByRole("button", { name: "行情缓存状态" });
  const panel = page.getByRole("status").filter({ hasText: "行情数据" });

  await trigger.click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "刷新缓存状态" }).click();
  await trigger.click();

  await expect(panel).toBeHidden();
});

test("点击面板外或按 Esc 可以收起面板", async ({ page }) => {
  await mockReplayApi(page, {
    benchmarks: {
      provider: "fixture",
      sourceDataVersion: "fixture-v1",
      items: [benchmark],
      initialization: readyInitialization(),
    },
  });
  await openReplay(page);
  const trigger = page.getByRole("button", { name: "行情缓存状态" });
  const panel = page.getByRole("status").filter({ hasText: "行情数据" });

  await trigger.click();
  await page.getByRole("main").click({ position: { x: 20, y: 200 } });
  await expect(panel).toBeHidden();

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
