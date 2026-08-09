import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import request from "supertest";

import { createApp } from "./app.js";

function privateScenario(gameLength = 20) {
  const bars = Array.from({ length: 250 + gameLength }, (_, index) => ({
    sequence: index + 1,
    tradeDate: `2025-03-${String(index + 1).padStart(3, "0")}`,
    open: 20 + index,
    high: 21 + index,
    low: 19 + index,
    close: 20.5 + index,
    volume: 2000 + index,
    amount: 20000 + index,
    weekIndex: Math.floor(index / 5) + 1,
    monthIndex: Math.floor(index / 20) + 1,
  }));
  return {
    sourceDataVersion: "history-source-1",
    tsCode: "300001.SZ",
    symbol: "300001",
    exchange: "SZSE",
    name: "特锐德",
    observationBars: 250,
    gameLength,
    bars,
  };
}

function assertAnonymousHistory(payload) {
  const serialized = JSON.stringify(payload);
  for (const privateValue of [
    "300001.SZ",
    "300001",
    "特锐德",
    "2025-03-001",
    "2025-03-270",
    "snapshot",
    "\"bars\"",
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
}

function blindReview(strategyName) {
  return {
    strategyName,
    thesis: "突破整理区间后量价配合，预期后续行情延续当前方向。",
    tradePlan: "确认突破有效后分批参与，走势转弱时停止增加仓位。",
    riskPlan: "跌回整理区间则退出，避免判断失效后继续扩大风险。",
    confidence: 4,
    trendView: "bullish",
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: 9.8,
    invalidationRule: null,
  };
}

function postReview() {
  return {
    outcome: "partial",
    executionReview: "执行基本符合计划，但入场确认仍有进一步优化空间。",
    mistakes: "确认条件不够完整。",
    lessons: "下一次把量价承接和风险条件逐项确认后再执行。",
    disciplineScore: 4,
    riskControlScore: 4,
    strategyAdjustment: "候选改进：增加次日承接确认，不直接修改原战法。",
  };
}

describe("replay history list API", () => {
  let app;
  let dbPath;
  let engineServer;
  let root;

  beforeEach(async () => {
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/internal/replay/scenarios") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          res.end(JSON.stringify(privateScenario(payload.gameLength)));
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-replay-history-"));
    dbPath = join(root, "workbench.sqlite");
    app = createApp({
      dbPath,
      rankingDbPath: join(root, "rankings.sqlite"),
      storageRoot: join(root, "storage"),
      workspaceRoot: root,
      tradeRecordsRoot: join(root, "trade-records"),
      engineUrl: `http://127.0.0.1:${address.port}`,
    });
  });

  afterEach(async () => {
    app.dispose();
    await new Promise((resolve) => engineServer.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("lists active sessions as lightweight anonymous summaries", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 701 })
      .expect(201);

    const response = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.page, 1);
    assert.equal(response.body.pageSize, 20);
    assert.equal(response.body.items.length, 1);
    assert.deepEqual(response.body.items[0], {
      id: created.body.session.id,
      interval: "1d",
      gameLength: 20,
      progress: {
        current: 0,
        total: 20,
      },
      status: "active",
      completionReason: null,
      revealed: false,
      reviewState: "active",
      blindReview: null,
      postReview: null,
      scoreCard: null,
      correctionSummary: {
        blindCount: 0,
        postCount: 0,
      },
      attemptInfo: {
        attemptNumber: 1,
        kind: "first",
        countsTowardFirstScore: true,
        sourceSessionId: null,
      },
      trainingConfig: { mode: "free" },
      createdAt: created.body.session.createdAt,
      updatedAt: created.body.session.updatedAt,
    });
    assertAnonymousHistory(response.body);
  });

  it("lists no-opportunity sessions as active-empty decisions instead of pending reviews", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 702 })
      .expect(201);
    await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({
        actionId: "history-no-opportunity",
        expectedRevision: 0,
        reason: "no_opportunity",
      })
      .expect(200);

    const skipped = await request(app)
      .get("/api/quant/replay/sessions?state=skipped")
      .expect(200);
    assert.equal(skipped.body.total, 1);
    assert.equal(skipped.body.items[0].reviewState, "skipped");
    assert.equal(skipped.body.items[0].completionReason, "no_opportunity");

    const awaitingBlind = await request(app)
      .get("/api/quant/replay/sessions?state=awaiting_blind")
      .expect(200);
    assert.equal(awaitingBlind.body.total, 0);
  });

  it("filters, sorts and paginates review states without leaking hidden identity", async () => {
    async function createSession(seed) {
      return (
        await request(app)
          .post("/api/quant/replay/sessions")
          .send({ gameLength: 20, seed })
          .expect(201)
      ).body.session;
    }

    const active = await createSession(710);
    const awaitingBlindCreated = await createSession(711);
    const awaitingBlind = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${awaitingBlindCreated.id}/finish`,
        )
        .send({
          actionId: "history-awaiting-blind-finish",
          expectedRevision: 0,
        })
        .expect(200)
    ).body.session;

    const awaitingRevealCreated = await createSession(712);
    const awaitingRevealFinished = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${awaitingRevealCreated.id}/finish`,
        )
        .send({
          actionId: "history-awaiting-reveal-finish",
          expectedRevision: 0,
        })
        .expect(200)
    ).body.session;
    const awaitingReveal = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${awaitingRevealCreated.id}/reviews/blind`,
        )
        .send({
          actionId: "history-awaiting-reveal-blind",
          expectedRevision: awaitingRevealFinished.revision,
          ...blindReview("等待揭晓战法"),
        })
        .expect(200)
    ).body.session;

    const awaitingPostCreated = await createSession(713);
    const awaitingPostFinished = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${awaitingPostCreated.id}/finish`,
        )
        .send({
          actionId: "history-awaiting-post-finish",
          expectedRevision: 0,
        })
        .expect(200)
    ).body.session;
    const awaitingPostBlind = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${awaitingPostCreated.id}/reviews/blind`,
        )
        .send({
          actionId: "history-awaiting-post-blind",
          expectedRevision: awaitingPostFinished.revision,
          ...blindReview("等待复盘战法"),
        })
        .expect(200)
    ).body.session;
    const awaitingPost = (
      await request(app)
        .post(`/api/quant/replay/sessions/${awaitingPostCreated.id}/reveal`)
        .send({
          actionId: "history-awaiting-post-reveal",
          expectedRevision: awaitingPostBlind.revision,
        })
        .expect(200)
    ).body.session;

    const reviewedCreated = await createSession(714);
    const reviewedFinished = (
      await request(app)
        .post(`/api/quant/replay/sessions/${reviewedCreated.id}/finish`)
        .send({
          actionId: "history-reviewed-finish",
          expectedRevision: 0,
        })
        .expect(200)
    ).body.session;
    const reviewedBlind = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${reviewedCreated.id}/reviews/blind`,
        )
        .send({
          actionId: "history-reviewed-blind",
          expectedRevision: reviewedFinished.revision,
          ...blindReview("已评分战法"),
        })
        .expect(200)
    ).body.session;
    const reviewedReveal = (
      await request(app)
        .post(`/api/quant/replay/sessions/${reviewedCreated.id}/reveal`)
        .send({
          actionId: "history-reviewed-reveal",
          expectedRevision: reviewedBlind.revision,
        })
        .expect(200)
    ).body.session;
    const reviewed = (
      await request(app)
        .post(
          `/api/quant/replay/sessions/${reviewedCreated.id}/reviews/post`,
        )
        .send({
          actionId: "history-reviewed-post",
          expectedRevision: reviewedReveal.revision,
          ...postReview(),
        })
        .expect(200)
    ).body.session;

    const timestamps = new Map([
      [active.id, "2026-07-30T00:00:01.000Z"],
      [awaitingBlind.id, "2026-07-30T00:00:02.000Z"],
      [awaitingReveal.id, "2026-07-30T00:00:03.000Z"],
      [awaitingPost.id, "2026-07-30T00:00:04.000Z"],
      [reviewed.id, "2026-07-30T00:00:05.000Z"],
    ]);
    const orderingDb = new DatabaseSync(dbPath);
    const updateTimestamp = orderingDb.prepare(
      "UPDATE replay_sessions SET updated_at = ? WHERE id = ?",
    );
    for (const [id, timestamp] of timestamps) {
      updateTimestamp.run(timestamp, id);
    }
    orderingDb.close();

    const all = await request(app)
      .get("/api/quant/replay/sessions?state=all&page=1&pageSize=10")
      .expect(200);
    assert.equal(all.body.total, 5);
    assert.deepEqual(
      all.body.items.map((item) => item.id),
      [
        reviewed.id,
        awaitingPost.id,
        awaitingReveal.id,
        awaitingBlind.id,
        active.id,
      ],
    );
    assert.deepEqual(
      all.body.items.map((item) => item.reviewState),
      [
        "reviewed",
        "awaiting_post",
        "awaiting_reveal",
        "awaiting_blind",
        "active",
      ],
    );

    for (const item of all.body.items.filter((entry) => !entry.revealed)) {
      assertAnonymousHistory(item);
      assert.equal(Object.hasOwn(item, "reveal"), false);
    }
    const reviewedItem = all.body.items[0];
    assert.deepEqual(reviewedItem.reveal, {
      tsCode: "300001.SZ",
      symbol: "300001",
      exchange: "SZSE",
      name: "特锐德",
      startDate: "2025-03-001",
      endDate: "2025-03-270",
    });
    assert.deepEqual(
      reviewedItem.blindReview,
      blindReview("已评分战法"),
    );
    assert.deepEqual(reviewedItem.postReview, {
      ...postReview(),
      strategyAdjustment: "",
    });
    assert.deepEqual(reviewedItem.scoreCard, reviewed.scoreCard);
    assert.equal(
      all.body.items.find((item) => item.id === awaitingPost.id).scoreCard,
      null,
    );

    for (const state of [
      "active",
      "awaiting_blind",
      "awaiting_reveal",
      "awaiting_post",
      "reviewed",
    ]) {
      const filtered = await request(app)
        .get(`/api/quant/replay/sessions?state=${state}`)
        .expect(200);
      assert.equal(filtered.body.total, 1, state);
      assert.equal(filtered.body.items[0].reviewState, state);
    }

    const firstPage = await request(app)
      .get("/api/quant/replay/sessions?page=1&pageSize=2")
      .expect(200);
    const secondPage = await request(app)
      .get("/api/quant/replay/sessions?page=2&pageSize=2")
      .expect(200);
    assert.deepEqual(
      firstPage.body.items.map((item) => item.id),
      [reviewed.id, awaitingPost.id],
    );
    assert.deepEqual(
      secondPage.body.items.map((item) => item.id),
      [awaitingReveal.id, awaitingBlind.id],
    );
    assert.equal(firstPage.body.total, 5);
    assert.equal(secondPage.body.page, 2);
    assert.equal(secondPage.body.pageSize, 2);

    const revealedKeyword = await request(app)
      .get(
        `/api/quant/replay/sessions?keyword=${encodeURIComponent("特锐德")}`,
      )
      .expect(200);
    assert.deepEqual(
      revealedKeyword.body.items.map((item) => item.id),
      [reviewed.id, awaitingPost.id],
    );
    const reviewKeyword = await request(app)
      .get(
        `/api/quant/replay/sessions?keyword=${encodeURIComponent("等待揭晓战法")}`,
      )
      .expect(200);
    assert.deepEqual(
      reviewKeyword.body.items.map((item) => item.id),
      [awaitingReveal.id],
    );

    for (const query of [
      "state=unknown",
      "page=0",
      "page=1.5",
      "pageSize=0",
      "pageSize=101",
      `keyword=${"x".repeat(121)}`,
    ]) {
      await request(app)
        .get(`/api/quant/replay/sessions?${query}`)
        .expect(400);
    }
  });
});
