import { expect, test } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
const recordId = "trade-record-ui-test";
const record = {
  id: recordId,
  stockCode: "600519",
  stockName: "贵州茅台",
  accountType: "simulated",
  tradeType: "system",
  status: "draft",
  manualMaxAccountRiskPct: "",
  manualMaxPositionPct: "20",
  validForTradeDate: "2026-08-06",
  triggerPrice: "1450",
  failurePrice: "1420",
  targetPrice: "1510",
  strategyProfile: {
    key: "custom",
    name: "突破战法",
    version: "v1",
    summary: "保留已有战法说明",
    entryRules: "放量突破",
    exitRules: "跌破止损",
    riskRules: "单笔风险受限",
  },
  violations: [],
  executionEvents: [{
    id: "execution-event-1",
    eventAt: "2026-08-06 09:45",
    action: "buy",
    price: 43.4,
    quantity: 100,
    fee: 2,
    planStatus: "unplanned",
    source: "盘中强势",
    note: "等待确认",
  }],
  ledger: {
    state: "empty",
    positionQuantity: 0,
    averageCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    returnPct: 0,
    totalFees: 0,
    unplannedEventCount: 0,
  },
};

async function openTradeRecordDetailMenu(page) {
  await page.getByRole("button", { name: "交易追踪单操作" }).click();
}

async function openExecutionEventMenu(page) {
  await page.getByRole("button", { name: "成交记录操作" }).click();
}

async function openReplayHistoryMenu(page) {
  await page.getByRole("button", { name: "演练记录操作" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/quant/replay/playbooks") {
      await route.fulfill({
        json: {
          items: [
            { id: "playbook-breakout", name: "突破战法", currentVersion: { versionNumber: 2 } },
            { id: "playbook-pullback", name: "回踩战法", currentVersion: { versionNumber: 1 } },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/quant/decision/stocks/search") {
      await route.fulfill({
        json: {
          query: url.searchParams.get("query"),
          items: [{ code: "600000", name: "浦发银行", source: "cache" }],
        },
      });
      return;
    }
    if (url.pathname === "/api/quant/decision/trade-records") {
      await route.fulfill({ json: { items: [record] } });
      return;
    }
    if (url.pathname === `/api/quant/decision/trade-records/${recordId}`) {
      const updates = route.request().method() === "PATCH"
        ? route.request().postDataJSON()
        : {};
      await route.fulfill({ json: { item: { ...record, ...updates } } });
      return;
    }
    if (url.pathname === `/api/quant/decision/trade-records/${recordId}/execution-events/execution-event-1`) {
      if (route.request().method() === "PATCH") {
        const updates = route.request().postDataJSON();
        await route.fulfill({
          json: {
            ...record,
            executionEvents: [{ ...record.executionEvents[0], ...updates }],
          },
        });
        return;
      }
      if (route.request().method() === "DELETE") {
        await route.fulfill({ json: { ...record, executionEvents: [] } });
        return;
      }
    }
    if (url.pathname === "/api/quant/decision/execution-settings") {
      await route.fulfill({
        json: {
          simulatedAccountEquity: 100000,
          liveAccountEquity: 100000,
          defaultMaxAccountRiskPct: 0.5,
          defaultMinRewardRiskRatio: 2,
          lotSize: 100,
        },
      });
      return;
    }
    await route.fulfill({ json: {} });
  });
});

test("交易详情默认聚焦成交记录并按需展开交易计划", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  await expect(page.getByRole("button", { name: "执行参数", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "基本信息" })).toBeVisible();
  await expect(page.getByText("交易追踪列表已刷新", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "成交与动作记录" })).toBeVisible();
  await expect(page.locator(".trade-record-tags")).toHaveCount(0);
  await expect(page.locator(".trade-review-panel")).toHaveCount(0);
  await expect(page.locator(".trade-violation-entry")).toHaveCount(0);
  await expect(page.getByText("当日诊断快照", { exact: true })).toHaveCount(0);

  const recordList = page.locator(".trade-record-list");
  await expect(recordList).toBeVisible();
  await expect(page.locator(".trade-record-table")).toHaveCount(0);
  await expect(recordList.getByText("贵州茅台 600519", { exact: true })).toBeVisible();
  await expect(recordList.getByText("模拟 · 系统交易 · 突破战法", { exact: true })).toBeVisible();

  const plan = page.locator("details.trade-plan-details");
  await expect(plan).not.toHaveAttribute("open", "");
  await expect(page.getByText("单笔风险预算（%）", { exact: true })).toBeHidden();
  await plan.getByText("交易计划与风控（可选）", { exact: true }).click();
  await expect(page.getByText("单笔风险预算（%）", { exact: true })).toBeVisible();
  const riskBudgetLabel = plan.getByText("单笔风险预算（%）", { exact: true }).locator("..");
  await expect(riskBudgetLabel).toContainText("执行参数默认：0.5%");
  await expect(riskBudgetLabel.locator("input")).toHaveCount(0);
});

test("新建交易通过代码或名称选择后同步显示股票身份", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);
  await page.getByRole("button", { name: "新建交易", exact: true }).click();

  const drawer = page.getByRole("dialog", { name: "新建交易追踪" });
  const search = drawer.getByLabel("股票代码或名称", { exact: true });
  await search.fill("600000");
  await drawer.getByRole("button", { name: "浦发银行 600000" }).click();
  await expect(drawer.getByText("浦发银行", { exact: true })).toBeVisible();
  await expect(drawer.getByText("600000", { exact: true })).toBeVisible();

  await search.fill("浦发银行");
  await drawer.getByRole("button", { name: "浦发银行 600000" }).click();
  await expect(drawer.getByText("浦发银行", { exact: true })).toBeVisible();
  await expect(drawer.getByText("600000", { exact: true })).toBeVisible();
});

test("新建交易可以不选战法、选择战法库或创建首版战法", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);
  await page.getByRole("button", { name: "新建交易", exact: true }).click();

  const drawer = page.getByRole("dialog", { name: "新建交易追踪" });
  const strategy = drawer.locator(".trade-record-strategy-picker");
  const mode = strategy.locator("select").first();
  await expect(mode).toHaveValue("none");
  await expect(strategy.locator("select")).toHaveCount(1);

  await mode.selectOption("library");
  const library = strategy.locator("select").nth(1);
  await expect(library).toContainText("突破战法 · v2");
  await expect(library).toContainText("回踩战法 · v1");

  await mode.selectOption("new");
  await expect(drawer.getByLabel("战法名称", { exact: true })).toBeVisible();
  await expect(drawer.getByLabel("首版正文", { exact: true })).toBeVisible();
  await expect(drawer.getByLabel("创建说明", { exact: true })).toBeVisible();
  await expect(drawer.getByText("v1", { exact: true })).toBeVisible();
});

test("详情头部通过修改抽屉更新交易信息", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  const detailHeader = page.locator(".trade-record-detail .ql-ui-card__header");
  await expect(detailHeader.getByRole("heading", { name: "贵州茅台 600519" })).toBeVisible();
  await expect(detailHeader.getByRole("textbox")).toHaveCount(0);
  await openTradeRecordDetailMenu(page);
  await page.getByRole("button", { name: "修改", exact: true }).click();

  const drawer = page.getByRole("dialog", { name: "修改交易追踪" });
  await expect(drawer).toBeVisible();
  const stockSearch = drawer.getByLabel("股票代码或名称", { exact: true });
  await expect(stockSearch).toHaveValue("贵州茅台 600519");
  await stockSearch.fill("600000");
  await drawer.getByRole("button", { name: "浦发银行 600000" }).click();

  const updateRequest = page.waitForRequest((request) =>
    request.method() === "PATCH"
      && new URL(request.url()).pathname === `/api/quant/decision/trade-records/${recordId}`,
  );
  await drawer.getByRole("button", { name: "保存修改", exact: true }).click();
  const request = await updateRequest;

  expect(request.postDataJSON()).toMatchObject({
    stockCode: "600000",
    stockName: "浦发银行",
    strategyProfile: {
      name: "突破战法",
      version: "v1",
      summary: "保留已有战法说明",
      entryRules: "放量突破",
      exitRules: "跌破止损",
      riskRules: "单笔风险受限",
    },
  });
  await expect(drawer).toBeHidden();
  await expect(detailHeader.getByRole("heading", { name: "浦发银行 600000" })).toBeVisible();
  await expect(page.locator(".trade-record-list").getByText("浦发银行 600000", { exact: true })).toBeVisible();
});

test("详情保存按钮位于表单底部而非头部", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  const detailHeader = page.locator(".trade-record-detail .ql-ui-card__header");
  await expect(detailHeader.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(page.locator("form.trade-record-form").getByRole("button", { name: "保存", exact: true })).toBeVisible();
});

test("已买入和持仓阶段不显示重复的通用保存按钮", async ({ page }) => {
  await page.route(`**/api/quant/decision/trade-records/${recordId}`, async (route) => {
    await route.fulfill({ json: { ...record, status: "entered" } });
  });
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  const form = page.locator("form.trade-record-form");
  await expect(form.getByRole("button", { name: "添加动作", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
});

test("已记录的成交动作可以通过弹窗修改", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  await openExecutionEventMenu(page);
  await page.getByRole("button", { name: "修改", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修改成交或动作记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("时间", { exact: true })).toHaveAttribute("type", "date");
  await expect(dialog.getByLabel("时间", { exact: true })).toHaveValue("2026-08-06");
  await expect(dialog.getByLabel("价格", { exact: true })).toHaveValue("43.4");
  await dialog.getByLabel("价格", { exact: true }).fill("44.2");
  await dialog.getByLabel("备注", { exact: true }).fill("修正后的记录");

  const updateRequest = page.waitForRequest((request) =>
    request.method() === "PATCH"
      && new URL(request.url()).pathname === `/api/quant/decision/trade-records/${recordId}/execution-events/execution-event-1`,
  );
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  const request = await updateRequest;
  expect(request.postDataJSON()).toMatchObject({ price: 44.2, note: "修正后的记录" });
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/价 44.2/)).toBeVisible();
  const feedback = page.getByText("成交或动作记录已修改", { exact: true });
  await expect(feedback).toBeVisible();
  const feedbackAppearsBeforeEvents = await feedback.evaluate((node) => {
    const events = document.querySelector(".trade-execution-events");
    return Boolean(events && (node.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(feedbackAppearsBeforeEvents).toBe(true);
});

test("添加动作通过日期选择器仅提交年月日", async ({ page }) => {
  await page.route(`**/api/quant/decision/trade-records/${recordId}/execution-events`, async (route) => {
    const event = route.request().postDataJSON();
    await route.fulfill({ json: { ...record, executionEvents: [...record.executionEvents, event] } });
  });
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  const eventForm = page.locator("form.trade-execution-events__form");
  const eventAt = eventForm.getByLabel("时间", { exact: true });
  await expect(eventAt).toHaveAttribute("type", "date");
  await eventAt.fill("2026-08-07");
  await eventForm.getByLabel("价格", { exact: true }).fill("44.2");
  await eventForm.getByLabel("数量", { exact: true }).fill("100");

  const addRequest = page.waitForRequest((request) =>
    request.method() === "POST"
      && new URL(request.url()).pathname === `/api/quant/decision/trade-records/${recordId}/execution-events`,
  );
  await eventForm.getByRole("button", { name: "添加动作", exact: true }).click();
  expect((await addRequest).postDataJSON()).toMatchObject({ eventAt: "2026-08-07" });
});

test("成交记录和交易追踪单删除前都使用应用内二次确认", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records?id=${recordId}`);

  await openExecutionEventMenu(page);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const eventConfirm = page.getByRole("dialog", { name: "删除成交或动作记录" });
  await expect(eventConfirm).toBeVisible();
  await eventConfirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(eventConfirm).toBeHidden();

  await openExecutionEventMenu(page);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteRequest = page.waitForRequest((request) =>
    request.method() === "DELETE"
      && new URL(request.url()).pathname === `/api/quant/decision/trade-records/${recordId}/execution-events/execution-event-1`,
  );
  await eventConfirm.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteRequest;
  await expect(page.locator('summary[aria-label="成交记录操作"]')).toHaveCount(0);

  await openTradeRecordDetailMenu(page);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "删除交易追踪单" })).toBeVisible();
});

test("同一页面的历史演练删除也使用应用内二次确认", async ({ page }) => {
  const historyItem = {
    id: "replay-history-1",
    reviewState: "active",
    interval: "1d",
    gameLength: 20,
    revealed: false,
    progress: { current: 10, total: 20 },
  };
  await page.route("**/api/quant/replay/sessions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/quant/replay/sessions") {
      await route.fulfill({ json: { items: [historyItem], total: 1, page: 1, pageSize: 20 } });
      return;
    }
    if (url.pathname === "/api/quant/replay/sessions/replay-history-1") {
      await route.fulfill({ json: { session: historyItem } });
      return;
    }
    await route.fallback();
  });

  await page.goto(`${baseUrl}/decision/trade-records`);
  await page.getByRole("button", { name: "历史演练", exact: true }).click();
  await openReplayHistoryMenu(page);
  await page.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "删除演练记录" })).toBeVisible();
});
