import { expect, test } from "@playwright/test";
import { startAnalyticsTestServer } from "../../../backend/src/test-support/analytics-server.js";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
let fixture;
test.beforeAll(async () => { fixture = await startAnalyticsTestServer(); });
test.afterAll(async () => { await fixture?.close(); });
async function connect(page) {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}
async function openAnalysis(page) {
  await page.goto(`${baseUrl}/decision/trade-records`);
  await page.getByRole("button", { name: "演练记录", exact: true }).click();
  await page.getByRole("button", { name: "A股首次分析", exact: true }).click();
  return page.getByRole("region", { name: "跨会话训练分析", exact: true });
}

test("真实分析独立分组和筛选，空样本不伪造零收益，窄屏无横向溢出", async ({ page }) => {
  await connect(page);
  let analyticsRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/quant/replay/analytics") analyticsRequests++; });
  const analysis = await openAnalysis(page);
  const controls = analysis.locator(".ql-ui-card");
  const filterRow = analysis.locator(".training-analytics__filters");
  await expect(filterRow.getByRole("group", { name: "创建日期", exact: true })).toHaveCount(1);
  await expect(filterRow.locator("[title]")).toHaveCount(0);
  await expect(filterRow.locator("legend")).toHaveCount(0);
  for (const name of ["练习周期", "练习长度", "股票板块"]) {
    await expect(filterRow.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(controls.getByRole("button", { name: "A股首次分析", exact: true })).toBeVisible();
  await expect(controls.getByLabel("创建开始日期")).toBeVisible();
  await expect(controls.getByRole("button", { name: "更新分析", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "A股首次分析", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(analysis.locator(".training-analytics__summary")).toContainText(/2\s*次练习/u);
  await expect(analysis.getByRole("region", { name: "单次收益率分布" })).toContainText("1 次");
  await expect(analysis.getByText("暂无样本", { exact: true })).toBeVisible();
  await filterRow.screenshot({ path: test.info().outputPath("first-analysis-filters-desktop.png") });
  await page.getByRole("button", { name: "A股复练分析", exact: true }).click();
  await expect(controls.getByRole("button", { name: "A股复练分析", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(controls.getByLabel("创建开始日期")).toBeVisible();
  await expect(analysis.getByRole("region", { name: "单次收益率分布" })).toContainText("2 次");
  await filterRow.screenshot({ path: test.info().outputPath("retrain-analysis-filters-desktop.png") });
  await analysis.getByLabel("练习长度").selectOption("20");
  await page.getByRole("button", { name: "A股首次分析", exact: true }).click();
  await expect(analysis.getByLabel("练习长度")).toHaveValue("20");
  await expect(analysis.getByRole("region", { name: "单次收益率分布" })).toContainText("1 次");
  await page.getByRole("button", { name: "A股复练分析", exact: true }).click();
  expect(analyticsRequests).toBe(1);
  await analysis.getByLabel("练习周期").selectOption("1m");
  await expect(analysis.getByLabel("练习长度")).toHaveValue("all");
  await analysis.getByLabel("练习周期").selectOption("all");
  await analysis.getByLabel("股票板块").selectOption("star");
  await analysis.getByRole("button", { name: "更新分析", exact: true }).click();
  await expect(analysis.locator(".training-analytics__summary")).toContainText(/0\s*次练习/u);
  await expect(analysis.getByText(/当前分组暂无已完成且揭晓的样本/u)).toBeVisible();
  await expect(analysis.getByRole("region", { name: "单次收益率分布" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await analysis.getByLabel("股票板块").selectOption("all");
  await analysis.getByRole("button", { name: "更新分析", exact: true }).click();
  await expect(analysis.getByRole("region", { name: "单次收益率分布" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await filterRow.screenshot({ path: test.info().outputPath("retrain-analysis-filters-mobile.png") });
  await page.getByRole("button", { name: "A股首次分析", exact: true }).click();
  await filterRow.screenshot({ path: test.info().outputPath("first-analysis-filters-mobile.png") });
  await analysis.getByLabel("创建开始日期").fill("2026-10-20");
  await analysis.getByLabel("创建结束日期").fill("2026-10-19");
  await analysis.getByRole("button", { name: "更新分析", exact: true }).click();
  await expect(analysis.getByRole("alert")).toContainText("开始日期不能晚于结束日期");
});

test("日期范围统一输入支持双端、单边、清空及首次复练切换保留", async ({ page }) => {
  await connect(page);
  const queries = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/quant/replay/analytics") queries.push(Object.fromEntries(url.searchParams));
  });
  const analysis = await openAnalysis(page);
  const range = analysis.getByRole("group", { name: "创建日期", exact: true });
  const from = range.getByLabel("创建开始日期", { exact: true });
  const to = range.getByLabel("创建结束日期", { exact: true });
  const apply = analysis.getByRole("button", { name: "更新分析", exact: true });
  await expect(analysis).toHaveAttribute("aria-busy", "false");
  await expect(range.getByRole("button", { name: "清空创建日期" })).toHaveCount(0);
  await from.fill("2026-10-01");
  await to.fill("2026-10-31");
  await apply.click();
  await expect(analysis).toHaveAttribute("aria-busy", "false");
  expect(queries.at(-1)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  await page.getByRole("button", { name: "A股复练分析", exact: true }).click();
  await expect(from).toHaveValue("2026-10-01");
  await expect(to).toHaveValue("2026-10-31");
  await to.fill("");
  await apply.click();
  await expect(analysis).toHaveAttribute("aria-busy", "false");
  expect(queries.at(-1).from).toBe("2026-10-01");
  expect(queries.at(-1).to).toBeUndefined();
  await from.fill("");
  await to.fill("2026-10-31");
  await apply.click();
  await expect(analysis).toHaveAttribute("aria-busy", "false");
  expect(queries.at(-1).from).toBeUndefined();
  expect(queries.at(-1).to).toBe("2026-10-31");
  const clear = range.getByRole("button", { name: "清空创建日期" });
  await clear.focus();
  await clear.press("Enter");
  await expect(from).toHaveValue("");
  await expect(to).toHaveValue("");
  await expect(from).toBeFocused();
  await apply.click();
  await expect(analysis).toHaveAttribute("aria-busy", "false");
  expect(queries.at(-1)).not.toHaveProperty("from");
  expect(queries.at(-1)).not.toHaveProperty("to");
  await page.setViewportSize({ width: 390, height: 844 });
  await from.fill("2026-10-01");
  await to.fill("2026-10-31");
  const widths = await range.evaluate(element => {
    const control = element.querySelector(".ql-ui-date-range__control");
    return { actual: control.clientWidth, content: control.scrollWidth };
  });
  expect(widths.content).toBeLessThanOrEqual(widths.actual);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await range.screenshot({ path: test.info().outputPath("date-range-filled-mobile.png") });
});

test("事后问题标签通过页面追加，分析可跳转具体样本，原评分保留且对照入口有内间距", async ({ page, request }) => {
  await connect(page);
  const id = fixture.sessionIds.retrain3;
  const original = (await (await request.get(`${fixture.url}/api/quant/replay/sessions/${id}`)).json()).session;
  await page.addInitScript(value => localStorage.setItem("investflow.replay.active-session-id", value), id);
  await page.goto(`${baseUrl}/decision/market-replay?session=${id}`);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const review = page.getByRole("dialog", { name: "本次复盘" });
  await review.locator('details.replay-review__completed-stage').nth(1).locator('summary').click();
  await review.getByRole("button", { name: "追加事后复盘修正", exact: true }).click();
  await review.getByRole("checkbox", { name: "提前入场", exact: true }).check();
  await review.getByLabel("修正说明（必填）").fill("确认本次入场时间问题，供跨会话复盘");
  const savedResponse = page.waitForResponse(response => response.url().includes(`/sessions/${id}/reviews/post/corrections`) && response.request().method() === "POST");
  await review.getByRole("button", { name: "保存为新修正", exact: true }).click();
  const saved = await savedResponse;
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(review.getByRole("button", { name: "保存为新修正", exact: true })).toHaveCount(0);
  const current = (await (await request.get(`${fixture.url}/api/quant/replay/sessions/${id}`)).json()).session;
  expect(current.scoreCard).toEqual(original.scoreCard);
  const analysis = await openAnalysis(page);
  await page.getByRole("button", { name: "A股复练分析", exact: true }).click();
  const issues = analysis.getByRole("region", { name: "用户确认的重复问题" });
  await expect(issues.getByText("提前入场", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: /查看样本/u }).click();
  await expect(page.getByRole("button", { name: "首次与复练对照", exact: true })).toBeVisible();
  await expect(page.getByLabel("关键词")).toHaveValue(id);
  const padding = await page.locator(".replay-history-detail__comparison-entry").evaluate(element => {
    const style = getComputedStyle(element);
    return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
  });
  expect(padding).toEqual([16, 16]);
});

test("分析接口失败可重试，不显示旧收益作为成功结果", async ({ page }) => {
  await connect(page);
  let failed = false;
  await page.route("**/api/quant/replay/analytics*", async route => {
    if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: { message: "训练分析暂不可用" } } }); }
    const response = await route.fetch({ url: `${fixture.url}/api/quant/replay/analytics` });
    return route.fulfill({ response });
  });
  const analysis = await openAnalysis(page);
  await expect(analysis.getByRole("alert")).toContainText("训练分析暂不可用");
  await analysis.getByRole("button", { name: "重新加载分析" }).click();
  await expect(page.getByRole("button", { name: "A股首次分析", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(analysis.locator(".training-analytics__summary")).toContainText(/2\s*次练习/u);
});
