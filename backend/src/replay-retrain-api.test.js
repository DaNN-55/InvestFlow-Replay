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
    sourceDataVersion: "stable-source-v1",
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

function blindReview() {
  return {
    strategyName: "客户端临时名称",
    thesis: "价格突破整理区间，量能同步放大，预期后续延续上行。",
    tradePlan: "突破后分批买入，次日确认强度，弱于预期则停止加仓。",
    riskPlan: "跌回整理区间立即止损，单次风险不超过计划范围。",
    confidence: 4,
    trendView: "bullish",
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: 9.8,
    invalidationRule: null,
  };
}

function persistedReplaySession({
  id,
  sourceDataVersion,
  snapshot,
  createdAt,
}) {
  return {
    id,
    sourceDataVersion,
    gameLength: snapshot.gameLength,
    observationBars: snapshot.observationBars,
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
    createdAt,
    updatedAt: createdAt,
  };
}

async function finishBlindReveal(app, session, prefix) {
  const finished = await request(app)
    .post(`/api/quant/replay/sessions/${session.id}/finish`)
    .send({
      actionId: `${prefix}-finish`,
      expectedRevision: session.revision,
    })
    .expect(200);
  const blind = await request(app)
    .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
    .send({
      actionId: `${prefix}-blind`,
      expectedRevision: finished.body.session.revision,
      ...blindReview(),
    })
    .expect(200);
  return request(app)
    .post(`/api/quant/replay/sessions/${session.id}/reveal`)
    .send({
      actionId: `${prefix}-reveal`,
      expectedRevision: blind.body.session.revision,
    })
    .expect(200);
}

describe("replay known-scenario retraining API", () => {
  let app;
  let root;
  let dbPath;
  let engineServer;
  let scenarioRequests = 0;

  before(async () => {
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/internal/replay/scenarios") {
        scenarioRequests += 1;
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
    root = mkdtempSync(join(tmpdir(), "investflow-replay-retrain-"));
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

  it("marks the first encounter and rejects retraining before reveal", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        seed: 1,
        initialCapital: 234567,
        trainingMode: "playbook",
        playbookId: "replay-playbook-longtou",
        playbookVersionId: "replay-playbook-longtou-v1",
      })
      .expect(201);
    assert.deepEqual(created.body.session.attemptInfo, {
      attemptNumber: 1,
      kind: "first",
      countsTowardFirstScore: true,
      sourceSessionId: null,
    });
    assert.equal(
      JSON.stringify(created.body.session.attemptInfo).includes("600000"),
      false,
    );
    await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/retrain`)
      .send({})
      .expect(409);
    await request(app)
      .post("/api/quant/replay/sessions/missing/retrain")
      .send({})
      .expect(404);

    const revealed = await finishBlindReveal(
      app,
      created.body.session,
      "source",
    );
    const requestsBeforeRetrain = scenarioRequests;
    const retrained = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/retrain`)
      .send({})
      .expect(201);
    assert.equal(scenarioRequests, requestsBeforeRetrain);
    assert.deepEqual(retrained.body.session.attemptInfo, {
      attemptNumber: 2,
      kind: "retrain",
      countsTowardFirstScore: false,
      sourceSessionId: created.body.session.id,
    });
    assert.equal(retrained.body.session.status, "active");
    assert.equal(retrained.body.session.revision, 0);
    assert.equal(retrained.body.session.revealedFutureBars, 0);
    assert.equal(retrained.body.session.account.initialCapital, 234567);
    assert.equal(retrained.body.session.account.cash, 234567);
    assert.deepEqual(
      retrained.body.session.costConfig,
      created.body.session.costConfig,
    );
    assert.deepEqual(
      retrained.body.session.trainingConfig,
      created.body.session.trainingConfig,
    );
    assert.equal(retrained.body.session.bars.length, 250);
    assert.equal(retrained.body.session.review.blindReview, null);
    assert.equal(retrained.body.session.scoreCard, null);
    assert.equal(revealed.body.session.revealed, true);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    const identities = database
      .prepare(
        `
        SELECT id, scenario_fingerprint
        FROM replay_sessions
        WHERE id IN (?, ?)
        ORDER BY id
        `,
      )
      .all(created.body.session.id, retrained.body.session.id);
    database.close();
    assert.equal(identities.length, 2);
    assert.equal(
      identities[0].scenario_fingerprint,
      identities[1].scenario_fingerprint,
    );
  });

  it("marks random duplicate scenarios as retraining without a source", async () => {
    const repeated = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 999 })
      .expect(201);
    assert.deepEqual(repeated.body.session.attemptInfo, {
      attemptNumber: 3,
      kind: "retrain",
      countsTowardFirstScore: false,
      sourceSessionId: null,
    });
  });

  it("filters attempts and scores retraining without first-score eligibility", async () => {
    const retrainHistory = await request(app)
      .get("/api/quant/replay/sessions?attemptKind=retrain")
      .expect(200);
    assert.equal(retrainHistory.body.total, 2);
    assert.equal(
      retrainHistory.body.items.every(
        (item) =>
          item.attemptInfo.kind === "retrain" &&
          item.attemptInfo.countsTowardFirstScore === false,
      ),
      true,
    );
    const firstHistory = await request(app)
      .get("/api/quant/replay/sessions?attemptKind=first")
      .expect(200);
    assert.equal(firstHistory.body.total, 1);
    assert.equal(firstHistory.body.items[0].attemptInfo.kind, "first");
    await request(app)
      .get("/api/quant/replay/sessions?attemptKind=invalid")
      .expect(400);

    const explicitRetrain = retrainHistory.body.items.find(
      (item) => item.attemptInfo.sourceSessionId,
    );
    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${explicitRetrain.id}`)
      .expect(200);
    const revealed = await finishBlindReveal(
      app,
      detail.body.session,
      "retrain-score",
    );
    const scored = await request(app)
      .post(`/api/quant/replay/sessions/${explicitRetrain.id}/reviews/post`)
      .send({
        actionId: "retrain-post",
        expectedRevision: revealed.body.session.revision,
        outcome: "partial",
        executionReview: "本次严格按冻结战法完成复练，并记录了执行偏差。",
        mistakes: "入场确认仍然稍早，需要等待收盘信号。",
        lessons: "下一次继续坚持量价确认和风险上限。",
        disciplineScore: 4,
        riskControlScore: 4,
        playbookFitScore: 5,
        strategyAdjustment: "",
      })
      .expect(200);
    assert.equal(typeof scored.body.session.scoreCard.total, "number");
    assert.deepEqual(
      scored.body.session.scoreCard.applicability.playbookCompliance,
      { applicable: false, reason: "blank_playbook" },
    );
    assert.equal(
      Object.hasOwn(
        scored.body.session.review.postReview,
        "playbookFitScore",
      ),
      false,
    );
    const retriedScore = await request(app)
      .post(`/api/quant/replay/sessions/${explicitRetrain.id}/reviews/post`)
      .send({
        actionId: "retrain-post",
        expectedRevision: revealed.body.session.revision,
        outcome: "partial",
        executionReview: "本次严格按冻结战法完成复练，并记录了执行偏差。",
        mistakes: "入场确认仍然稍早，需要等待收盘信号。",
        lessons: "下一次继续坚持量价确认和风险上限。",
        disciplineScore: 4,
        riskControlScore: 4,
        strategyAdjustment: "",
      })
      .expect(200);
    assert.equal(retriedScore.body.idempotent, true);
    assert.deepEqual(scored.body.session.attemptInfo, {
      attemptNumber: 2,
      kind: "retrain",
      countsTowardFirstScore: false,
      sourceSessionId: explicitRetrain.attemptInfo.sourceSessionId,
    });
  });

  it("does not restore first-score eligibility after sessions are deleted", async () => {
    const database = new DatabaseSync(dbPath);
    database.exec("DELETE FROM replay_sessions");
    database.close();

    const repeated = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 1000 })
      .expect(201);
    assert.deepEqual(repeated.body.session.attemptInfo, {
      attemptNumber: 4,
      kind: "retrain",
      countsTowardFirstScore: false,
      sourceSessionId: null,
    });
  });
});

it("identifies scenarios by immutable market data instead of database metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-fingerprint-"));
  const dbPath = join(root, "fingerprint.sqlite");
  const database = createDatabase(dbPath);
  const firstSnapshot = privateScenario(20);
  const metadataOnlyChange = structuredClone(firstSnapshot);
  metadataOnlyChange.sourceDataVersion =
    "C:/moved/market.duckdb|size=999|mtime=tomorrow";
  metadataOnlyChange.name = "证券名称发生展示变化";
  metadataOnlyChange.symbol = "600000.SH";
  metadataOnlyChange.exchange = "SH";
  const actualDataChange = structuredClone(firstSnapshot);
  actualDataChange.bars[123].close += 0.01;
  const adjustmentFactorChange = structuredClone(firstSnapshot);
  adjustmentFactorChange.bars[123].adjustFactor = 1.01;

  const first = database.createReplaySession(
    persistedReplaySession({
      id: "fingerprint-first",
      sourceDataVersion: "C:/old/market.duckdb|size=1|mtime=yesterday",
      snapshot: firstSnapshot,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
  );
  const repeated = database.createReplaySession(
    persistedReplaySession({
      id: "fingerprint-repeated",
      sourceDataVersion: metadataOnlyChange.sourceDataVersion,
      snapshot: metadataOnlyChange,
      createdAt: "2024-01-02T00:00:00.000Z",
    }),
  );
  const changed = database.createReplaySession(
    persistedReplaySession({
      id: "fingerprint-changed",
      sourceDataVersion: "another-global-version",
      snapshot: actualDataChange,
      createdAt: "2024-01-03T00:00:00.000Z",
    }),
  );
  const adjusted = database.createReplaySession(
    persistedReplaySession({
      id: "fingerprint-adjusted",
      sourceDataVersion: "same-global-version",
      snapshot: adjustmentFactorChange,
      createdAt: "2024-01-04T00:00:00.000Z",
    }),
  );

  assert.equal(first.scenarioFingerprint, repeated.scenarioFingerprint);
  assert.notEqual(first.scenarioFingerprint, changed.scenarioFingerprint);
  assert.notEqual(first.scenarioFingerprint, adjusted.scenarioFingerprint);
  assert.equal(first.scenarioFingerprintVersion, "replay-scenario-v2");
  assert.deepEqual(repeated.attemptInfo, {
    attemptNumber: 2,
    kind: "retrain",
    countsTowardFirstScore: false,
    sourceSessionId: null,
  });
  assert.deepEqual(changed.attemptInfo, {
    attemptNumber: 1,
    kind: "first",
    countsTowardFirstScore: true,
    sourceSessionId: null,
  });
  assert.deepEqual(adjusted.attemptInfo, {
    attemptNumber: 1,
    kind: "first",
    countsTowardFirstScore: true,
    sourceSessionId: null,
  });

  database.close();
  rmSync(root, { recursive: true, force: true });
});

it("migrates old same-scenario sessions into stable first and retrain attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-attempt-old-"));
  const dbPath = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  const snapshot = privateScenario(20);
  legacy.exec(`
    CREATE TABLE replay_sessions (
      id TEXT PRIMARY KEY,
      source_data_version TEXT NOT NULL,
      game_length INTEGER NOT NULL,
      observation_bars INTEGER NOT NULL,
      revealed_future_bars INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      completion_reason TEXT,
      revealed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      account_json TEXT NOT NULL DEFAULT '{}',
      cost_config_json TEXT NOT NULL DEFAULT '{}',
      training_config_json TEXT NOT NULL DEFAULT '{"mode":"free"}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO replay_sessions (
      id, source_data_version, game_length, observation_bars,
      status, snapshot_json, created_at, updated_at
    ) VALUES (?, ?, 20, 250, 'active', ?, ?, ?)
  `);
  insert.run(
    "old-first",
    snapshot.sourceDataVersion,
    JSON.stringify(snapshot),
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
  );
  insert.run(
    "old-retrain",
    "C:/relocated/market.duckdb|size=999|mtime=new",
    JSON.stringify(snapshot),
    "2024-01-02T00:00:00.000Z",
    "2024-01-02T00:00:00.000Z",
  );
  legacy.close();

  const database = createDatabase(dbPath);
  assert.deepEqual(database.getReplaySession("old-first").attemptInfo, {
    attemptNumber: 1,
    kind: "first",
    countsTowardFirstScore: true,
    sourceSessionId: null,
  });
  assert.deepEqual(database.getReplaySession("old-retrain").attemptInfo, {
    attemptNumber: 2,
    kind: "retrain",
    countsTowardFirstScore: false,
    sourceSessionId: null,
  });
  assert.equal(
    database.getReplaySession("old-first").scenarioFingerprint,
    database.getReplaySession("old-retrain").scenarioFingerprint,
  );
  assert.equal(
    database.getReplaySession("old-first").scenarioFingerprintVersion,
    "replay-scenario-v2",
  );
  database.close();
  rmSync(root, { recursive: true, force: true });
});
