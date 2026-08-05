import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";

function privateScenario(gameLength = 20, seed = null) {
  const bars = Array.from({ length: 250 + gameLength }, (_, index) => {
    const open = 10 + index;
    const close = open + 0.5;
    return {
      sequence: index + 1,
      tradeDate: `2024-02-${String(index + 1).padStart(3, "0")}`,
      open,
      high: open + 1,
      low: open - 1,
      close,
      preClose: index === 0 ? 9.5 : open - 0.5,
      pctChange: 0.2,
      limitType: null,
      openTimes: null,
      volume: 1000 + index,
      amount: 10000 + index,
      weekIndex: Math.floor(index / 5) + 1,
      monthIndex: Math.floor(index / 20) + 1,
    };
  });
  if (seed === 301) {
    bars[250].volume = 0;
  }
  if (seed === 302) {
    Object.assign(bars[250], {
      open: 272.475,
      high: 272.475,
      low: 272.475,
      close: 272.475,
      preClose: 259.5,
      pctChange: 5,
      limitType: "U",
      openTimes: 0,
    });
  }
  if (seed === 303) {
    Object.assign(bars[251], {
      open: 247.475,
      high: 247.475,
      low: 247.475,
      close: 247.475,
      preClose: 260.5,
      pctChange: -5,
      limitType: "D",
      openTimes: 0,
    });
  }
  if (seed === 304) {
    Object.assign(bars[250], {
      open: 260,
      high: 260,
      low: 260,
      close: 260,
      preClose: 259.5,
      pctChange: 0.1927,
    });
  }
  if (seed === 305) {
    Object.assign(bars[250], {
      open: 272.475,
      high: 272.475,
      low: 272.475,
      close: 272.475,
      preClose: 259.5,
      pctChange: 5,
      limitType: "Z",
      openTimes: 1,
    });
  }
  if (seed === 306) {
    bars[250].open = null;
  }
  if (seed === 307) {
    bars[250].pctChange = 5;
  }
  return {
    sourceDataVersion: "source-version-trading",
    tsCode: "000001.SZ",
    symbol: "000001",
    exchange: "SZSE",
    name: "平安银行",
    observationBars: 250,
    gameLength,
    bars,
  };
}

function assertBlind(payload) {
  const serialized = JSON.stringify(payload);
  for (const privateValue of [
    "000001.SZ",
    "000001",
    "平安银行",
    "tradeDate",
    "preClose",
    "pctChange",
    "limitType",
    "openTimes",
    "2024-02-251",
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
}

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
}

describe("replay virtual account and next-open execution", () => {
  let app;
  let engineServer;
  let root;

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
          res.end(
            JSON.stringify(privateScenario(payload.gameLength, payload.seed)),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
    const address = engineServer.address();
    root = mkdtempSync(join(tmpdir(), "investflow-replay-trading-"));
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

  it("persists independent capital and strict cost snapshots", async () => {
    const defaults = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    assert.equal(defaults.body.session.revision, 0);
    assert.deepEqual(defaults.body.session.costConfig, {
      commissionRate: 0.0003,
      minCommission: 5,
      stampTaxRate: 0.0005,
      transferFeeRate: 0.00001,
      slippageBps: 0,
    });
    assert.deepEqual(defaults.body.session.account, {
      initialCapital: 100000,
      cash: 100000,
      positionQuantity: 0,
      availableQuantity: 0,
      lockedQuantity: 0,
      averageCost: 0,
      totalFees: 0,
    });
    assert.deepEqual(defaults.body.session.pendingOrders, []);
    assert.deepEqual(defaults.body.session.executions, []);
    assertBlind(defaults.body);

    const custom = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        initialCapital: 250000,
        costConfig: {
          commissionRate: 0.0002,
          minCommission: 3,
          stampTaxRate: 0.0004,
          transferFeeRate: 0.00002,
          slippageBps: 10,
        },
      })
      .expect(201);
    assert.equal(custom.body.session.account.cash, 250000);
    assert.equal(custom.body.session.costConfig.slippageBps, 10);

    for (const payload of [
      { initialCapital: 0 },
      { initialCapital: "100000" },
      { costConfig: { commissionRate: -1 } },
      { costConfig: { stampTaxRate: 1 } },
      { costConfig: { slippageBps: 10000 } },
      { costConfig: { unknownFee: 1 } },
    ]) {
      await request(app)
        .post("/api/quant/replay/sessions")
        .send({ gameLength: 20, ...payload })
        .expect(400);
    }
  });

  it("fills at the next open, charges side-specific fees, and enforces T+1", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    const sessionId = created.body.session.id;

    const submitted = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "buy-100",
        expectedRevision: 0,
        side: "buy",
        quantity: 150,
      })
      .expect(201);
    assert.equal(submitted.body.session.revision, 1);
    assert.equal(submitted.body.session.pendingOrders.length, 1);
    assert.equal(submitted.body.session.account.positionQuantity, 0);

    const bought = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({ actionId: "advance-buy", expectedRevision: 1 })
      .expect(200);
    assert.equal(bought.body.session.revision, 2);
    assert.equal(bought.body.session.revealedFutureBars, 1);
    assert.equal(bought.body.session.executions.length, 1);
    const buyFill = bought.body.session.executions[0];
    assert.equal(buyFill.status, "filled");
    assert.equal(buyFill.side, "buy");
    assert.equal(buyFill.sequence, 251);
    assert.equal(buyFill.quantity, 100);
    assert.equal(buyFill.price, 260);
    assertClose(buyFill.commission, 7.8);
    assertClose(buyFill.stampTax, 0);
    assertClose(buyFill.transferFee, 0.26);
    assertClose(bought.body.session.account.cash, 73991.94);
    assert.equal(bought.body.session.account.positionQuantity, 100);
    assert.equal(bought.body.session.account.availableQuantity, 0);
    assert.equal(bought.body.session.account.lockedQuantity, 100);

    const sellSubmitted = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "sell-all",
        expectedRevision: 2,
        side: "sell",
        positionRatio: 1,
      })
      .expect(201);
    const sold = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "advance-sell",
        expectedRevision: sellSubmitted.body.session.revision,
      })
      .expect(200);
    const sellFill = sold.body.session.executions[1];
    assert.equal(sellFill.status, "filled");
    assert.equal(sellFill.side, "sell");
    assert.equal(sellFill.quantity, 100);
    assert.equal(sellFill.price, 261);
    assertClose(sellFill.commission, 7.83);
    assertClose(sellFill.stampTax, 13.05);
    assertClose(sellFill.transferFee, 0.261);
    assertClose(sold.body.session.account.cash, 100070.799);
    assert.equal(sold.body.session.account.positionQuantity, 0);
    assert.equal(sold.body.session.account.availableQuantity, 0);
    assert.equal(sold.body.session.account.lockedQuantity, 0);
    assertClose(sold.body.session.valuation.realizedPnl, 70.799);
    assertClose(sold.body.session.valuation.unrealizedPnl, 0);
    assertClose(sold.body.session.account.totalFees, 29.201);
    assertBlind(sold.body);

    const restored = await request(app)
      .get(`/api/quant/replay/sessions/${sessionId}`)
      .expect(200);
    assert.deepEqual(restored.body.session, sold.body.session);
    assertBlind(restored.body);
  });

  it("persists an immutable decision snapshot with its order and execution", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    const sessionId = created.body.session.id;
    const decision = {
      reasonTags: ["趋势", "量价"],
      confidence: 4,
      thesis: "趋势重新转强，量价配合，当前位置具备试仓条件。",
      plan: "先买入一百股，下一交易日开盘执行，确认后再考虑加仓。",
      riskPlan: "跌破最近结构低点说明判断错误，严格按计划退出。",
      stopLossPrice: 250,
      invalidationRule: null,
    };

    const submitted = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "buy-with-decision",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
        decision,
      })
      .expect(201);
    assert.deepEqual(submitted.body.session.pendingOrders[0].decision, decision);

    const advanced = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({ actionId: "advance-decision-order", expectedRevision: 1 })
      .expect(200);
    assert.deepEqual(advanced.body.session.executions[0].decision, decision);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "invalid-sell-decision",
        expectedRevision: 2,
        side: "sell",
        positionRatio: 1,
        decision: {
          reasonTags: ["风险"],
          confidence: 3,
          thesis: "卖出理由长度足够但缺少卖出类型字段。",
          plan: "本次计划卖出全部持仓。",
          remainingPositionPlan: "清仓后继续观察。",
        },
      })
      .expect(400);
  });

  it("finishes early without liquidating and cancels every pending order exactly once", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    const sessionId = created.body.session.id;
    const buy = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "early-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const bought = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "early-buy-advance",
        expectedRevision: buy.body.session.revision,
      })
      .expect(200);
    const pending = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "early-pending-buy",
        expectedRevision: bought.body.session.revision,
        side: "buy",
        quantity: 100,
      })
      .expect(201);

    const finishPayload = {
      actionId: "finish-early",
      expectedRevision: pending.body.session.revision,
    };
    const finished = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send(finishPayload)
      .expect(200);

    assert.equal(finished.body.finished, true);
    assert.equal(finished.body.idempotent, false);
    assert.equal(finished.body.session.status, "completed");
    assert.equal(finished.body.session.completionReason, "early");
    assert.equal(finished.body.session.revealed, false);
    assert.equal(finished.body.session.revealedFutureBars, 1);
    assert.equal(finished.body.session.revision, 4);
    assert.equal(finished.body.session.account.positionQuantity, 100);
    assert.equal(finished.body.session.account.cash, bought.body.session.account.cash);
    assert.equal(
      finished.body.session.valuation.markPrice,
      bought.body.session.valuation.markPrice,
    );
    assert.equal(
      finished.body.session.valuation.totalEquity,
      bought.body.session.valuation.totalEquity,
    );
    assert.deepEqual(finished.body.session.pendingOrders, []);
    assert.deepEqual(
      finished.body.session.executions.map((execution) => [
        execution.status,
        execution.reasonCode ?? null,
      ]),
      [
        ["filled", null],
        ["cancelled", "session_finished_early"],
      ],
    );
    assertBlind(finished.body);

    const retried = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/finish`)
      .send(finishPayload)
      .expect(200);
    assert.equal(retried.body.finished, true);
    assert.equal(retried.body.idempotent, true);
    assert.equal(retried.body.session.revision, 4);
    assert.deepEqual(retried.body.session.executions, finished.body.session.executions);

    const afterFinish = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({ actionId: "advance-after-early-finish", expectedRevision: 4 })
      .expect(200);
    assert.equal(afterFinish.body.advanced, false);
    assert.equal(afterFinish.body.session.revealedFutureBars, 1);
    assert.deepEqual(afterFinish.body.session.executions, finished.body.session.executions);
    assertBlind(afterFinish.body);
  });

  it("supports cash ratios, directional slippage, and rejects same-day sells", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({
        gameLength: 20,
        costConfig: {
          commissionRate: 0.0003,
          minCommission: 5,
          stampTaxRate: 0.0005,
          transferFeeRate: 0.00001,
          slippageBps: 10,
        },
      })
      .expect(201);
    const sessionId = created.body.session.id;
    const buy = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "ratio-buy",
        expectedRevision: 0,
        side: "buy",
        cashRatio: 0.5,
      })
      .expect(201);
    const sell = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "same-day-sell",
        expectedRevision: buy.body.session.revision,
        side: "sell",
        quantity: 100,
      })
      .expect(201);
    const advanced = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "advance-ratio",
        expectedRevision: sell.body.session.revision,
      })
      .expect(200);
    assert.equal(advanced.body.session.executions.length, 2);
    assert.equal(advanced.body.session.executions[0].status, "filled");
    assert.equal(advanced.body.session.executions[0].quantity, 100);
    assertClose(advanced.body.session.executions[0].price, 260.26);
    assert.equal(advanced.body.session.executions[1].status, "rejected");
    assert.equal(
      advanced.body.session.executions[1].reasonCode,
      "insufficient_sellable",
    );
    assert.equal(advanced.body.session.account.availableQuantity, 0);
    assert.equal(advanced.body.session.account.lockedQuantity, 100);
  });

  it("rejects suspended and confirmed one-price limit orders", async () => {
    for (const [seed, side, expectedReason] of [
      [301, "buy", "suspended"],
      [302, "buy", "one_price_limit_up"],
    ]) {
      const created = await request(app)
        .post("/api/quant/replay/sessions")
        .send({ gameLength: 20, seed })
        .expect(201);
      const sessionId = created.body.session.id;
      const order = await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/orders`)
        .send({
          actionId: `order-${seed}`,
          expectedRevision: 0,
          side,
          quantity: 100,
        })
        .expect(201);
      const advanced = await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/advance`)
        .send({
          actionId: `advance-${seed}`,
          expectedRevision: order.body.session.revision,
        })
        .expect(200);
      assert.equal(advanced.body.session.executions[0].status, "rejected");
      assert.equal(
        advanced.body.session.executions[0].reasonCode,
        expectedReason,
      );
    }

    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 303 })
      .expect(201);
    const sessionId = created.body.session.id;
    const buy = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "buy-before-limit-down",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const firstAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "advance-before-limit-down",
        expectedRevision: buy.body.session.revision,
      })
      .expect(200);
    const sell = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "sell-at-limit-down",
        expectedRevision: firstAdvance.body.session.revision,
        side: "sell",
        positionRatio: 1,
      })
      .expect(201);
    const secondAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId: "advance-limit-down",
        expectedRevision: sell.body.session.revision,
      })
      .expect(200);
    const rejection = secondAdvance.body.session.executions.at(-1);
    assert.equal(rejection.status, "rejected");
    assert.equal(rejection.reasonCode, "one_price_limit_down");
    assert.equal(secondAdvance.body.session.account.positionQuantity, 100);
    assert.equal(secondAdvance.body.session.account.availableQuantity, 100);

    const lowAmplitude = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 304 })
      .expect(201);
    const lowAmplitudeId = lowAmplitude.body.session.id;
    const lowAmplitudeOrder = await request(app)
      .post(`/api/quant/replay/sessions/${lowAmplitudeId}/orders`)
      .send({
        actionId: "buy-low-amplitude-one-price",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const lowAmplitudeAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${lowAmplitudeId}/advance`)
      .send({
        actionId: "advance-low-amplitude-one-price",
        expectedRevision: lowAmplitudeOrder.body.session.revision,
      })
      .expect(200);
    assert.equal(
      lowAmplitudeAdvance.body.session.executions[0].status,
      "filled",
    );

    const zType = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, seed: 305 })
      .expect(201);
    const zTypeId = zType.body.session.id;
    const zTypeOrder = await request(app)
      .post(`/api/quant/replay/sessions/${zTypeId}/orders`)
      .send({
        actionId: "buy-z-type-one-price",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const zTypeAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${zTypeId}/advance`)
      .send({
        actionId: "advance-z-type-one-price",
        expectedRevision: zTypeOrder.body.session.revision,
      })
      .expect(200);
    assert.equal(zTypeAdvance.body.session.executions[0].status, "filled");
    assertBlind(zTypeAdvance.body);
  });

  it("exposes only the latest revealed market event for autoplay guards", async () => {
    const cases = [
      [301, 1, "suspended"],
      [302, 1, "limit_up"],
      [303, 2, "limit_down"],
      [306, 1, "invalid_market_data"],
      [307, 1, "normal"],
    ];
    for (const [seed, advances, expectedStatus] of cases) {
      const created = await request(app)
        .post("/api/quant/replay/sessions")
        .send({ gameLength: 20, seed })
        .expect(201);
      assert.equal(created.body.session.marketEvent, null);
      let session = created.body.session;
      for (let index = 0; index < advances; index += 1) {
        const advanced = await request(app)
          .post(`/api/quant/replay/sessions/${session.id}/advance`)
          .send({
            actionId: `market-event-${seed}-${index}`,
            expectedRevision: session.revision,
          })
          .expect(200);
        session = advanced.body.session;
      }
      assert.deepEqual(session.marketEvent, {
        sequence: 250 + advances,
        status: expectedStatus,
      });
      assertBlind(session);
    }
  });

  it("makes order and advance actionIds idempotent and rejects stale revisions", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    const sessionId = created.body.session.id;
    const orderPayload = {
      actionId: "idempotent-order",
      expectedRevision: 0,
      side: "buy",
      quantity: 100,
    };
    const [firstOrder, retriedOrder] = await Promise.all([
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/orders`)
        .send(orderPayload),
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/orders`)
        .send(orderPayload),
    ]);
    assert.deepEqual(
      [firstOrder.status, retriedOrder.status].sort(),
      [200, 201],
    );
    assert.equal(firstOrder.body.session.revision, 1);
    assert.equal(retriedOrder.body.session.revision, 1);
    assert.equal(firstOrder.body.session.pendingOrders.length, 1);
    assert.equal(retriedOrder.body.session.pendingOrders.length, 1);

    const [advanceA, advanceB] = await Promise.all([
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/advance`)
        .send({ actionId: "concurrent-advance-a", expectedRevision: 1 }),
      request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/advance`)
        .send({ actionId: "concurrent-advance-b", expectedRevision: 1 }),
    ]);
    const successfulAdvance = [advanceA, advanceB].find(
      (response) => response.status === 200,
    );
    assert.deepEqual(
      [advanceA.status, advanceB.status].sort(),
      [200, 409],
    );
    assert.equal(successfulAdvance.body.session.revealedFutureBars, 1);
    assert.equal(successfulAdvance.body.session.executions.length, 1);
    assert.equal(successfulAdvance.body.session.revision, 2);

    const retriedAdvance = await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({
        actionId:
          successfulAdvance === advanceA
            ? "concurrent-advance-a"
            : "concurrent-advance-b",
        expectedRevision: 1,
      })
      .expect(200);
    assert.equal(retriedAdvance.body.advanced, true);
    assert.equal(retriedAdvance.body.idempotent, true);
    assert.equal(retriedAdvance.body.session.revealedFutureBars, 1);
    assert.equal(retriedAdvance.body.session.executions.length, 1);
    assert.equal(retriedAdvance.body.session.revision, 2);

    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        actionId: "stale-order",
        expectedRevision: 1,
        side: "buy",
        quantity: 100,
      })
      .expect(409);
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/orders`)
      .send({
        ...orderPayload,
        quantity: 200,
      })
      .expect(409);
  });

  it("rejects unaffordable whole orders and never overspends across multiple buys", async () => {
    const explicit = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, initialCapital: 30000 })
      .expect(201);
    const explicitId = explicit.body.session.id;
    const tooLarge = await request(app)
      .post(`/api/quant/replay/sessions/${explicitId}/orders`)
      .send({
        actionId: "too-large-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 200,
      })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/quant/replay/sessions/${explicitId}/advance`)
      .send({
        actionId: "advance-too-large-buy",
        expectedRevision: tooLarge.body.session.revision,
      })
      .expect(200);
    assert.equal(rejected.body.session.executions[0].status, "rejected");
    assert.equal(
      rejected.body.session.executions[0].reasonCode,
      "insufficient_cash",
    );
    assert.equal(rejected.body.session.account.cash, 30000);
    assert.equal(rejected.body.session.account.positionQuantity, 0);

    const multiple = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20, initialCapital: 30000 })
      .expect(201);
    const multipleId = multiple.body.session.id;
    const first = await request(app)
      .post(`/api/quant/replay/sessions/${multipleId}/orders`)
      .send({
        actionId: "first-buy",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const second = await request(app)
      .post(`/api/quant/replay/sessions/${multipleId}/orders`)
      .send({
        actionId: "second-buy",
        expectedRevision: first.body.session.revision,
        side: "buy",
        quantity: 100,
      })
      .expect(201);
    const advanced = await request(app)
      .post(`/api/quant/replay/sessions/${multipleId}/advance`)
      .send({
        actionId: "advance-two-buys",
        expectedRevision: second.body.session.revision,
      })
      .expect(200);
    assert.deepEqual(
      advanced.body.session.executions.map((item) => [
        item.status,
        item.reasonCode ?? null,
      ]),
      [
        ["filled", null],
        ["rejected", "insufficient_cash"],
      ],
    );
    assert.ok(advanced.body.session.account.cash >= 0);
    assert.equal(advanced.body.session.account.positionQuantity, 100);
  });

  it("strictly validates order and concurrency fields", async () => {
    const created = await request(app)
      .post("/api/quant/replay/sessions")
      .send({ gameLength: 20 })
      .expect(201);
    const sessionId = created.body.session.id;
    for (const payload of [
      { expectedRevision: 0, side: "buy", quantity: 100 },
      { actionId: "missing-revision", side: "buy", quantity: 100 },
      {
        actionId: "two-sizes",
        expectedRevision: 0,
        side: "buy",
        quantity: 100,
        cashRatio: 0.5,
      },
      {
        actionId: "wrong-buy-ratio",
        expectedRevision: 0,
        side: "buy",
        positionRatio: 1,
      },
      {
        actionId: "wrong-sell-ratio",
        expectedRevision: 0,
        side: "sell",
        cashRatio: 1,
      },
      {
        actionId: "small-order",
        expectedRevision: 0,
        side: "buy",
        quantity: 99,
      },
    ]) {
      await request(app)
        .post(`/api/quant/replay/sessions/${sessionId}/orders`)
        .send(payload)
        .expect(400);
    }
    await request(app)
      .post(`/api/quant/replay/sessions/${sessionId}/advance`)
      .send({})
      .expect(400);
  });
});
