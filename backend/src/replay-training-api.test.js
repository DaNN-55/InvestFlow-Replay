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
    sourceDataVersion: "training-source-v1",
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
    strategyName: "客户端填写的名称",
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

describe("replay playbook training API", () => {
  let app;
  let root;
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
    root = mkdtempSync(join(tmpdir(), "investflow-replay-training-"));
    app = createApp({
      dbPath: join(root, "workbench.sqlite"),
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

  it("keeps legacy create requests compatible as free training", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 1 })
      .expect(201);
    assert.deepEqual(created.body.session.trainingConfig, { mode: "free" });

    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${created.body.session.id}`)
      .expect(200);
    assert.deepEqual(detail.body.session.trainingConfig, { mode: "free" });

    const history = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    const item = history.body.items.find(
      (candidate) => candidate.id === created.body.session.id,
    );
    assert.deepEqual(item.trainingConfig, { mode: "free" });
  });

  it("validates playbook selection before requesting a market scenario", async () => {
    const beforeCount = scenarioRequests;
    await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, trainingMode: "playbook" })
      .expect(400);
    await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        trainingMode: "playbook",
        playbookId: "replay-playbook-longtou",
        playbookVersionId: "replay-playbook-shaofu-v1",
      })
      .expect(400);
    await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        trainingMode: "unknown",
      })
      .expect(400);
    assert.equal(scenarioRequests, beforeCount);
  });

  it("freezes a playbook version and authoritatively links blind reviews", async () => {
    const playbook = await request(app)
      .post("/api/quant/replay/playbooks")
      .send({
        name: "专项冻结战法",
        content: "v1：只在突破并确认承接后介入。",
        changeSummary: "创建首版",
      })
      .expect(201);
    const playbookId = playbook.body.playbook.id;
    const versionOne = playbook.body.playbook.currentVersion;

    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        seed: 2,
        trainingMode: "playbook",
        playbookId,
        playbookVersionId: versionOne.id,
      })
      .expect(201);
    assert.deepEqual(created.body.session.trainingConfig, {
      mode: "playbook",
      playbookId,
      playbookVersionId: versionOne.id,
      playbookName: "专项冻结战法",
      playbookVersionNumber: 1,
      playbookContent: "v1：只在突破并确认承接后介入。",
    });

    await request(app)
      .post(`/api/quant/replay/playbooks/${playbookId}/versions`)
      .send({
        expectedVersionNumber: 1,
        content: "v2：增加量能过滤条件。",
        changeSummary: "增加量能过滤",
      })
      .expect(201);

    const detail = await request(app)
      .get(`/api/quant/replay/sessions/${created.body.session.id}`)
      .expect(200);
    assert.deepEqual(
      detail.body.session.trainingConfig,
      created.body.session.trainingConfig,
    );
    const history = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    assert.deepEqual(
      history.body.items.find((item) => item.id === created.body.session.id)
        .trainingConfig,
      {
        mode: "playbook",
        playbookId,
        playbookVersionId: versionOne.id,
        playbookName: "专项冻结战法",
        playbookVersionNumber: 1,
      },
    );
    assert.equal(JSON.stringify(history.body).includes("playbookContent"), false);

    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({ actionId: "finish-training", expectedRevision: 0 })
      .expect(200);
    await request(app)
      .post(
        `/api/quant/replay/sessions/${created.body.session.id}/reviews/blind`,
      )
      .send({
        actionId: "reject-rebind",
        expectedRevision: finished.body.session.revision,
        ...blindReview({
          playbookId: "replay-playbook-longtou",
          playbookVersionId: "replay-playbook-longtou-v1",
        }),
      })
      .expect(409);

    const saved = await request(app)
      .post(
        `/api/quant/replay/sessions/${created.body.session.id}/reviews/blind`,
      )
      .send({
        actionId: "save-frozen-blind",
        expectedRevision: finished.body.session.revision,
        ...blindReview(),
      })
      .expect(200);
    assert.deepEqual(saved.body.session.review.blindReview, {
      ...blindReview(),
      strategyName: "专项冻结战法",
      playbookId,
      playbookVersionId: versionOne.id,
      playbookVersionNumber: 1,
    });
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/reveal`)
      .send({
        actionId: "reveal-frozen-training",
        expectedRevision: saved.body.session.revision,
      })
      .expect(200);
    const postReview = {
      actionId: "score-frozen-training",
      expectedRevision: revealed.body.session.revision,
      outcome: "partial",
      executionReview: "本次按冻结版本逐项执行，并记录了偏离计划的位置。",
      mistakes: "入场确认仍然稍早。",
      lessons: "后续继续逐条核对战法和风险控制要求。",
      disciplineScore: 4,
      riskControlScore: 4,
      strategyAdjustment: "",
    };
    await request(app)
      .post(
        `/api/quant/replay/sessions/${created.body.session.id}/reviews/post`,
      )
      .send(postReview)
      .expect(400);
    const scored = await request(app)
      .post(
        `/api/quant/replay/sessions/${created.body.session.id}/reviews/post`,
      )
      .send({ ...postReview, playbookFitScore: 4 })
      .expect(200);
    assert.equal(
      scored.body.session.scoreCard.breakdown.playbookCompliance,
      16,
    );
    assert.deepEqual(
      scored.body.session.scoreCard.applicability.playbookCompliance,
      { applicable: true, reason: null },
    );
    assert.equal(scored.body.session.scoreCard.appliedWeightTotal, 100);
    assert.equal(scored.body.session.scoreCard.total, 77.5);
  });

  it("keeps optional playbook links on free blind reviews", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 3 })
      .expect(201);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({ actionId: "finish-free", expectedRevision: 0 })
      .expect(200);
    const saved = await request(app)
      .post(
        `/api/quant/replay/sessions/${created.body.session.id}/reviews/blind`,
      )
      .send({
        actionId: "save-free-linked",
        expectedRevision: finished.body.session.revision,
        ...blindReview({
          playbookId: "replay-playbook-longtou",
          playbookVersionId: "replay-playbook-longtou-v1",
        }),
      })
      .expect(200);
    assert.equal(
      saved.body.session.review.blindReview.strategyName,
      "龙头战法",
    );
  });
});

it("migrates replay sessions without a training snapshot as free", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-training-old-"));
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
      completion_reason TEXT,
      revealed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      account_json TEXT NOT NULL DEFAULT '{}',
      cost_config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO replay_sessions VALUES (
      'legacy-free', 'legacy-v1', 20, 250, 0, 'active', NULL, NULL, 0,
      '{"bars":[]}', '{}', '{}', '2024-01-01', '2024-01-01'
    );
  `);
  legacy.close();

  const database = createDatabase(dbPath);
  assert.deepEqual(database.getReplaySession("legacy-free").trainingConfig, {
    mode: "free",
  });
  database.close();
  rmSync(root, { recursive: true, force: true });
});
