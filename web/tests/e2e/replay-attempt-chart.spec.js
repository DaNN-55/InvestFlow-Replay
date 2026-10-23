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
  const notice=page.getByRole('status',{name:'演练类型提醒',exact:true});
  await expect(notice).toHaveClass(/--first/);
  await notice.getByRole('button',{name:'关闭演练提醒'}).click();
  await expect(notice).not.toBeVisible();

  await expect(page.getByText("已推进 0 / 20 日")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  const playback=page.getByRole('region',{name:'回放控制',exact:true});
  await playback.getByRole('combobox',{name:'自动播放速度'}).selectOption('1');
  await playback.getByRole('button',{name:'自动播放',exact:true}).click();
  await expect(playback.getByRole('button',{name:'暂停',exact:true})).toBeVisible();
  await playback.getByRole('button',{name:'暂停',exact:true}).click();
  await expect(playback.getByRole('button',{name:'自动播放',exact:true})).toBeVisible();
  await page.getByRole("button", { name: "空仓观望，推进一天" }).click();

  await expect(page.getByText("已推进 1 / 20 日")).toBeVisible();
  await expect(page.getByText("REV 1")).toBeVisible();
  await expect(notice).not.toBeVisible();
  const tooltip=await page.evaluate(async()=>{
    const url=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name)).name,{init}=await import(url);
    const chart=init({id:document.querySelector('[k-line-chart-id]').getAttribute('k-line-chart-id')});
    return {type:chart.getStyles().candle.tooltip.showType,count:chart.getDataList().length};
  });
  expect(tooltip.type).toBe('rect');expect(tooltip.count).toBe(251);

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

test("复盘抽屉保留未提交草稿并让行情保持可见", async ({ page }) => {
  await page.route("**/api/quant/replay/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const session = replaySession(20);
    session.status = "completed";
    session.completionReason = "natural";
    await route.fulfill({ json: { session } });
  });
  await page.route("**/api/quant/replay/sessions/e2e-replay-session/reviews/blind/draft", (route) =>
    route.fulfill({
      json: {
        draft: { stage: "blind", revision: 1, data: route.request().postDataJSON().draft },
      },
    }));

  await page.getByRole("button", { name: "开始日线盲测" }).click();
  await page.getByRole("button", { name: "填写揭晓前盲评" }).click();

  const drawer = page.locator(".market-replay-review-drawer");
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox.x).toBeGreaterThan(page.viewportSize().width / 2);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(drawer.getByText("两阶段复盘 · 决策记录与评分", { exact: true })).toBeVisible();
  await expect(page.getByText("复盘记录时间线")).toHaveCount(0);

  const thesis = page.getByPlaceholder("你看到了什么，为什么做出这个判断？");
  await thesis.fill("这是一段尚未提交的临时复盘判断");
  await drawer.locator(".ql-ui-drawer__close").click();
  await page.getByRole("button", { name: "填写揭晓前盲评" }).click();

  await expect(thesis).toHaveValue("这是一段尚未提交的临时复盘判断");
});

test("揭晓后复盘先填写判断结果与两项评分", async ({ page }) => {
  await page.route("**/api/quant/replay/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const session = replaySession(20);
    session.status = "completed";
    session.revealed = true;
    session.review.blindSaved = true;
    session.review.blindLocked = true;
    session.review.blindReview = { strategyName: "测试策略" };
    await route.fulfill({ json: { session } });
  });

  await page.getByRole("button", { name: "开始日线盲测" }).click();
  await page.getByRole("button", { name: "查看复盘" }).click();

  const scoreRow = page.locator(".replay-review__score-row");
  await expect(scoreRow.getByLabel("判断结果")).toBeVisible();
  await expect(scoreRow.getByLabel("执行纪律")).toBeVisible();
  await expect(scoreRow.getByLabel("风险控制")).toBeVisible();

  const positions = await scoreRow.locator("label").evaluateAll((labels) =>
    labels.map((label) => label.getBoundingClientRect().top),
  );
  expect(positions).toHaveLength(3);
  expect(new Set(positions).size).toBe(1);

  const firstFieldLabel = await page
    .locator(".replay-review__form > .replay-review__field")
    .first()
    .locator("> span")
    .textContent();
  expect(firstFieldLabel).toBe("执行复盘");

  const scoreRowTop = await scoreRow.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const firstFieldTop = await page
    .locator(".replay-review__form > .replay-review__field")
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(scoreRowTop).toBeLessThan(firstFieldTop);
});


test('retrain notice dismisses automatically and cancellation stays in settings',async({page})=>{
  const retrain=replaySession(0);retrain.attemptInfo={kind:'retrain',attemptNumber:2,sourceSessionId:'first-result',countsTowardFirstScore:false};
  await page.route('**/api/quant/replay/sessions',async route=>{
    if(route.request().method()==='POST') return route.fulfill({json:{session:retrain}});
    await route.fallback();
  });
  await page.getByRole('button',{name:'开始日线盲测'}).click();
  const notice=page.getByRole('status',{name:'演练类型提醒',exact:true});
  await expect(notice).toHaveClass(/--retrain/);await expect(notice).toContainText('正在复练');
  await page.setViewportSize({width:320,height:850});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await notice.screenshot({path:test.info().outputPath('retrain-notice-mobile.png')});
  await expect(notice).not.toBeVisible({timeout:7500});
  await page.getByRole('button',{name:'本局配置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'本局配置',exact:true});
  await settings.getByRole('button',{name:'取消复练并返回首次结果',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'取消本次复练？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('heading',{name:'历史行情盲测'})).toBeVisible();
});

test('8x playback uses the same daily advance request and pauses without another step',async({page})=>{
  await page.getByRole('button',{name:'开始日线盲测'}).click();
  const playback=page.getByRole('region',{name:'回放控制',exact:true});
  await playback.getByRole('combobox',{name:'自动播放速度'}).selectOption('8');
  let calls=0;page.on('request',req=>{if(req.url().endsWith('/advance')&&req.method()==='POST') calls++;});
  const response=page.waitForResponse(res=>res.url().endsWith('/advance'));
  await playback.getByRole('button',{name:'自动播放',exact:true}).click();
  expect((await response).status()).toBe(200);
  await playback.getByRole('button',{name:'暂停',exact:true}).click();
  await expect(playback.getByRole('button',{name:'自动播放',exact:true})).toBeVisible();
  const paused=calls;await page.waitForTimeout(300);expect(calls).toBe(paused);
  await expect(playback.getByRole('combobox',{name:'自动播放速度'})).toHaveValue('8');
});
