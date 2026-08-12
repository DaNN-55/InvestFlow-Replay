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

function privateScenario(gameLength = 20, seed = null) {
  const bars = Array.from({ length: 250 + gameLength }, (_, index) => {
    const day = String(index + 1).padStart(3, "0");
    return {
      sequence: index + 1,
      tradeDate: `2024-01-${day}`,
      open: 10 + index,
      high: 11 + index,
      low: 9 + index,
      close: 10.5 + index,
      volume: 1000 + index,
      amount: 10000 + index,
      weekIndex: Math.floor(index / 5) + 1,
      monthIndex: Math.floor(index / 20) + 1,
    };
  });
  if (seed === 12) {
    Object.assign(bars[250], {
      open: 260,
      high: 261,
      low: 249,
      close: 250,
    });
    Object.assign(bars[251], {
      open: 249,
      high: 250,
      low: 239,
      close: 240,
    });
  }
  return {
    sourceDataVersion: "source-version-1",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "浦发银行",
    observationBars: 250,
    gameLength,
    bars,
  };
}

function privateMinuteScenario(gameLength = 240) {
  const bars = Array.from({ length: 250 + gameLength }, (_, index) => {
    const futureOffset = Math.max(0, index - 249);
    const tradeDate = futureOffset < 3 ? "2026-08-03" : "2026-08-04";
    const minute = String(31 + (index % 60)).padStart(2, "0");
    return {
      sequence: index + 1,
      tradeDate,
      tradeTime: `${tradeDate} 09:${minute}`,
      open: 10 + index / 100,
      high: 10.1 + index / 100,
      low: 9.9 + index / 100,
      close: 10.05 + index / 100,
      volume: 1000 + index,
      amount: 10000 + index,
      weekIndex: 32,
      monthIndex: 8,
    };
  });
  return {
    sourceDataVersion: "tdx-minute-test",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "浦发银行",
    interval: "1m",
    observationBars: 250,
    gameLength,
    bars,
  };
}

function privateHybridScenario(trainingDays = 5) {
  const dailyBars = Array.from({ length: 250 }, (_, index) => ({
    sequence: index + 1,
    tradeDate: `2025-01-${String(index + 1).padStart(3, "0")}`,
    open: 10 + index / 100,
    high: 10.2 + index / 100,
    low: 9.8 + index / 100,
    close: 10.1 + index / 100,
    volume: 1000 + index,
    amount: 10000 + index,
    weekIndex: Math.floor(index / 5) + 1,
    monthIndex: Math.floor(index / 20) + 1,
  }));
  const minuteBars = Array.from({ length: trainingDays * 3 }, (_, index) => {
    const dayOffset = Math.floor(index / 3);
    const tradeDate = `2026-08-0${3 + dayOffset}`;
    return {
      sequence: 251 + index,
      tradeDate,
      tradeTime: `${tradeDate} 09:${31 + (index % 3)}`,
      open: 20 + dayOffset + (index % 3) / 10,
      high: 20.2 + dayOffset + (index % 3) / 10,
      low: 19.8 + dayOffset + (index % 3) / 10,
      close: 20.1 + dayOffset + (index % 3) / 10,
      volume: 2000 + index,
      amount: 20000 + index,
      weekIndex: 32,
      monthIndex: 8,
    };
  });
  return {
    sourceDataVersion: "tdx-hybrid-test",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "浦发银行",
    interval: "hybrid",
    stepMinutes: 5,
    trainingDays,
    observationBars: 250,
    gameLength: minuteBars.length,
    bars: [...dailyBars, ...minuteBars],
  };
}

function assertNoPrivateMarketData(payload) {
  const serialized = JSON.stringify(payload);
  for (const value of [
    "600000.SH",
    "600000",
    "浦发银行",
    ...Array.from({ length: 270 }, (_, index) =>
      `2024-01-${String(index + 1).padStart(3, "0")}`),
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      assert.equal(
        ["tscode", "symbol", "name", "tradedate"].includes(key.toLowerCase()),
        false,
        key,
      );
      visit(child);
    });
  }
  visit(payload);
}

function validBlindReview(overrides = {}) {
  return {
    strategyName: "趋势突破",
    thesis: "价格突破整理区间，量能同步放大，预期延续上行。",
    tradePlan: "突破后分批买入，次日确认强度，弱于预期则停止加仓。",
    riskPlan: "跌回整理区间立即止损，单次风险不超过计划范围。",
    confidence: 4,
    trendView: "bullish",
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: null,
    invalidationRule: null,
    ...overrides,
  };
}

function validPostReview(overrides = {}) {
  return {
    outcome: "partial",
    executionReview: "开仓按计划执行，但没有等待更明确的次日确认信号。",
    mistakes: "仓位建立略早，未充分确认突破后的承接强度。",
    lessons: "后续需要把次日承接和量价确认写进执行清单。",
    disciplineScore: 4,
    riskControlScore: 4,
    strategyAdjustment: "候选改进：增加次日承接确认条件。",
    ...overrides,
  };
}

function assertClose(actual, expected, tolerance = 1e-4) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${actual} != ${expected}`,
  );
}

async function saveBlindRevealPost(
  app,
  session,
  prefix,
  postOverrides = {},
) {
  const blind = await request(app)
    .post(`/api/quant/replay/sessions/${session.id}/reviews/blind`)
    .send({
      actionId: `${prefix}-blind`,
      expectedRevision: session.revision,
      ...validBlindReview(),
    })
    .expect(200);
  const revealed = await request(app)
    .post(`/api/quant/replay/sessions/${session.id}/reveal`)
    .send({
      actionId: `${prefix}-reveal`,
      expectedRevision: blind.body.session.revision,
    })
    .expect(200);
  const post = await request(app)
    .post(`/api/quant/replay/sessions/${session.id}/reviews/post`)
    .send({
      actionId: `${prefix}-post`,
      expectedRevision: revealed.body.session.revision,
      ...validPostReview(postOverrides),
    })
    .expect(200);
  return post.body.session;
}

describe("replay session API", () => {
  let app;
  let dbPath;
  let engineServer;
  let root;
  let lastScenarioPayload;

  before(async () => {
    engineServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.pathname === "/internal/replay/cache/status") {
        res.end(JSON.stringify({
          state: "running",
          activeTask: { state: "running", completed: 3, total: 12, message: "正在预热新的日线标的" },
          market: { instrumentCount: 5200, stockCount: 12, stockDailyBarCount: 9600 },
          minute: { oneMinuteInstrumentCount: 1, oneMinuteBarCount: 1200 },
          storage: { marketBytes: 1024, minuteBytes: 2048, totalBytes: 3072 },
        }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/internal/replay/scenarios") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const payload = JSON.parse(body || "{}");
          lastScenarioPayload = payload;
          if (payload.seed === 40901) {
            res.statusCode = 409;
            res.end(JSON.stringify({
              error: {
                code: "MARKET_CACHE_INSUFFICIENT",
                message: "分钟行情不足：缓存数据不足",
              },
            }));
            return;
          }
          if (payload.seed === 40001) {
            res.statusCode = 400;
            res.end(JSON.stringify({
              error: {
                code: "INVALID_REQUEST",
                message: "benchmarkCode 不能为空",
              },
            }));
            return;
          }
          res.end(
            JSON.stringify(
              payload.interval === "1m"
                ? privateMinuteScenario(payload.gameLength)
                : payload.interval === "hybrid"
                  ? privateHybridScenario(payload.gameLength)
                  : privateScenario(payload.gameLength, payload.seed),
            ),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-replay-session-"));
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

  it("forwards the selected benchmark code to the replay engine", async () => {
    await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 17, benchmarkCode: "000001.SH" })
      .expect(201);

    assert.equal(lastScenarioPayload.benchmarkCode, "000001.SH");
  });

  it("proxies replay cache progress and volume without reshaping it", async () => {
    const response = await request(app)
      .get("/api/quant/replay/cache/status")
      .expect(200);

    assert.equal(response.body.state, "running");
    assert.deepEqual(response.body.activeTask, {
      state: "running",
      completed: 3,
      total: 12,
      message: "正在预热新的日线标的",
    });
    assert.equal(response.body.market.stockDailyBarCount, 9600);
    assert.equal(response.body.storage.totalBytes, 3072);
  });

  it("preserves structured replay engine error codes", async () => {
    const insufficient = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 40901 })
      .expect(409);

    assert.deepEqual(insufficient.body.error, {
      code: "MARKET_CACHE_INSUFFICIENT",
      message: "分钟行情不足：缓存数据不足",
      details: {
        error: {
          code: "MARKET_CACHE_INSUFFICIENT",
          message: "分钟行情不足：缓存数据不足",
        },
      },
    });

    const invalid = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 40001 })
      .expect(400);

    assert.equal(invalid.body.error.code, "INVALID_REQUEST");
    assert.equal(invalid.body.error.message, "benchmarkCode 不能为空");
  });

  it("creates and reads a persisted blind daily session without private data", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 7 })
      .expect(201);

    assert.equal(lastScenarioPayload.excludedTsCodes.includes("600000.SH"), true);

    assert.equal(created.body.session.gameLength, 20);
    assert.equal(created.body.session.observationBars, 250);
    assert.equal(created.body.session.revealedFutureBars, 0);
    assert.equal(created.body.session.status, "active");
    assert.equal(created.body.session.bars.length, 250);
    assert.deepEqual(created.body.session.bars[0], {
      sequence: 1,
      displayLabel: "第 1 日",
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 1000,
      amount: 10000,
      weekIndex: 1,
      monthIndex: 1,
    });
    assertNoPrivateMarketData(created.body);
    assert.equal(JSON.stringify(created.body).includes('"close":260.5'), false);

    const inspectionDb = new DatabaseSync(dbPath, { readOnly: true });
    const storedRow = inspectionDb
      .prepare("SELECT snapshot_json FROM replay_sessions WHERE id = ?")
      .get(created.body.session.id);
    inspectionDb.close();
    const storedSnapshot = JSON.parse(storedRow.snapshot_json);
    assert.equal(storedSnapshot.tsCode, "600000.SH");
    assert.equal(storedSnapshot.name, "浦发银行");
    assert.equal(storedSnapshot.bars.length, 270);
    assert.equal(storedSnapshot.bars[269].tradeDate, "2024-01-270");

    const loaded = await request(app)
      .get(`/api/quant/replay/sessions/${created.body.session.id}`)
      .expect(200);
    assert.deepEqual(loaded.body, created.body);
    assertNoPrivateMarketData(loaded.body);
  });

  it("creates a minute session and unlocks bought shares only on the next trade date", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        interval: "1m",
        gameLength: 240,
        seed: 77,
        benchmarkCode: "000001.SH",
      })
      .expect(201);
    assert.equal(lastScenarioPayload.interval, "1m");
    assert.equal(created.body.session.interval, "1m");
    assert.equal(created.body.session.bars[0].displayLabel, "第 1 分钟");
    const listed = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    assert.equal(
      listed.body.items.find((item) => item.id === created.body.session.id)?.interval,
      "1m",
    );

    const ordered = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/orders`)
      .send({
        actionId: "minute-buy",
        expectedRevision: created.body.session.revision,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const first = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/advance`)
      .send({
        actionId: "minute-advance-1",
        expectedRevision: ordered.body.session.revision,
      })
      .expect(200);
    assert.equal(first.body.session.account.lockedQuantity, 100);
    assert.equal(first.body.session.account.availableQuantity, 0);

    const second = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/advance`)
      .send({
        actionId: "minute-advance-2",
        expectedRevision: first.body.session.revision,
      })
      .expect(200);
    assert.equal(second.body.session.account.lockedQuantity, 100);
    assert.equal(second.body.session.account.availableQuantity, 0);

    const nextDate = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/advance`)
      .send({
        actionId: "minute-advance-next-date",
        expectedRevision: second.body.session.revision,
      })
      .expect(200);
    assert.equal(nextDate.body.session.account.lockedQuantity, 0);
    assert.equal(nextDate.body.session.account.availableQuantity, 100);
  });

  it("keeps daily candles as the main chart while hybrid replay advances by minute or day", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        interval: "hybrid",
        gameLength: 60,
        seed: 88,
        benchmarkCode: "000001.SH",
      })
      .expect(201);

    assert.equal(lastScenarioPayload.interval, "hybrid");
    assert.equal(created.body.session.interval, "hybrid");
    assert.equal(created.body.session.gameLength, 60);
    assert.equal(created.body.session.stepMinutes, 5);
    assert.equal(created.body.session.bars.length, 250);
    assert.deepEqual(created.body.session.minuteBars, []);
    assert.equal(created.body.session.intraday.completedDays, 0);

    const firstMinute = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/advance`)
      .send({
        actionId: "hybrid-minute-1",
        expectedRevision: created.body.session.revision,
        mode: "minute",
      })
      .expect(200);
    assert.equal(firstMinute.body.session.bars.length, 251);
    assert.equal(firstMinute.body.session.bars.at(-1).displayLabel, "第 251 日（形成中）");
    assert.equal(firstMinute.body.session.minuteBars.length, 1);
    assert.equal(firstMinute.body.session.minuteBars[0].displayLabel, "第 1 个5分钟");

    const dayClose = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/advance`)
      .send({
        actionId: "hybrid-day-close",
        expectedRevision: firstMinute.body.session.revision,
        mode: "day",
      })
      .expect(200);
    assert.equal(dayClose.body.session.minuteBars.length, 3);
    assert.equal(dayClose.body.session.intraday.completedDays, 1);
    assert.equal(dayClose.body.session.intraday.currentDayComplete, true);
    assert.equal(dayClose.body.session.bars.at(-1).displayLabel, "第 251 日");
  });

  it("soft-deletes a replay from history without erasing its ledger row", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 701 })
      .expect(201);
    const sessionId = created.body.session.id;

    await request(app)
      .delete(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200)
      .expect({ deleted: true, sessionId });
    await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(404);

    const listed = await request(app)
      .get("/api/quant/replay/sessions")
      .expect(200);
    assert.equal(
      listed.body.items.some((item) => item.id === sessionId),
      false,
    );

    const inspectionDb = new DatabaseSync(dbPath, { readOnly: true });
    const stored = inspectionDb
      .prepare("SELECT deleted_at FROM replay_sessions WHERE id = ?")
      .get(sessionId);
    inspectionDb.close();
    assert.ok(stored.deleted_at);

    await request(app)
      .delete(`/api/quant/replay/sessions/${sessionId}`)
      .expect(404);
  });

  it("reveals exactly one future bar per advance and never crosses the game boundary", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 8 })
      .expect(201);
    const sessionId = created.body.session.id;

    const first = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({ actionId: "advance-first", expectedRevision: 0 })
      .expect(200);
    assert.equal(first.body.advanced, true);
    assert.equal(first.body.session.revealedFutureBars, 1);
    assert.equal(first.body.session.bars.length, 251);
    assert.equal(JSON.stringify(first.body).includes('"close":261.5'), false);
    assertNoPrivateMarketData(first.body);

    let revision = first.body.session.revision;
    for (let index = 1; index < 20; index += 1) {
      const response = await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/advance`)
        .send({
          actionId: `advance-${index + 1}`,
          expectedRevision: revision,
        })
        .expect(200);
      revision = response.body.session.revision;
    }
    const completed = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(completed.body.session.revealedFutureBars, 20);
    assert.equal(completed.body.session.bars.length, 270);
    assert.equal(completed.body.session.status, "completed");
    assert.equal(completed.body.session.completionReason, "natural");
    assert.equal(completed.body.session.revealed, false);
    assertNoPrivateMarketData(completed.body);

    const afterEnd = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({ actionId: "advance-after-end", expectedRevision: revision })
      .expect(200);
    assert.equal(afterEnd.body.advanced, false);
    assert.equal(afterEnd.body.session.revealedFutureBars, 20);
    assert.equal(afterEnd.body.session.status, "completed");
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "order-after-end",
        expectedRevision: revision,
        side: "buy",
        quantity: 100,
      })
      .expect(409);
  });

  it("reveals a completed session once and restores the complete real window", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 9 })
      .expect(201);
    const sessionId = created.body.session.id;
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "finish-before-reveal", expectedRevision: 0 })
      .expect(200);
    assert.equal(finished.body.session.completionReason, "early");
    assert.equal(finished.body.session.revealed, false);
    assert.equal(finished.body.session.bars.length, 250);
    assertNoPrivateMarketData(finished.body);

    const blindReview = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "blind-before-reveal",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview(),
      })
      .expect(200);
    const revealPayload = {
      actionId: "reveal-completed",
      expectedRevision: blindReview.body.session.revision,
    };
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send(revealPayload)
      .expect(200);
    assert.equal(revealed.body.revealed, true);
    assert.equal(revealed.body.idempotent, false);
    assert.equal(revealed.body.session.status, "completed");
    assert.equal(revealed.body.session.completionReason, "early");
    assert.equal(revealed.body.session.revealed, true);
    assert.equal(revealed.body.session.revision, 3);
    assert.deepEqual(revealed.body.session.reveal, {
      tsCode: "600000.SH",
      symbol: "600000",
      exchange: "SSE",
      name: "浦发银行",
      startDate: "2024-01-001",
      endDate: "2024-01-270",
    });
    assert.equal(revealed.body.session.bars.length, 270);
    assert.equal(revealed.body.session.bars[0].tradeDate, "2024-01-001");
    assert.equal(revealed.body.session.bars.at(-1).tradeDate, "2024-01-270");
    assert.equal(revealed.body.session.valuation.markPrice, 259.5);
    assert.notEqual(
      revealed.body.session.valuation.markPrice,
      revealed.body.session.bars.at(-1).close,
    );

    const restored = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.deepEqual(restored.body.session, revealed.body.session);

    const retried = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send(revealPayload)
      .expect(200);
    assert.equal(retried.body.revealed, true);
    assert.equal(retried.body.idempotent, true);
    assert.deepEqual(retried.body.session, revealed.body.session);
  });

  it("records a no-opportunity finish separately from an early submission", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 91 })
      .expect(201);

    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${created.body.session.id}/finish`)
      .send({
        actionId: "finish-no-opportunity",
        expectedRevision: 0,
        reason: "no_opportunity",
      })
      .expect(200);

    assert.equal(finished.body.session.status, "completed");
    assert.equal(finished.body.session.completionReason, "no_opportunity");
  });

  it("validates supported game lengths and returns 404 for unknown sessions", async () => {
    for (const gameLength of [20, 60, 120]) {
      const response = await request(app)
        .post("/api/quant/replay/sessions")
        .send({ gameLength, seed: gameLength })
        .expect(201);
      assert.equal(response.body.session.gameLength, gameLength);
      assert.equal(response.body.session.bars.length, 250);
    }
    const defaultLength = await request(app)
      .post("/api/quant/replay/sessions")
      .send({})
      .expect(201);
    assert.equal(defaultLength.body.session.gameLength, 60);

    await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 40 })
      .expect(400);
    await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 1.5 })
      .expect(400);
    await request(app)
      .get("/api/quant/replay/sessions/missing")
      .expect(404);
    await request(app)
      .post("/api/quant/replay/sessions/missing/advance")
      .send({ actionId: "advance-missing", expectedRevision: 0 })
      .expect(404);
  });

  it("enforces finish and reveal state and revision conflicts", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 10 })
      .expect(201);
    const sessionId = created.body.session.id;

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({ actionId: "reveal-active", expectedRevision: 0 })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "finish-wrong-revision", expectedRevision: 1 })
      .expect(409);

    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "finish-correct-revision", expectedRevision: 0 })
      .expect(200);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({ actionId: "reveal-stale-revision", expectedRevision: 0 })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({
        actionId: "finish-after-completed",
        expectedRevision: finished.body.session.revision,
      })
      .expect(409);

    for (const path of ["finish", "reveal"]) {
      await request(app)
        .post(`/api/quant/replay/sessions/missing/${path}`)
        .send({ actionId: `${path}-missing`, expectedRevision: 0 })
        .expect(404);
      await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/${path}`)
        .send({})
        .expect(400);
    }
  });

  it("requires a valid blind review before reveal and keeps it blind", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 11 })
      .expect(201);
    const sessionId = created.body.session.id;
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "finish-for-blind-review", expectedRevision: 0 })
      .expect(200);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({
        actionId: "reveal-without-blind-review",
        expectedRevision: finished.body.session.revision,
      })
      .expect(409);

    const saved = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "save-blind-review",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview(),
      })
      .expect(200);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.idempotent, false);
    assert.equal(saved.body.session.review.blindSaved, true);
    assert.equal(saved.body.session.review.postSaved, false);
    assert.equal(saved.body.session.review.blindLocked, false);
    assert.deepEqual(
      saved.body.session.review.blindReview,
      validBlindReview(),
    );
    assertNoPrivateMarketData(saved.body);

    const retried = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "save-blind-review",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview(),
      })
      .expect(200);
    assert.equal(retried.body.idempotent, true);
    assert.equal(
      retried.body.session.revision,
      saved.body.session.revision,
    );
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "save-blind-review",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview({ confidence: 5 }),
      })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "save-blind-review-stale",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview({ confidence: 5 }),
      })
      .expect(409);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "update-blind-review",
        expectedRevision: saved.body.session.revision,
        ...validBlindReview({ confidence: 5 }),
      })
      .expect(409);
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({
        actionId: "reveal-after-blind-review",
        expectedRevision: saved.body.session.revision,
      })
      .expect(200);
    assert.equal(revealed.body.session.review.blindLocked, true);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "blind-review-after-reveal",
        expectedRevision: revealed.body.session.revision,
        ...validBlindReview(),
      })
      .expect(409);
  });

  it("scores an early open position and recalculates after post-review updates", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 13 })
      .expect(201);
    const sessionId = created.body.session.id;
    const ordered = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "score-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const advanced = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "score-advance",
        expectedRevision: ordered.body.session.revision,
      })
      .expect(200);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({
        actionId: "score-finish",
        expectedRevision: advanced.body.session.revision,
      })
      .expect(200);
    const blind = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "score-blind",
        expectedRevision: finished.body.session.revision,
        ...validBlindReview(),
      })
      .expect(200);
    const revealed = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reveal`)
      .send({
        actionId: "score-reveal",
        expectedRevision: blind.body.session.revision,
      })
      .expect(200);
    assert.equal(revealed.body.session.scoreCard, null);

    const saved = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "score-post",
        expectedRevision: revealed.body.session.revision,
        ...validPostReview({ playbookFitScore: 5 }),
      })
      .expect(200);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.session.account.positionQuantity, 100);
    assert.equal(saved.body.session.review.postSaved, true);
    assert.deepEqual(
      saved.body.session.review.postReview,
      { ...validPostReview(), strategyAdjustment: "" },
    );
    assert.deepEqual(saved.body.session.scoreCard.metrics, {
      totalReturnPct: 0.0289,
      maxDrawdownPct: 0,
      totalTradingCosts: 8.064,
      realizedPnl: 0,
      unrealizedPnl: 28.936,
      endingCapitalUtilizationPct: 26.0425,
      averageCapitalUtilizationPct: 26.0425,
      maxCapitalUtilizationPct: 26.0425,
      stockBuyAndHoldReturnPct: 0.3854,
      strategyVsStockBuyAndHoldPct: -0.3564,
      indexBenchmarkReturnPct: null,
      indexExcessReturnPct: null,
      indexBenchmarkStatus: "unavailable",
    });
    assert.deepEqual(saved.body.session.scoreCard.breakdown, {
      executionDiscipline: 30,
      riskControl: 25,
      returnPerformance: 9.4,
      reviewQuality: 12.5,
    });
    assert.equal(saved.body.session.scoreCard.algorithmVersion, "replay-score-v3");
    assert.deepEqual(saved.body.session.scoreCard.weights, {
      executionDiscipline: 37.5,
      riskControl: 31.25,
      returnPerformance: 18.75,
      reviewQuality: 12.5,
    });
    assert.equal(saved.body.session.scoreCard.appliedWeightTotal, 100);
    assert.equal(saved.body.session.scoreCard.total, 76.9);
    assert.equal(
      Object.hasOwn(
        saved.body.session.scoreCard.applicability,
        "playbookCompliance",
      ),
      false,
    );
    const scoreDb = new DatabaseSync(dbPath, { readOnly: true });
    const storedReview = scoreDb
      .prepare(
        `
        SELECT blind_json, post_json, score_json
        FROM replay_reviews
        WHERE session_id = ?
        `,
      )
      .get(sessionId);
    scoreDb.close();
    assert.deepEqual(JSON.parse(storedReview.blind_json), validBlindReview());
    assert.deepEqual(JSON.parse(storedReview.post_json), {
      ...validPostReview(),
      strategyAdjustment: "",
    });
    assert.equal(JSON.parse(storedReview.score_json).total, 76.9);
    const snapshotDb = new DatabaseSync(dbPath);
    assert.throws(
      () =>
        snapshotDb
          .prepare(
            "UPDATE replay_reviews SET blind_json = NULL WHERE session_id = ?",
          )
          .run(sessionId),
      /initial blind review is immutable/,
    );
    assert.throws(
      () =>
        snapshotDb
          .prepare(
            "UPDATE replay_reviews SET post_json = NULL WHERE session_id = ?",
          )
          .run(sessionId),
      /initial post review is immutable/,
    );
    assert.throws(
      () =>
        snapshotDb
          .prepare(
            "UPDATE replay_reviews SET score_json = NULL WHERE session_id = ?",
          )
          .run(sessionId),
      /initial score card is immutable/,
    );
    snapshotDb.close();

    const retried = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "score-post",
        expectedRevision: revealed.body.session.revision,
        ...validPostReview(),
      })
      .expect(200);
    assert.equal(retried.body.idempotent, true);
    assert.equal(
      retried.body.session.revision,
      saved.body.session.revision,
    );
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "score-post",
        expectedRevision: revealed.body.session.revision,
        ...validPostReview({ disciplineScore: 5 }),
      })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "score-post-stale",
        expectedRevision: revealed.body.session.revision,
        ...validPostReview({ disciplineScore: 5 }),
      })
      .expect(409);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "score-post-update",
        expectedRevision: saved.body.session.revision,
        ...validPostReview({
          disciplineScore: 5,
          lessons: "后续严格等待次日承接确认，并把条件逐项记录后再交易。",
        }),
      })
      .expect(409);
    const frozen = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(
      frozen.body.session.scoreCard.breakdown.executionDiscipline,
      30,
    );
    assert.equal(frozen.body.session.scoreCard.total, 76.9);
  });

  it("validates both review stages and enforces their state gates", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 14 })
      .expect(201);
    const sessionId = created.body.session.id;

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
      .send({
        actionId: "blind-while-active",
        expectedRevision: 0,
        ...validBlindReview(),
      })
      .expect(409);
    for (const invalid of [
      { thesis: "太短" },
      { tradePlan: "太短" },
      { riskPlan: "太短" },
      { confidence: 0 },
      { confidence: 1.5 },
      { strategyName: "战".repeat(121) },
      { unknown: true },
    ]) {
      await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`)
        .send({
          actionId: `invalid-blind-${Object.keys(invalid)[0]}`,
          expectedRevision: 0,
          ...validBlindReview(),
          ...invalid,
        })
        .expect(400);
    }

    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "finish-review-validation", expectedRevision: 0 })
      .expect(200);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "post-before-reveal",
        expectedRevision: finished.body.session.revision,
        ...validPostReview(),
      })
      .expect(409);
    for (const invalid of [
      { outcome: "unknown" },
      { executionReview: "太短" },
      { mistakes: "" },
      { lessons: "太短" },
      { disciplineScore: 6 },
      { disciplineScore: 2.5 },
      { riskControlScore: undefined },
      { riskControlScore: 0 },
      { riskControlScore: 2.5 },
      { playbookFitScore: 0 },
      { playbookFitScore: 2.5 },
      { strategyAdjustment: "改".repeat(2001) },
      { unknown: true },
    ]) {
      await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
        .send({
          actionId: `invalid-post-${Object.keys(invalid)[0]}`,
          expectedRevision: finished.body.session.revision,
          ...validPostReview(),
          ...invalid,
        })
        .expect(400);
      }
  });

  it("rebuilds negative drawdown for an early open position", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 12 })
      .expect(201);
    const sessionId = created.body.session.id;
    const ordered = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "negative-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const firstDay = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "negative-day-1",
        expectedRevision: ordered.body.session.revision,
      })
      .expect(200);
    const secondDay = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "negative-day-2",
        expectedRevision: firstDay.body.session.revision,
      })
      .expect(200);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({
        actionId: "negative-finish",
        expectedRevision: secondDay.body.session.revision,
      })
      .expect(200);
    const reviewed = await saveBlindRevealPost(
      app,
      finished.body.session,
      "negative",
      { disciplineScore: 3 },
    );

    assert.equal(reviewed.completionReason, "early");
    assert.equal(reviewed.account.positionQuantity, 100);
    assert.deepEqual(reviewed.scoreCard.metrics, {
      totalReturnPct: -2.0211,
      maxDrawdownPct: 2.0211,
      totalTradingCosts: 8.064,
      realizedPnl: 0,
      unrealizedPnl: -2021.064,
      endingCapitalUtilizationPct: 24.4951,
      averageCapitalUtilizationPct: 24.8765,
      maxCapitalUtilizationPct: 25.2579,
      stockBuyAndHoldReturnPct: -7.5145,
      strategyVsStockBuyAndHoldPct: 5.4934,
      indexBenchmarkReturnPct: null,
      indexExcessReturnPct: null,
      indexBenchmarkStatus: "unavailable",
    });
    assert.deepEqual(reviewed.scoreCard.breakdown, {
      executionDiscipline: 22.5,
      riskControl: 25,
      returnPerformance: 7.48,
      reviewQuality: 12.5,
    });
    assert.equal(reviewed.scoreCard.total, 67.48);
  });

  it("keeps score financial metrics consistent across partial exits", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 17 })
      .expect(201);
    const sessionId = created.body.session.id;
    const firstBuy = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "metrics-first-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const firstAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "metrics-first-advance",
        expectedRevision: firstBuy.body.session.revision,
      })
      .expect(200);
    const unlockAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "metrics-unlock",
        expectedRevision: firstAdvance.body.session.revision,
      })
      .expect(200);
    const secondBuy = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "metrics-second-buy",
        expectedRevision: unlockAdvance.body.session.revision,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const partialSell = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "metrics-partial-sell",
        expectedRevision: secondBuy.body.session.revision,
        side: "sell",
        quantity: 100,
      })
      .expect(201);
    const mixedAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "metrics-mixed-advance",
        expectedRevision: partialSell.body.session.revision,
      })
      .expect(200);
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({
        actionId: "metrics-finish",
        expectedRevision: mixedAdvance.body.session.revision,
      })
      .expect(200);
    const reviewed = await saveBlindRevealPost(
      app,
      finished.body.session,
      "metrics",
    );
    const filledExecutions = reviewed.executions.filter(
      (execution) => execution.status === "filled",
    );
    assert.equal(filledExecutions.length, 3);
    const executionFees = filledExecutions.reduce(
      (sum, execution) => sum + execution.totalFee,
      0,
    );
    assertClose(
      reviewed.scoreCard.metrics.totalTradingCosts,
      executionFees,
    );
    assertClose(
      reviewed.valuation.totalPnl,
      reviewed.scoreCard.metrics.realizedPnl +
        reviewed.scoreCard.metrics.unrealizedPnl,
    );
    assertClose(
      reviewed.scoreCard.metrics.endingCapitalUtilizationPct,
      (reviewed.valuation.marketValue / reviewed.valuation.totalEquity) * 100,
    );
    assert.equal(reviewed.account.positionQuantity, 100);
  });

  it("scores a natural empty-position completion against its benchmark", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 15 })
      .expect(201);
    let session = created.body.session;
    for (let day = 1; day <= 20; day += 1) {
      const advanced = await request(app)
        .post(`/api/quant/replay/sessions/${session.id}/advance`)
        .send({
          actionId: `empty-natural-${day}`,
          expectedRevision: session.revision,
        })
        .expect(200);
      session = advanced.body.session;
    }
    const reviewed = await saveBlindRevealPost(
      app,
      session,
      "empty-natural",
    );

    assert.equal(reviewed.completionReason, "natural");
    assert.equal(reviewed.account.positionQuantity, 0);
    assert.deepEqual(reviewed.scoreCard.metrics, {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      totalTradingCosts: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      endingCapitalUtilizationPct: 0,
      averageCapitalUtilizationPct: 0,
      maxCapitalUtilizationPct: 0,
      stockBuyAndHoldReturnPct: 7.7071,
      strategyVsStockBuyAndHoldPct: -7.7071,
      indexBenchmarkReturnPct: null,
      indexExcessReturnPct: null,
      indexBenchmarkStatus: "unavailable",
    });
    assert.equal(reviewed.scoreCard.breakdown.returnPerformance, 9.38);
    assert.equal(reviewed.scoreCard.breakdown.riskControl, 25);
    assert.equal(reviewed.scoreCard.total, 76.88);
  });

  it("keeps legacy revealed sessions usable without inventing a blind review", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 16 })
      .expect(201);
    const sessionId = created.body.session.id;
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send({ actionId: "legacy-finish", expectedRevision: 0 })
      .expect(200);

    const inspectionDb = new DatabaseSync(dbPath);
    inspectionDb
      .prepare(
        `
        UPDATE replay_sessions
        SET revealed_at = ?, revision = revision + 1
        WHERE id = ?
        `,
      )
      .run("2026-07-30T00:00:00.000Z", sessionId);
    inspectionDb.close();

    const legacy = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.equal(legacy.body.session.revealed, true);
    assert.equal(legacy.body.session.review.blindSaved, false);
    assert.equal(legacy.body.session.review.blindReview, null);
    assert.equal(legacy.body.session.review.legacyBlindMissing, true);
    assert.equal(legacy.body.session.scoreCard, null);

    const post = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/reviews/post`)
      .send({
        actionId: "legacy-post",
        expectedRevision: finished.body.session.revision + 1,
        ...validPostReview(),
      })
      .expect(200);
    assert.equal(post.body.session.review.legacyBlindMissing, true);
    assert.equal(post.body.session.review.blindReview, null);
    assert.equal(
      post.body.session.scoreCard.completeness.completedRequiredFields,
      6,
    );
    assert.equal(
      post.body.session.scoreCard.breakdown.reviewQuality,
      7.5,
    );

    const restored = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.deepEqual(restored.body.session, post.body.session);

  });
});

it("freezes the scoring configuration at session creation and uses it at settlement", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-score-config-"));
  const dbPath = join(root, "score-config.sqlite");
  const database = createDatabase(dbPath);
  const snapshot = privateScenario(20);
  const scoringConfig = {
    algorithmVersion: "replay-score-v2",
    weights: {
      executionDiscipline: 10,
      riskControl: 15,
      playbookCompliance: 20,
      returnPerformance: 5,
      reviewQuality: 5,
    },
    parameters: {
      returnPerformance: {
        neutralScore: 1,
        pointsPerReturnPct: 0,
        minimumScore: 0,
        maximumScore: 5,
      },
    },
  };
  const createdAt = "2026-07-30T00:00:00.000Z";
  const created = database.createReplaySession({
    id: "frozen-score-session",
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
    scoringConfig,
    createdAt,
    updatedAt: createdAt,
  });
  assert.deepEqual(created.scoringConfig, scoringConfig);
  const mutationAttempt = new DatabaseSync(dbPath);
  assert.throws(
    () =>
      mutationAttempt
        .prepare(
          `
          UPDATE replay_sessions
          SET scoring_config_json = ?
          WHERE id = ?
          `,
        )
        .run(
          JSON.stringify({
            ...scoringConfig,
            weights: {
              ...scoringConfig.weights,
              executionDiscipline: 99,
            },
          }),
          created.id,
        ),
    /replay scoring configuration is immutable/,
  );
  mutationAttempt.close();

  const finished = database.finishReplaySession({
    sessionId: created.id,
    actionId: "frozen-finish",
    expectedRevision: 0,
    requestPayload: { expectedRevision: 0 },
    updatedAt: "2026-07-30T00:01:00.000Z",
  }).session;
  const blind = database.saveReplayBlindReview({
    sessionId: created.id,
    actionId: "frozen-blind",
    expectedRevision: finished.revision,
    review: validBlindReview(),
    requestPayload: {
      expectedRevision: finished.revision,
      review: validBlindReview(),
    },
    updatedAt: "2026-07-30T00:02:00.000Z",
  }).session;
  const revealed = database.revealReplaySession({
    sessionId: created.id,
    actionId: "frozen-reveal",
    expectedRevision: blind.revision,
    requestPayload: { expectedRevision: blind.revision },
    updatedAt: "2026-07-30T00:03:00.000Z",
  }).session;
  const settled = database.saveReplayPostReview({
    sessionId: created.id,
    actionId: "frozen-post",
    expectedRevision: revealed.revision,
    review: validPostReview(),
    requestPayload: {
      expectedRevision: revealed.revision,
      review: validPostReview(),
    },
    updatedAt: "2026-07-30T00:04:00.000Z",
  }).session;

  assert.deepEqual(settled.review.scoreCard.weights, scoringConfig.weights);
  assert.equal(
    settled.review.scoreCard.breakdown.executionDiscipline,
    8,
  );
  assert.equal(settled.review.scoreCard.breakdown.riskControl, 12);
  assert.equal(settled.review.scoreCard.breakdown.returnPerformance, 1);
  assert.equal(settled.review.scoreCard.breakdown.reviewQuality, 5);

  database.close();
  const reopened = createDatabase(dbPath);
  assert.deepEqual(
    reopened.getReplaySession(created.id).scoringConfig,
    scoringConfig,
  );
  reopened.close();
  rmSync(root, { recursive: true, force: true });
});

it("migrates legacy v2 score weights into the frozen session configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-score-migrate-"));
  const dbPath = join(root, "score-migrate.sqlite");
  const legacy = new DatabaseSync(dbPath);
  const snapshot = privateScenario(20);
  const storedWeights = {
    executionDiscipline: 11,
    riskControl: 22,
    playbookCompliance: 17,
    returnPerformance: 15,
    reviewQuality: 9,
  };
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
  `);
  legacy
    .prepare(
      `
      INSERT INTO replay_sessions (
        id,
        source_data_version,
        game_length,
        observation_bars,
        status,
        snapshot_json,
        created_at,
        updated_at
      ) VALUES (?, ?, 20, 250, 'completed', ?, ?, ?)
      `,
    )
    .run(
      "legacy-v2-score",
      snapshot.sourceDataVersion,
      JSON.stringify(snapshot),
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    );
  legacy
    .prepare(
      `
      INSERT INTO replay_reviews (
        session_id,
        score_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      `,
    )
    .run(
      "legacy-v2-score",
      JSON.stringify({
        algorithmVersion: "replay-score-v2",
        weights: storedWeights,
        total: 88,
      }),
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    );
  legacy.close();

  const database = createDatabase(dbPath);
  const migrated = database.getReplaySession("legacy-v2-score");
  assert.deepEqual(migrated.scoringConfig.weights, storedWeights);
  assert.deepEqual(migrated.scoringConfig.parameters, {
    returnPerformance: {
      neutralScore: 7.5,
      pointsPerReturnPct: 0.75,
      minimumScore: 0,
      maximumScore: 15,
    },
  });
  assert.deepEqual(migrated.scoringConfig.migration, {
    source: "legacy_score_card",
    weightsSource: "score_card",
    parametersSource: "replay_score_v2_fixed",
    settlement: "existing_replay_score_v2",
  });

  database.close();
  rmSync(root, { recursive: true, force: true });
});
