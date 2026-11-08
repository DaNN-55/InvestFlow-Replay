import { expect, test } from "@playwright/test";
import { startOrderTestServer } from "../../../backend/src/test-support/order-server.js";
import { buildReplayBlindReviewPayload } from "../../src/utils/replayReviewPresentation.js";

const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const blindPayload = () => buildReplayBlindReviewPayload({ thesis: "完整核心判断", tradePlan: "完整交易计划", riskPlan: "完整风险计划", confidence: 3, reasonTags: ["回踩"] });

async function openReview(page, request, { post = false, fault } = {}) {
  const fixture = await startOrderTestServer(), requests = [];
  try {
    const path = "/api/quant/replay/sessions";
    const created = await request.post(`${fixture.url}${path}`, { data: { interval: "hybrid", gameLength: 20 } });
    expect(created.status()).toBe(201);
    let { session } = await created.json();
    const url = `${fixture.url}${path}/${session.id}`;
    for (const [suffix, body] of [["finish", {}], ...(post ? [["reviews/blind", blindPayload()], ["reveal", {}]] : [])]) {
      const response = await request.post(`${url}/${suffix}`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision, ...body } });
      expect(response.status()).toBe(200); session = (await response.json()).session;
    }
    await page.route("**/api/**", async route => {
      const req = route.request(), target = new URL(req.url());
      const row = { method: req.method(), path: target.pathname, body: req.postDataJSON() };
      requests.push(row);
      if (fault && await fault(route, row, fixture.url)) return;
      await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${target.pathname}${target.search}` }) });
    });
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    await page.getByRole("button", { name: post ? "查看复盘" : "填写揭晓前盲评", exact: true }).click();
    const review = page.getByRole("dialog", { name: "两阶段复盘 · 决策记录与评分", exact: true });
    return { session, review, requests, read: async () => (await (await request.get(url)).json()).session,
      close: async () => { try { await page.unrouteAll({ behavior: "wait" }); } finally { await fixture.close(); } } };
  } catch (error) { await fixture.close(); throw error; }
}
async function fillBlind(review, prefix = "完整") {
  await review.getByRole("checkbox", { name: "回踩", exact: true }).check();
  await review.getByPlaceholder("你看到了什么，为什么做出这个判断？").fill(`${prefix}核心判断`);
  await review.getByPlaceholder("计划如何开仓、持有、减仓或空仓？").fill(`${prefix}交易计划`);
  await review.getByPlaceholder("什么情况说明判断错误，如何控制损失？").fill(`${prefix}风险计划`);
}

test("deleting while typing serializes writes, keeps the cursor, and reopens the newest draft", async ({ page, request }) => {
  const entered = deferred(), release = deferred();
  const c = await openReview(page, request, { fault: async (_route, row) => {
    if (row.method === "DELETE" && row.path.endsWith("/reviews/blind/draft")) { entered.resolve(); await release.promise; }
    return false;
  } });
  try {
    await fillBlind(c.review);
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("完整核心判断");
    const first = await c.read();
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await c.review.getByRole("button", { name: "清空盲评草稿", exact: true }).click();
    await entered.promise;
    await fillBlind(c.review, "删除之后的新");
    const field = c.review.getByPlaceholder("你看到了什么，为什么做出这个判断？");
    await field.evaluate(el => { el.focus(); el.setSelectionRange(4, 4); });
    const puts = () => c.requests.filter(row => row.method === "PUT" && row.path.endsWith("/reviews/blind/draft"));
    const count = puts().length;
    await page.clock.runFor(650);
    expect(puts()).toHaveLength(count);
    release.resolve();
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("删除之后的新核心判断");
    expect(puts().at(-1).body.expectedRevision).toBe(first.reviewDrafts.blind.revision + 1);
    expect(await field.evaluate(el => el.selectionStart)).toBe(4);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "填写揭晓前盲评", exact: true }).click();
    await expect(field).toHaveValue("删除之后的新核心判断");
  } finally { release.resolve(); await c.close(); }
});

test("final submission takes over a pending deletion and freezes the click snapshot once", async ({ page, request }) => {
  const entered = deferred(), release = deferred();
  const c = await openReview(page, request, { fault: async (_route, row) => {
    if (row.method === "DELETE" && row.path.endsWith("/reviews/blind/draft")) { entered.resolve(); await release.promise; }
    return false;
  } });
  try {
    await fillBlind(c.review);
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("完整核心判断");
    await c.review.getByRole("button", { name: "清空盲评草稿", exact: true }).click(); await entered.promise;
    await fillBlind(c.review, "点击时的");
    const save = c.review.getByRole("button", { name: "保存并冻结整局盲评", exact: true });
    await save.evaluate(el => { el.click(); el.click(); });
    await expect(c.review.getByPlaceholder("你看到了什么，为什么做出这个判断？")).toBeDisabled();
    const finals = () => c.requests.filter(row => row.method === "POST" && row.path.endsWith("/reviews/blind"));
    expect(finals()).toHaveLength(0);
    release.resolve();
    await expect(c.review.locator("form.replay-review__form")).toHaveCount(0);
    const saved = await c.read();
    expect(saved.review.blindReview.thesis).toBe("点击时的核心判断");
    expect(saved.reviewDrafts.blind).toBeNull();
    expect(finals()).toHaveLength(1);
  } finally { release.resolve(); await c.close(); }
});

for (const stage of ["blind", "post"]) for (const failRead of [false, true]) {
  test(`${stage} committed final with a lost response ${failRead ? "waits for a manual read" : "locks after read confirmation"}`, async ({ page, request }) => {
    let lost = false, blockRead = false;
    const checking = deferred(), releaseCheck = deferred();
    const c = await openReview(page, request, { post: stage === "post", fault: async (route, row, server) => {
      if (!lost && row.method === "POST" && row.path.endsWith(`/reviews/${stage}`)) {
        const response = await route.fetch({ url: `${server}${row.path}` });
        expect(response.status()).toBe(200);
        lost = true; blockRead = failRead;
        await route.abort(); return true;
      }
      if (blockRead && row.method === "GET" && /\/sessions\/[^/]+$/.test(row.path)) { await route.abort(); return true; }
      if (lost && !failRead && row.method === "GET" && /\/sessions\/[^/]+$/.test(row.path)) { checking.resolve(); await releaseCheck.promise; }
      return false;
    } });
    try {
      if (stage === "blind") await fillBlind(c.review);
      else {
        await c.review.getByPlaceholder("实际执行和原计划有哪些一致或偏离？").fill("完整执行复盘");
        await c.review.getByPlaceholder("没有明显错误时可填写“无”").fill("无");
        await c.review.getByPlaceholder("下一次遇到类似行情，你会保留或改变什么？").fill("完整经验总结");
      }
      await c.review.getByRole("button", { name: stage === "blind" ? "保存并冻结整局盲评" : "保存原始复盘并评分", exact: true }).click();
      if (failRead) {
        await expect(c.review.getByText("提交结果尚未确认，请重新核对后继续。", { exact: true })).toBeVisible();
        await expect(c.review.locator("textarea").first()).toBeDisabled();
        const before = await c.read();
        await c.review.getByRole("button", { name: "重新核对提交结果", exact: true }).scrollIntoViewIfNeeded();
        await c.review.screenshot({ path: test.info().outputPath(`${stage}-confirmation-desktop.png`) });
        await page.setViewportSize({ width: 390, height: 850 });
        await c.review.getByRole("button", { name: "重新核对提交结果", exact: true }).scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await c.review.screenshot({ path: test.info().outputPath(`${stage}-confirmation-mobile.png`) });
        blockRead = false;
        await c.review.getByRole("button", { name: "重新核对提交结果", exact: true }).click();
        await expect(c.review.locator("form.replay-review__form")).toHaveCount(0);
        expect(await c.read()).toEqual(before);
      } else {
        await checking.promise;
        await expect(c.review).toBeVisible();
        await expect(c.review.locator("textarea").first()).toBeDisabled();
        releaseCheck.resolve();
        await expect(c.review.locator("form.replay-review__form")).toHaveCount(0);
      }
      const finals = c.requests.filter(row => row.method === "POST" && row.path.endsWith(`/reviews/${stage}`));
      expect(finals).toHaveLength(1);
      const saved = await c.read();
      expect(saved.review[stage === "blind" ? "blindSaved" : "postSaved"]).toBe(true);
      expect(saved.reviewDrafts[stage]).toBeNull();
      const writes = c.requests.filter(row => row.method !== "GET").length;
      await page.clock.install(); await page.clock.runFor(1200);
      expect(c.requests.filter(row => row.method !== "GET")).toHaveLength(writes);
    } finally { blockRead = false; releaseCheck.resolve(); await c.close(); }
  });
}

test("an uncommitted final failure preserves text and resumes draft saving without a final retry", async ({ page, request }) => {
  const c = await openReview(page, request, { fault: async (route, row) => {
    if (row.method === "POST" && row.path.endsWith("/reviews/blind")) {
      await route.fulfill({ status: 503, json: { error: { message: "temporary failure" } } }); return true;
    }
    return false;
  } });
  try {
    await fillBlind(c.review);
    await c.review.getByRole("button", { name: "保存并冻结整局盲评", exact: true }).click();
    await expect(c.review.getByText("正式记录尚未保存，内容已保留，请确认后重新提交。", { exact: true })).toBeVisible();
    await expect(c.review.getByPlaceholder("你看到了什么，为什么做出这个判断？")).toBeEnabled();
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("完整核心判断");
    expect((await c.read()).review.blindSaved).toBe(false);
    expect(c.requests.filter(row => row.method === "POST" && row.path.endsWith("/reviews/blind"))).toHaveLength(1);
  } finally { await c.close(); }
});

test("an unsaved final confirmation recovers the CAS revision of a draft committed with a lost response", async ({ page, request }) => {
  let lostDraft = false;
  const c = await openReview(page, request, { fault: async (route, row, server) => {
    if (!lostDraft && row.method === "PUT" && row.path.endsWith("/reviews/blind/draft")) {
      const response = await route.fetch({ url: `${server}${row.path}` });
      expect(response.status()).toBe(200);
      lostDraft = true;
      await route.abort(); return true;
    }
    if (row.method === "POST" && row.path.endsWith("/reviews/blind")) {
      await route.fulfill({ status: 503, json: { error: { message: "temporary failure" } } }); return true;
    }
    return false;
  } });
  try {
    await fillBlind(c.review);
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("完整核心判断");
    const committed = await c.read();
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
    await fillBlind(c.review, "点击时的");
    await c.review.getByRole("button", { name: "保存并冻结整局盲评", exact: true }).click();
    await expect(c.review.getByText("正式记录尚未保存，内容已保留，请确认后重新提交。", { exact: true })).toBeVisible();
    const field = c.review.getByPlaceholder("你看到了什么，为什么做出这个判断？");
    await expect(field).toHaveValue("点击时的核心判断");
    await field.evaluate(el => { el.focus(); el.setSelectionRange(3, 3); });
    await page.clock.runFor(650);
    await expect.poll(async () => (await c.read()).reviewDrafts?.blind?.data?.thesis).toBe("点击时的核心判断");
    const puts = c.requests.filter(row => row.method === "PUT" && row.path.endsWith("/reviews/blind/draft"));
    expect(puts).toHaveLength(2);
    expect(puts[1].body.expectedRevision).toBe(committed.reviewDrafts.blind.revision);
    expect(await field.evaluate(el => el.selectionStart)).toBe(3);
    expect((await c.read()).review.blindSaved).toBe(false);
    expect(c.requests.filter(row => row.method === "POST" && row.path.endsWith("/reviews/blind"))).toHaveLength(1);
  } finally { await c.close(); }
});
