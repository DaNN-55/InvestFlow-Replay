import { expect, test } from "@playwright/test";
import { startOrderTestServer } from "../../../backend/src/test-support/order-server.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("an advance and its 409 recovery stay locked through the real temporary backend", async ({ page, request }) => {
  const fixture = await startOrderTestServer();
  const advanceStarted = deferred(), advanceReply = deferred();
  const syncStarted = deferred(), syncReply = deferred();
  const path = "/api/quant/replay/sessions";
  try {
    const created = await request.post(`${fixture.url}${path}`, { data: { interval: "hybrid", gameLength: 20 } });
    expect(created.status()).toBe(201);
    const { session } = await created.json();
    const sessionPath = `${path}/${session.id}`;
    const advances = [];
    let synchronizeConflict = false;
    await page.route("**/api/**", async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === `${sessionPath}/advance` && req.method() === "POST") {
        advances.push(req.postDataJSON());
        if (advances.length === 1) {
          advanceStarted.resolve();
          await advanceReply.promise;
        }
      }
      if (url.pathname === sessionPath && req.method() === "GET" && synchronizeConflict) {
        syncStarted.resolve();
        await syncReply.promise;
      }
      const response = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
      if (url.pathname === `${sessionPath}/advance` && response.status() === 409) synchronizeConflict = true;
      await route.fulfill({ response });
    });
    const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
    await page.goto(`${base}/decision/market-replay?session=${session.id}`);
    const playback = page.getByRole("region", { name: "回放控制", exact: true });
    const advance = playback.getByRole("button", { name: "推进 5 分钟", exact: true });
    await advance.click();
    await advanceStarted.promise;
    await expect(advance).toBeDisabled();
    await expect(playback.getByRole("button", { name: "结束本局", exact: true })).toBeDisabled();
    await expect(playback.getByRole("button", { name: "新开一局", exact: true })).toBeDisabled();
    await page.keyboard.press("Space");
    expect(advances).toHaveLength(1);
    advanceReply.resolve();
    await expect(advance).toBeEnabled();
    const current = async () => (await (await request.get(`${fixture.url}${sessionPath}`)).json()).session;
    const afterFirst = await current();
    expect(afterFirst.revision).toBe(session.revision + 1);

    const otherWrite = await request.post(`${fixture.url}${sessionPath}/advance`, {
      data: { actionId: crypto.randomUUID(), expectedRevision: afterFirst.revision, mode: "minute" },
    });
    expect(otherWrite.status()).toBe(200);
    const authoritative = (await otherWrite.json()).session;
    await advance.click();
    await syncStarted.promise;
    await expect(advance).toBeDisabled();
    await expect(playback).toBeVisible();
    await expect(playback.getByRole("button", { name: "新开一局", exact: true })).toBeDisabled();
    expect(advances).toHaveLength(2);
    expect(advances[1].expectedRevision).toBe(afterFirst.revision);
    syncReply.resolve();
    await expect(advance).toBeEnabled();
    await expect(page.getByRole("status").filter({ hasText: "已刷新到最新进度" })).toBeVisible();
    expect(await current()).toEqual(authoritative);
    expect(advances).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath("operation-recovered-desktop.png") });
    await page.setViewportSize({ width: 390, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await playback.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("operation-recovered-mobile.png") });
    await page.reload();
    await expect(advance).toBeEnabled();
    expect(await current()).toEqual(authoritative);
    expect(advances).toHaveLength(2);
  } finally {
    advanceReply.resolve();
    syncReply.resolve();
    try { await page.unrouteAll({ behavior: "wait" }); }
    finally { await fixture.close(); }
  }
});
