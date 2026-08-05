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
    sourceDataVersion: "correction-source-v1",
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
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: 9.8,
    invalidationRule: null,
    ...overrides,
  };
}

function postReview(overrides = {}) {
  return {
    outcome: "partial",
    executionReview: "执行基本符合计划，但入场确认仍有进一步优化空间。",
    mistakes: "确认条件不够完整。",
    lessons: "下一次把量价承接和风险条件逐项确认后再执行。",
    disciplineScore: 4,
    riskControlScore: 4,
    strategyAdjustment: "",
    ...overrides,
  };
}

function assertBlind(payload) {
  const serialized = JSON.stringify(payload);
  for (const value of [
    "600000.SH",
    "600000",
    "浦发银行",
    "tradeDate",
    "POST-PRIVATE-CORRECTION",
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
}

describe("replay review corrections API", () => {
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
    root = mkdtempSync(join(tmpdir(), "investflow-review-correction-"));
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

  it("freezes concurrent first saves and appends immutable blind corrections", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 1 })
      .expect(201);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({ actionId: "finish-concurrent", expectedRevision: 0 })
      .expect(200);
    const sessionId = created.body.session.id;

    for (const changeNote of ["", "改".repeat(501)]) {
      await request(app)
        .post(
          `/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`,
        )
        .send({
          actionId: `invalid-note-${changeNote.length}`,
          expectedRevision: finished.body.session.revision,
          changeNote,
          ...blindReview(),
        })
        .expect(400);
    }
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send({
        actionId: "correction-before-original",
        expectedRevision: finished.body.session.revision,
        changeNote: "尚无首条记录",
        ...blindReview(),
      })
      .expect(409);

    const firstPayload = {
      actionId: "first-blind-a",
      expectedRevision: finished.body.session.revision,
      ...blindReview(),
    };
    const secondPayload = {
      actionId: "first-blind-b",
      expectedRevision: finished.body.session.revision,
      ...blindReview({ confidence: 5 }),
    };
    const [firstA, firstB] = await Promise.all([
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
        .send(firstPayload),
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
        .send(secondPayload),
    ]);
    assert.deepEqual([firstA.status, firstB.status].sort(), [200, 409]);
    const saved = firstA.status === 200 ? firstA : firstB;
    const originalBlind = saved.body.session.review.blindReview;

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "overwrite-original-blind",
        expectedRevision: saved.body.session.revision,
        ...blindReview({ confidence: originalBlind.confidence === 4 ? 5 : 4 }),
      })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send({
        actionId: "stale-blind-correction",
        expectedRevision: finished.body.session.revision,
        changeNote: "过期版本",
        ...blindReview({ confidence: 3 }),
      })
      .expect(409);

    const correctionPayload = {
      actionId: "blind-correction-1",
      expectedRevision: saved.body.session.revision,
      changeNote: "补充入场确认条件",
      ...blindReview({ confidence: 3 }),
    };
    const correctionOne = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send(correctionPayload)
      .expect(200);
    assert.equal(correctionOne.body.correction.revisionNumber, 1);
    assert.equal(correctionOne.body.correction.stage, "blind");
    assert.deepEqual(
      correctionOne.body.session.review.blindReview,
      originalBlind,
    );
    assertBlind(correctionOne.body);

    const retried = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send(correctionPayload)
      .expect(200);
    assert.equal(retried.body.idempotent, true);
    assert.equal(
      retried.body.correction.id,
      correctionOne.body.correction.id,
    );
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
      .send({ ...correctionPayload, changeNote: "篡改相同 actionId" })
      .expect(409);

    const [correctionTwoA, correctionTwoB] = await Promise.all([
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
        .send({
          actionId: "blind-correction-2a",
          expectedRevision: correctionOne.body.session.revision,
          changeNote: "进一步收紧风险条件",
          ...blindReview({ confidence: 2 }),
        }),
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind/corrections`)
        .send({
          actionId: "blind-correction-2b",
          expectedRevision: correctionOne.body.session.revision,
          changeNote: "并发补充另一条风险条件",
          ...blindReview({ confidence: 1 }),
        }),
    ]);
    assert.deepEqual(
      [correctionTwoA.status, correctionTwoB.status].sort(),
      [200, 409],
    );
    const correctionTwo =
      correctionTwoA.status === 200 ? correctionTwoA : correctionTwoB;
    assert.equal(correctionTwo.body.correction.revisionNumber, 2);
    assert.deepEqual(
      correctionTwo.body.session.corrections.map((item) => [
        item.stage,
        item.revisionNumber,
      ]),
      [
        ["blind", 1],
        ["blind", 2],
      ],
    );

    const directDb = new DatabaseSync(dbPath);
    assert.deepEqual(
      directDb
        .prepare(
          `
          SELECT revision_number, COUNT(*) AS count
          FROM replay_review_corrections
          WHERE session_id = ? AND stage = 'blind'
          GROUP BY revision_number
          ORDER BY revision_number
          `,
        )
        .all(sessionId)
        .map((row) => ({
          revision_number: row.revision_number,
          count: row.count,
        })),
      [
        { revision_number: 1, count: 1 },
        { revision_number: 2, count: 1 },
      ],
    );
    assert.throws(
      () =>
        directDb
          .prepare(
            "UPDATE replay_review_corrections SET change_note = 'x' WHERE id = ?",
          )
          .run(correctionOne.body.correction.id),
      /append-only/,
    );
    assert.throws(
      () =>
        directDb
          .prepare("DELETE FROM replay_review_corrections WHERE id = ?")
          .run(correctionOne.body.correction.id),
      /append-only/,
    );
    directDb.close();

    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({
        actionId: "reveal-after-corrections",
        expectedRevision: correctionTwo.body.session.revision,
      })
      .expect(200);
    assert.equal(revealed.body.session.revealed, true);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post/corrections`)
      .send({
        actionId: "post-correction-before-original",
        expectedRevision: revealed.body.session.revision,
        changeNote: "尚无首条事后复盘",
        ...postReview(),
      })
      .expect(409);
    const savedPost = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "first-post",
        expectedRevision: revealed.body.session.revision,
        ...postReview(),
      })
      .expect(200);
    const frozenScore = savedPost.body.session.scoreCard;
    const scoreBeforeCorrectionDb = new DatabaseSync(dbPath, {
      readOnly: true,
    });
    const scoreBeforeCorrection = scoreBeforeCorrectionDb
      .prepare(
        "SELECT score_json FROM replay_reviews WHERE session_id = ?",
      )
      .get(sessionId).score_json;
    scoreBeforeCorrectionDb.close();
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "overwrite-original-post",
        expectedRevision: savedPost.body.session.revision,
        ...postReview({ disciplineScore: 5 }),
      })
      .expect(409);
    const postCorrection = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post/corrections`)
      .send({
        actionId: "post-correction-1",
        expectedRevision: savedPost.body.session.revision,
        changeNote: "补充执行复盘",
        ...postReview({ disciplineScore: 5 }),
      })
      .expect(200);
    assert.equal(postCorrection.body.correction.revisionNumber, 1);
    assert.deepEqual(postCorrection.body.session.scoreCard, frozenScore);
    assert.deepEqual(
      postCorrection.body.session.review.postReview,
      postReview(),
    );
    assert.equal(postCorrection.body.session.corrections.length, 3);
    const scoreAfterCorrectionDb = new DatabaseSync(dbPath, {
      readOnly: true,
    });
    const scoreAfterCorrection = scoreAfterCorrectionDb
      .prepare(
        "SELECT score_json FROM replay_reviews WHERE session_id = ?",
      )
      .get(sessionId).score_json;
    scoreAfterCorrectionDb.close();
    assert.equal(scoreAfterCorrection, scoreBeforeCorrection);

    const history = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    const historyItem = history.body.items.find((item) => item.id === sessionId);
    assert.deepEqual(historyItem.correctionSummary, {
      blindCount: 2,
      postCount: 1,
    });
    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.deepEqual(
      detail.body.session.corrections,
      postCorrection.body.session.corrections,
    );
  });

  it("hides legacy post corrections before reveal", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 2 })
      .expect(201);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({ actionId: "finish-hidden", expectedRevision: 0 })
      .expect(200);
    const blind = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/reviews/blind`)
      .send({
        actionId: "blind-hidden",
        expectedRevision: finished.body.session.revision,
        ...blindReview(),
      })
      .expect(200);
    const directDb = new DatabaseSync(dbPath);
    directDb
      .prepare(
        `
        INSERT INTO replay_review_corrections (
          id, session_id, action_id, stage, revision_number,
          full_review_json, change_note, created_at
        ) VALUES (?, ?, ?, 'post', 1, ?, ?, ?)
        `,
      )
      .run(
        "legacy-hidden-post-correction",
        created.body.session.id,
        "legacy-hidden-post-action",
        JSON.stringify({
          ...postReview(),
          lessons: "POST-PRIVATE-CORRECTION",
        }),
        "旧数据边界",
        "2024-01-01T00:00:00.000Z",
      );
    directDb
      .prepare(
        `
        UPDATE replay_reviews
        SET post_json = ?, score_json = ?
        WHERE session_id = ?
        `,
      )
      .run(
        JSON.stringify({
          ...postReview(),
          lessons: "POST-PRIVATE-CORRECTION",
        }),
        JSON.stringify({
          algorithmVersion: "legacy-private-score",
          total: 99,
        }),
        created.body.session.id,
      );
    directDb.close();

    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${created.body.session.id}`)
      .expect(200);
    assert.deepEqual(detail.body.session.corrections, []);
    assertBlind(detail.body);
    const history = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    const item = history.body.items.find(
      (candidate) => candidate.id === created.body.session.id,
    );
    assert.deepEqual(item.correctionSummary, {
      blindCount: 0,
      postCount: 0,
    });
    assert.equal(item.postReview, null);
    assert.equal(item.scoreCard, null);
    assertBlind(item);
    const privateKeyword = await request(app)
      .get(
        "/api/quant/replay/sessions?keyword=POST-PRIVATE-CORRECTION",
      )
      .expect(200);
    assert.equal(privateKeyword.body.total, 0);
    assert.equal(blind.body.session.revealed, false);
  });
});

it("migrates old replay review databases with an empty corrections timeline", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-correction-old-"));
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
    CREATE TABLE replay_reviews (
      session_id TEXT PRIMARY KEY,
      blind_json TEXT,
      post_json TEXT,
      score_json TEXT,
      blind_updated_at TEXT,
      post_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO replay_sessions VALUES (
      'legacy-review', 'legacy-v1', 20, 250, 0, 'active',
      '{"bars":[]}', '2024-01-01', '2024-01-01'
    );
    INSERT INTO replay_reviews VALUES (
      'legacy-review', '{"confidence":4}', NULL, NULL,
      '2024-01-01', NULL, '2024-01-01', '2024-01-01'
    );
  `);
  legacy.close();

  const database = createDatabase(dbPath);
  assert.deepEqual(database.getReplaySession("legacy-review").corrections, []);
  database.close();
  rmSync(root, { recursive: true, force: true });
});
