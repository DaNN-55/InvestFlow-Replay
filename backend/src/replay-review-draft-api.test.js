import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";
import { createDatabase } from "./db.js";

function privateScenario(gameLength) {
  return {
    sourceDataVersion: "draft-source-v1",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "浦发银行",
    observationBars: 250,
    gameLength,
    bars: Array.from({ length: 250 + gameLength }, (_, index) => ({
      sequence: index + 1,
      tradeDate: `2024-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
      open: 10 + index,
      high: 11 + index,
      low: 9 + index,
      close: 10.5 + index,
      volume: 1000 + index,
      amount: 10000 + index,
      weekIndex: Math.floor(index / 5) + 1,
      monthIndex: Math.floor(index / 20) + 1,
    })),
  };
}

function blindReview(overrides = {}) {
  return {
    strategyName: "趋势突破",
    thesis: "价格突破整理区间，量能同步放大，预期后续延续上行。",
    tradePlan: "突破后分批买入，次日确认强度，弱于预期则停止加仓。",
    riskPlan: "跌回整理区间立即止损，单次风险不超过计划范围。",
    confidence: 4,
    trendView: "bullish",
    outlook: "range",
    reasonTags: ["突破", "突破", "放量"],
    stopLossPrice: null,
    invalidationRule: {
      basis: "close",
      operator: "lte",
      threshold: 9.8,
      note: "收盘跌破则判断失效",
    },
    ...overrides,
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
    strategyAdjustment: "",
  };
}

describe("replay review drafts API", () => {
  let app;
  let root;
  let dbPath;
  let engineServer;

  before(async () => {
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
    root = mkdtempSync(join(tmpdir(), "investflow-review-draft-"));
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

  after(async () => {
    app.dispose();
    await new Promise((resolve) => engineServer.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it("autosaves partial drafts without changing the session revision", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 1 })
      .expect(201);
    const sessionId = created.body.session.id;
    const partialDraft = {
      thesis: "半成品",
      trendView: "",
      reasonTags: [],
      confidence: null,
      stopLossPrice: null,
      invalidationRule: {
        threshold: null,
        note: "仍在填写条件",
      },
    };
    const saved = await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({ draft: partialDraft, expectedRevision: 0 })
      .expect(200);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.draft.stage, "blind");
    assert.deepEqual(saved.body.draft.data, partialDraft);
    assert.equal(saved.body.draft.revision, 1);
    assert.equal(typeof saved.body.draft.updatedAt, "string");

    const latestDraft = {
      ...partialDraft,
      thesis: "最新半成品",
    };
    const latest = await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({ draft: latestDraft, expectedRevision: 1 })
      .expect(200);
    assert.equal(latest.body.draft.revision, 2);
    await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({
        draft: { ...partialDraft, thesis: "迟到的旧半成品" },
        expectedRevision: 1,
      })
      .expect(409);

    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(detail.body.session.revision, 0);
    assert.deepEqual(detail.body.session.reviewDrafts.blind, {
      stage: "blind",
      data: latestDraft,
      revision: 2,
      updatedAt: latest.body.draft.updatedAt,
    });
    assert.equal(detail.body.session.reviewDrafts.post, null);
    const history = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    const historyItem = history.body.items.find((item) => item.id === sessionId);
    assert.equal(Object.hasOwn(historyItem, "reviewDrafts"), false);

    for (const body of [
      {},
      { draft: {}, extra: true },
      { draft: { unknown: true } },
      { draft: { thesis: 123 } },
      { draft: { thesis: "判".repeat(2001) } },
      { draft: { stopLossPrice: 0 } },
      { draft: { invalidationRule: { threshold: -1 } } },
    ]) {
      await request(app)
        .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
        .send({ ...body, expectedRevision: 2 })
        .expect(400);
    }
    await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/post/draft`)
      .send({ draft: { outcome: "partial" }, expectedRevision: 0 })
      .expect(409);

    const directDb = new DatabaseSync(dbPath);
    directDb
      .prepare(
        `
        INSERT INTO replay_review_drafts (
          session_id, stage, draft_json, updated_at
        ) VALUES (?, 'post', ?, ?)
        `,
      )
      .run(
        sessionId,
        JSON.stringify({ lessons: "POST-DRAFT-SECRET" }),
        "2024-01-01T00:00:00.000Z",
      );
    directDb.close();
    const hidden = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(hidden.body.session.reviewDrafts.post, null);
    assert.equal(JSON.stringify(hidden.body).includes("POST-DRAFT-SECRET"), false);
    const hiddenHistory = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    assert.equal(
      JSON.stringify(hiddenHistory.body).includes("POST-DRAFT-SECRET"),
      false,
    );
    assert.equal(
      hiddenHistory.body.items.some((item) =>
        Object.hasOwn(item, "reviewDrafts"),
      ),
      false,
    );

    const deleted = await request(app)
      .delete(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({ expectedRevision: 2 })
      .expect(200);
    assert.deepEqual(deleted.body, { deleted: true, revision: 3 });
    const afterDelete = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(
      afterDelete.body.session.reviewDrafts.blind.stage,
      "blind",
    );
    assert.equal(afterDelete.body.session.reviewDrafts.blind.data, null);
    assert.equal(afterDelete.body.session.reviewDrafts.blind.revision, 3);
    assert.equal(
      typeof afterDelete.body.session.reviewDrafts.blind.updatedAt,
      "string",
    );
    const deletedAgain = await request(app)
      .delete(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({ expectedRevision: 3 })
      .expect(200);
    assert.deepEqual(deletedAgain.body, { deleted: false, revision: 3 });
  });

  it("validates structured finals, clears drafts, and preserves fields in corrections", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 2 })
      .expect(201);
    const sessionId = created.body.session.id;
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "draft-finish", expectedRevision: 0 })
      .expect(200);
    await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({
        draft: { thesis: "完成后仍可继续编辑半成品" },
        expectedRevision: 0,
      })
      .expect(200);

    for (const invalid of [
      { trendView: "" },
      { outlook: "sideways" },
      { reasonTags: [] },
      {
        stopLossPrice: null,
        invalidationRule: {
          basis: "close",
          operator: "lte",
          threshold: 0,
        },
      },
    ]) {
      await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
        .send({
          actionId: `invalid-final-${Object.keys(invalid).join("-")}`,
          expectedRevision: finished.body.session.revision,
          ...blindReview(invalid),
        })
        .expect(400);
    }

    const predictionFreeBlind = blindReview();
    delete predictionFreeBlind.trendView;
    delete predictionFreeBlind.outlook;
    const savedBlind = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "structured-final",
        expectedRevision: finished.body.session.revision,
        ...predictionFreeBlind,
      })
      .expect(200);
    assert.deepEqual(savedBlind.body.session.review.blindReview.reasonTags, [
      "突破",
      "放量",
    ]);
    assert.equal("trendView" in savedBlind.body.session.review.blindReview, false);
    assert.equal("outlook" in savedBlind.body.session.review.blindReview, false);
    assert.equal(savedBlind.body.session.reviewDrafts.blind, null);
    await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/blind/draft`)
      .send({ draft: { thesis: "不得重建" }, expectedRevision: 1 })
      .expect(409);

    const correction = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send({
        actionId: "structured-correction",
        expectedRevision: savedBlind.body.session.revision,
        changeNote: "修正趋势判断与失效阈值",
        ...blindReview({
          trendView: "bearish",
          outlook: "uncertain",
          reasonTags: ["破位"],
          invalidationRule: {
            basis: "close",
            operator: "gte",
            threshold: 11.2,
          },
        }),
      })
      .expect(200);
    assert.equal(
      correction.body.correction.fullReviewSnapshot.trendView,
      "bearish",
    );
    assert.equal(
      correction.body.correction.fullReviewSnapshot.invalidationRule.threshold,
      11.2,
    );
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({
        actionId: "structured-reveal",
        expectedRevision: correction.body.session.revision,
      })
      .expect(200);

    const postDraft = {
      outcome: "",
      executionReview: "半成品",
      disciplineScore: null,
    };
    const savedPostDraft = await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/post/draft`)
      .send({ draft: postDraft, expectedRevision: 0 })
      .expect(200);
    assert.deepEqual(savedPostDraft.body.draft.data, postDraft);
    const afterPostDraft = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(
      afterPostDraft.body.session.revision,
      revealed.body.session.revision,
    );
    assert.deepEqual(afterPostDraft.body.session.reviewDrafts.post, {
      stage: "post",
      data: postDraft,
      revision: 1,
      updatedAt: savedPostDraft.body.draft.updatedAt,
    });

    const savedPost = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "post-final-clears-draft",
        expectedRevision: revealed.body.session.revision,
        ...postReview(),
      })
      .expect(200);
    assert.equal(savedPost.body.session.reviewDrafts.post, null);
    await request(app)
      .put(`/api/quant/replay/sessions/${sessionId}/reviews/post/draft`)
      .send({ draft: postDraft, expectedRevision: 1 })
      .expect(409);
  });
});

it("rejects stale draft revisions even after a delete", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-draft-cas-"));
  const dbPath = join(root, "draft-cas.sqlite");
  const database = createDatabase(dbPath);
  const snapshot = privateScenario(20);
  const baseSession = {
    id: "draft-cas-session",
    sourceDataVersion: snapshot.sourceDataVersion,
    gameLength: 20,
    observationBars: 250,
    revealedFutureBars: 0,
    status: "active",
    revision: 0,
    snapshot,
    account: {
      initialCapital: 100000,
      cash: 100000,
      positionQuantity: 0,
      availableQuantity: 0,
      lockedQuantity: 0,
      averageCost: 0,
      realizedPnl: 0,
      totalFees: 0,
    },
    costConfig: {
      commissionRate: 0.0003,
      minCommission: 5,
      stampTaxRate: 0.0005,
      transferFeeRate: 0.00001,
      slippageBps: 0,
    },
    trainingConfig: { mode: "free" },
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  database.createReplaySession(baseSession);

  const first = database.saveReplayReviewDraft({
    sessionId: "draft-cas-session",
    stage: "blind",
    draft: { thesis: "第一版" },
    expectedRevision: 0,
    updatedAt: "2026-07-30T00:01:00.000Z",
  });
  assert.equal(first.reviewDrafts.blind.revision, 1);
  const second = database.saveReplayReviewDraft({
    sessionId: "draft-cas-session",
    stage: "blind",
    draft: { thesis: "第二版" },
    expectedRevision: 1,
    updatedAt: "2026-07-30T00:02:00.000Z",
  });
  assert.equal(second.reviewDrafts.blind.revision, 2);
  assert.throws(
    () =>
      database.saveReplayReviewDraft({
        sessionId: "draft-cas-session",
        stage: "blind",
        draft: { thesis: "迟到的旧版本" },
        expectedRevision: 1,
        updatedAt: "2026-07-30T00:03:00.000Z",
      }),
    (error) =>
      error?.status === 409 &&
      error.message.includes("当前 revision 为 2"),
  );

  const deleted = database.deleteReplayReviewDraft({
    sessionId: "draft-cas-session",
    stage: "blind",
    expectedRevision: 2,
    updatedAt: "2026-07-30T00:04:00.000Z",
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.session.reviewDrafts.blind.data, null);
  assert.equal(deleted.session.reviewDrafts.blind.revision, 3);
  assert.throws(
    () =>
      database.saveReplayReviewDraft({
        sessionId: "draft-cas-session",
        stage: "blind",
        draft: { thesis: "删除前发出的首版请求" },
        expectedRevision: 0,
        updatedAt: "2026-07-30T00:05:00.000Z",
      }),
    (error) =>
      error?.status === 409 &&
      error.message.includes("当前 revision 为 3"),
  );

  const restored = database.saveReplayReviewDraft({
    sessionId: "draft-cas-session",
    stage: "blind",
    draft: { thesis: "删除后明确重建" },
    expectedRevision: 3,
    updatedAt: "2026-07-30T00:06:00.000Z",
  });
  assert.equal(restored.reviewDrafts.blind.revision, 4);
  assert.equal(
    restored.reviewDrafts.blind.data.thesis,
    "删除后明确重建",
  );

  database.createReplaySession({
    ...baseSession,
    id: "draft-delete-first-session",
    createdAt: "2026-07-30T01:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
  });
  const deletedBeforeSave = database.deleteReplayReviewDraft({
    sessionId: "draft-delete-first-session",
    stage: "blind",
    expectedRevision: 0,
    updatedAt: "2026-07-30T01:01:00.000Z",
  });
  assert.equal(deletedBeforeSave.deleted, false);
  assert.equal(deletedBeforeSave.revision, 1);
  assert.equal(
    deletedBeforeSave.session.reviewDrafts.blind.data,
    null,
  );
  assert.throws(
    () =>
      database.saveReplayReviewDraft({
        sessionId: "draft-delete-first-session",
        stage: "blind",
        draft: { thesis: "删除请求之前发出的旧保存" },
        expectedRevision: 0,
        updatedAt: "2026-07-30T01:02:00.000Z",
      }),
    (error) =>
      error?.status === 409 &&
      error.message.includes("当前 revision 为 1"),
  );
  const savedAfterDelete = database.saveReplayReviewDraft({
    sessionId: "draft-delete-first-session",
    stage: "blind",
    draft: { thesis: "基于删除结果重新编辑" },
    expectedRevision: 1,
    updatedAt: "2026-07-30T01:03:00.000Z",
  });
  assert.equal(savedAfterDelete.reviewDrafts.blind.revision, 2);

  database.close();
  rmSync(root, { recursive: true, force: true });
});

it("migrates old replay databases with empty review drafts", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-draft-old-"));
  const dbPath = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE replay_sessions (
      id TEXT PRIMARY KEY,
      source_data_version TEXT NOT NULL,
      game_length INTEGER NOT NULL,
      observation_bars INTEGER NOT NULL,
      revealed_future_bars INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO replay_sessions VALUES (
      'legacy-draft', 'legacy-v1', 20, 250, 0, 'active',
      '{"bars":[]}', '2024-01-01', '2024-01-01'
    );
  `);
  legacy.close();

  const database = createDatabase(dbPath);
  assert.deepEqual(database.getReplaySession("legacy-draft").reviewDrafts, {
    blind: null,
    post: null,
  });
  assert.deepEqual(
    database.getReplaySession("legacy-draft").scoringConfig.migration,
    {
      source: "legacy_session",
      weightsSource: "replay_score_v2_fixed",
      parametersSource: "replay_score_v2_fixed",
      settlement: "pending",
    },
  );
  assert.equal(
    database.getReplaySession("legacy-draft").scenarioFingerprintVersion,
    "legacy-unidentifiable-v1",
  );
  database.close();
  rmSync(root, { recursive: true, force: true });
});
