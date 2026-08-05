import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import request from "supertest";

import { createApp } from "./app.js";

describe("trade license API", () => {
  let root;
  let app;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "investflow-trade-license-"));
    app = createApp({
      dbPath: join(root, "workbench.sqlite"),
      rankingDbPath: join(root, "mainline-rankings.sqlite"),
      storageRoot: join(root, "storage"),
      workspaceRoot: root,
      tradeRecordsRoot: join(root, "trade-records"),
      clock: () => new Date("2026-07-15T04:00:00.000Z"),
    });
  });

  after(() => {
    app.dispose();
    app.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists execution settings with strict defaults", async () => {
    const initial = await request(app).get("/api/quant/decision/execution-settings");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, {
      simulatedAccountEquity: null,
      liveAccountEquity: null,
      defaultMinRewardRiskRatio: 2,
      defaultMaxAccountRiskPct: 0.5,
      lotSize: 100,
    });

    const updated = await request(app)
      .put("/api/quant/decision/execution-settings")
      .send({
        simulatedAccountEquity: 100000,
        liveAccountEquity: 250000,
        defaultMinRewardRiskRatio: 2.5,
        defaultMaxAccountRiskPct: 0.6,
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.simulatedAccountEquity, 100000);
    assert.equal(updated.body.defaultMinRewardRiskRatio, 2.5);
    assert.equal(updated.body.lotSize, 100);

    const invalidRiskBudget = await request(app)
      .put("/api/quant/decision/execution-settings")
      .send({ defaultMaxAccountRiskPct: 101 });
    assert.equal(invalidRiskBudget.status, 400);
    assert.match(invalidRiskBudget.body.error.message, /单笔风险预算/);
  });

  it("accepts a trade record diagnosis snapshot larger than the Express default limit", async () => {
    const largeSnapshotText = "诊断快照".repeat(30000);
    const payload = {
      stockCode: "300738",
      stockName: "奥飞数据",
      accountType: "simulated",
      tradeType: "system",
      status: "draft",
      validForTradeDate: "2026-07-15",
      frozenSnapshot: {
        diagnosis: largeSnapshotText,
      },
      evaluationSnapshot: {
        diagnosis: largeSnapshotText,
      },
    };

    const payloadSize = Buffer.byteLength(JSON.stringify(payload), "utf8");
    assert.ok(payloadSize > 100 * 1024);
    assert.ok(payloadSize < 2 * 1024 * 1024);

    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send(payload);

    assert.equal(created.status, 201);
    assert.equal(created.body.stockCode, "300738");
    assert.equal(created.body.frozenSnapshot.diagnosis, largeSnapshotText);
    assert.equal(created.body.evaluationSnapshot.diagnosis, largeSnapshotText);
  });

  it("persists a frozen strategy profile and calculates an authoritative ledger from execution events", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "002829",
        stockName: "星网宇达",
        accountType: "simulated",
        tradeType: "subjective",
        status: "draft",
        strategyProfile: {
          key: "z-girl-candidate",
          name: "少妇战法（固定记录模板）",
          version: "StockLLM整理版 v1",
          summary: "只做主线核心和情绪拐点。",
          entryRules: "等待超预期拐点。",
          exitRules: "跌破防守线退出。",
          riskRules: "先设最大亏损。",
        },
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.strategyProfile.key, "z-girl-candidate");
    assert.deepEqual(created.body.executionEvents, []);

    const firstEvent = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/execution-events`)
      .send({
        eventAt: "2026-07-15 09:45",
        action: "buy",
        price: 10,
        quantity: 500,
        fee: 5,
        planStatus: "planned",
        source: "盘中",
        note: "情绪拐点确认后试错。",
      });
    assert.equal(firstEvent.status, 200);
    assert.equal(firstEvent.body.executionEvents.length, 1);
    assert.equal(firstEvent.body.executionEvents[0].action, "buy");
    assert.deepEqual(firstEvent.body.ledger, {
      state: "open",
      buyQuantity: 500,
      sellQuantity: 0,
      positionQuantity: 500,
      averageCost: 10.01,
      grossBuyAmount: 5000,
      grossSellAmount: 0,
      totalBuyCost: 5005,
      netSellProceeds: 0,
      totalFees: 5,
      realizedPnl: 0,
      lastPrice: 10,
      marketValue: 5000,
      unrealizedPnl: -5,
      totalPnl: -5,
      returnPct: -0.0999,
      tradeEventCount: 1,
      unplannedEventCount: 0,
    });

    const added = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/execution-events`)
      .send({
        eventAt: "2026-07-16 09:45",
        action: "add",
        price: 11,
        quantity: 300,
        fee: 5,
        source: "盘中",
      });
    assert.equal(added.status, 200);

    const reduced = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/execution-events`)
      .send({
        eventAt: "2026-07-17 10:20",
        action: "reduce",
        price: 12,
        quantity: 400,
        fee: 5,
        planStatus: "unplanned",
        source: "盘中",
      });
    assert.equal(reduced.status, 200);
    assert.equal(reduced.body.executionEvents.length, 3);
    assert.equal(reduced.body.status, "holding");
    assert.deepEqual(reduced.body.ledger, {
      state: "open",
      buyQuantity: 800,
      sellQuantity: 400,
      positionQuantity: 400,
      averageCost: 10.3875,
      grossBuyAmount: 8300,
      grossSellAmount: 4800,
      totalBuyCost: 8310,
      netSellProceeds: 4795,
      totalFees: 15,
      realizedPnl: 640,
      lastPrice: 12,
      marketValue: 4800,
      unrealizedPnl: 645,
      totalPnl: 1285,
      returnPct: 15.4633,
      tradeEventCount: 3,
      unplannedEventCount: 1,
    });

    const oversold = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/execution-events`)
      .send({
        eventAt: "2026-07-18 10:20",
        action: "sell",
        price: 12.5,
        quantity: 500,
      });
    assert.equal(oversold.status, 400);
    assert.match(oversold.body.error.message, /超过当前持仓/);
  });

  it("creates a standalone trade record without diagnosis data and validates its required identity", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "600519",
        stockName: "贵州茅台",
        accountType: "live",
        tradeType: "subjective",
        status: "draft",
      });

    assert.equal(created.status, 201);
    assert.equal(created.body.stockCode, "600519");
    assert.equal(created.body.accountType, "live");
    assert.equal(created.body.frozenSnapshot, undefined);
    assert.equal(created.body.ledger.state, "not_started");

    const missingStock = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
      });
    assert.equal(missingStock.status, 400);
    assert.match(missingStock.body.error.message, /股票代码/);
  });

  it("issues an authoritative license and rejects an entry above its no-chase price", async () => {
    await request(app)
      .put("/api/quant/decision/execution-settings")
      .send({
        simulatedAccountEquity: 100000,
        defaultMinRewardRiskRatio: 2,
        defaultMaxAccountRiskPct: 0.5,
      });
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "002829",
        stockName: "星网宇达",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        manualMaxPositionPct: 30,
      });
    assert.equal(created.status, 201);

    const licensed = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    assert.equal(licensed.status, 200);
    assert.equal(licensed.body.status, "planned");
    assert.equal(licensed.body.plannedEntryHigh, 20.66);
    assert.equal(licensed.body.plannedQuantity, 300);
    assert.equal(licensed.body.licenseSnapshot.accountEquity, 100000);
    assert.equal(licensed.body.licenseSnapshot.minRewardRiskRatio, 2);

    const rejected = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/entry`)
      .send({
        actualEntryDate: "2026-07-15",
        actualEntryPrice: 20.67,
        actualEntryQuantity: 300,
      });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /不追价/);

    const entered = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/entry`)
      .send({
        actualEntryDate: "2026-07-15",
        actualEntryPrice: 20.5,
        actualEntryQuantity: 300,
      });
    assert.equal(entered.status, 200);
    assert.equal(entered.body.status, "entered");
    assert.equal(entered.body.executionEvents.length, 1);
    assert.equal(entered.body.executionEvents[0].action, "buy");
    assert.equal(entered.body.ledger.positionQuantity, 300);
    assert.equal(entered.body.ledger.averageCost, 20.5);

    const exited = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/exit`)
      .send({
        exitSignalType: "target",
        exitSignalDate: "2026-07-15",
        exitSignalPrice: 24,
        actualExitDate: "2026-07-15",
        actualExitPrice: 24.1,
        actualExitQuantity: 300,
      });
    assert.equal(exited.status, 200);
    assert.equal(exited.body.status, "exited");
    assert.equal(exited.body.exitSignalType, "target");
    assert.equal(exited.body.executionEvents.length, 2);
    assert.equal(exited.body.executionEvents[1].action, "sell");
    assert.equal(exited.body.ledger.state, "closed");
    assert.equal(exited.body.ledger.positionQuantity, 0);
    assert.equal(exited.body.ledger.totalPnl, 1080);
  });

  it("keeps the highest observed price and records a holding price observation", async () => {
    await request(app)
      .put("/api/quant/decision/execution-settings")
      .send({
        simulatedAccountEquity: 100000,
        defaultMinRewardRiskRatio: 2,
        defaultMaxAccountRiskPct: 0.5,
      });
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "300738",
        stockName: "奥飞数据",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        manualMaxPositionPct: 30,
      });
    const licensed = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    const entered = await request(app)
      .post(`/api/quant/decision/trade-records/${licensed.body.id}/entry`)
      .send({
        actualEntryDate: "2026-07-15",
        actualEntryPrice: 20,
        actualEntryQuantity: 300,
      });
    assert.equal(entered.status, 200);

    const firstObservation = await request(app)
      .post(`/api/quant/decision/trade-records/${entered.body.id}/price-observation`)
      .send({ observedAt: "2026-07-16", observedPrice: 22 });
    assert.equal(firstObservation.status, 200);
    assert.equal(firstObservation.body.status, "holding");
    assert.equal(firstObservation.body.profitProtectionHighestPrice, 22);
    assert.equal(firstObservation.body.executionEvents.at(-1).action, "hold");
    assert.equal(firstObservation.body.ledger.lastPrice, 22);

    const secondObservation = await request(app)
      .post(`/api/quant/decision/trade-records/${entered.body.id}/price-observation`)
      .send({ observedAt: "2026-07-17", observedPrice: 20.8 });
    assert.equal(secondObservation.status, 200);
    assert.equal(secondObservation.body.profitProtectionCurrentPrice, 20.8);
    assert.equal(secondObservation.body.profitProtectionHighestPrice, 22);
  });

  it("uses the persisted manual position cap for new records and rejects invalid caps", async () => {
    const invalid = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "000333",
        stockName: "美的集团",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        manualMaxPositionPct: 101,
      });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error.message, /单票最大仓位/);

    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "000333",
        stockName: "美的集团",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        manualMaxPositionPct: 5,
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.manualMaxPositionPct, 5);

    const licensed = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    assert.equal(licensed.status, 200);
    assert.equal(licensed.body.licenseSnapshot.maxPositionPct, 5);
    assert.equal(licensed.body.plannedQuantity, 200);
  });

  it("uses a per-record risk budget and keeps the execution default as fallback", async () => {
    const manual = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "600519",
        stockName: "贵州茅台",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        manualMaxAccountRiskPct: 0.25,
        manualMaxPositionPct: 30,
      });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.manualMaxAccountRiskPct, 0.25);

    const manualLicense = await request(app)
      .post(`/api/quant/decision/trade-records/${manual.body.id}/license`)
      .send({});
    assert.equal(manualLicense.status, 200);
    assert.equal(manualLicense.body.licenseSnapshot.maxAccountRiskPct, 0.25);
    assert.equal(manualLicense.body.riskBudgetAmount, 250);
    assert.equal(manualLicense.body.plannedQuantity, 100);

    const fallback = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "601318",
        stockName: "中国平安",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        manualMaxPositionPct: 30,
      });
    assert.equal(fallback.status, 201);

    const fallbackLicense = await request(app)
      .post(`/api/quant/decision/trade-records/${fallback.body.id}/license`)
      .send({});
    assert.equal(fallbackLicense.status, 200);
    assert.equal(fallbackLicense.body.licenseSnapshot.maxAccountRiskPct, 0.5);
    assert.equal(fallbackLicense.body.plannedQuantity, 300);
  });

  it("does not persist retired decision fields from a new trade-record request", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "000651",
        stockName: "格力电器",
        diagnosisDate: "2026-07-15",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        manualMaxPositionPct: null,
        action: "watch_add",
        rating: "buy",
        tradingPlanSummary: { action: "watch_add", maxPositionPct: 30 },
        frozenSnapshot: {
          fitScore: 88,
          technical_score: 90,
          candidateContext: { strategy: "legacy strategy" },
        },
      });

    assert.equal(created.status, 201);
    assert.equal(Object.hasOwn(created.body, "action"), false);
    assert.equal(Object.hasOwn(created.body, "rating"), false);
    assert.equal(Object.hasOwn(created.body, "tradingPlanSummary"), false);
    assert.equal(Object.hasOwn(created.body.frozenSnapshot, "fitScore"), false);
    assert.equal(Object.hasOwn(created.body.frozenSnapshot, "technical_score"), false);
    assert.equal(created.body.frozenSnapshot.candidateContext.strategy, "legacy strategy");

    const fetched = await request(app)
      .get(`/api/quant/decision/trade-records/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(Object.hasOwn(fetched.body, "action"), false);
    assert.equal(Object.hasOwn(fetched.body, "rating"), false);
    assert.equal(Object.hasOwn(fetched.body, "tradingPlanSummary"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot, "fitScore"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot, "technical_score"), false);
    assert.equal(fetched.body.frozenSnapshot.candidateContext.strategy, "legacy strategy");
  });

  it("round-trips diagnosis explanation evidence while stripping retired snapshot fields", async () => {
    const candidateContext = {
      contextId: "20260715:885001.TI:002829",
      source: "market_scan",
      sourceTradeDate: "20260715",
      strategy: "龙头接力（复核）",
      mainlineScore: 86.4,
      persistenceScore: 72,
      leaderScore: 91,
    };
    const modeAssessments = [{
      modeId: "leader_relay",
      modeName: "龙头接力",
      fitScore: 78,
      fitLevel: "matched",
      confidence: "high",
      evidence: ["主线与龙头证据匹配"],
      counterEvidence: [],
      missingData: [],
    }];
    const frozenSnapshot = {
      stockCode: "002829",
      stockName: "星网宇达",
      diagnosisDate: "2026-07-15",
      candidateContext,
      modeAssessments,
      selectedModeId: "leader_relay",
      technical: {
        trend: { status: "bullish" },
        technical_score: 90,
        rating: "buy",
        strategy_signals: { limit_up_board: { score: 100 } },
      },
      tradingPlanSummary: { action: "watch_add", maxPositionPct: 30 },
      boardTapeInput: { sealedAt1430: true },
    };
    const evaluationSnapshot = {
      stock: { code: "002829", name: "星网宇达" },
      analysisDate: "2026-07-15",
      candidateContext,
      modeAssessments,
      recommendedModeId: "leader_relay",
      technical: {
        volume: { status: "normal" },
        final_score: 88,
        score_breakdown: { technical: 90 },
      },
      strategySummary: { limitUpBoard: true },
    };

    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "002829",
        stockName: "星网宇达",
        diagnosisDate: "2026-07-15",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        manualMaxPositionPct: null,
        action: "watch_add",
        rating: "buy",
        tradingPlanSummary: { action: "watch_add", maxPositionPct: 30 },
        frozenSnapshot,
        evaluationSnapshot,
      });

    assert.equal(created.status, 201);
    const fetched = await request(app)
      .get(`/api/quant/decision/trade-records/${created.body.id}`);
    assert.equal(fetched.status, 200);

    for (const snapshotKey of ["frozenSnapshot", "evaluationSnapshot"]) {
      assert.deepEqual(fetched.body[snapshotKey].candidateContext, candidateContext);
      assert.deepEqual(fetched.body[snapshotKey].modeAssessments, modeAssessments);
    }
    assert.equal(fetched.body.frozenSnapshot.technical.trend.status, "bullish");
    assert.equal(fetched.body.evaluationSnapshot.technical.volume.status, "normal");

    assert.equal(Object.hasOwn(fetched.body, "action"), false);
    assert.equal(Object.hasOwn(fetched.body, "rating"), false);
    assert.equal(Object.hasOwn(fetched.body, "tradingPlanSummary"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot, "tradingPlanSummary"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot, "boardTapeInput"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot.technical, "technical_score"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot.technical, "rating"), false);
    assert.equal(Object.hasOwn(fetched.body.frozenSnapshot.technical, "strategy_signals"), false);
    assert.equal(Object.hasOwn(fetched.body.evaluationSnapshot, "strategySummary"), false);
    assert.equal(Object.hasOwn(fetched.body.evaluationSnapshot.technical, "final_score"), false);
    assert.equal(Object.hasOwn(fetched.body.evaluationSnapshot.technical, "score_breakdown"), false);
  });

  it("cleans retired PATCH input without changing legacy fields and updates explanation evidence", async () => {
    const legacyRoot = join(root, "trade-records");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "legacy-patch-snapshot.json"), JSON.stringify({
      id: "legacy-patch-snapshot",
      stockCode: "000001",
      stockName: "平安银行",
      accountType: "simulated",
      tradeType: "system",
      status: "draft",
      action: "legacy_watch",
      tradingPlanSummary: { action: "legacy_watch", maxPositionPct: 10 },
      frozenSnapshot: {
        action: "legacy_snapshot_action",
        candidateContext: { strategy: "旧候选路径", mainlineScore: 60 },
        modeAssessments: [{ modeId: "leader_relay", fitScore: 55 }],
        technical: {
          trend: { status: "neutral" },
          macd: { signal: "legacy" },
          technical_score: 66,
        },
      },
      createdAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    }));

    const updatedCandidateContext = {
      strategy: "更新后的候选路径",
      mainlineScore: 88,
      persistenceScore: 75,
      leaderScore: 92,
    };
    const updatedModeAssessments = [{
      modeId: "leader_relay",
      fitScore: 82,
      fitLevel: "matched",
      confidence: "high",
    }];
    const patched = await request(app)
      .patch("/api/quant/decision/trade-records/legacy-patch-snapshot")
      .send({
        action: "injected_action",
        rating: "injected_rating",
        tradingPlanSummary: { action: "injected_action", maxPositionPct: 99 },
        frozenSnapshot: {
          action: "injected_snapshot_action",
          candidateContext: updatedCandidateContext,
          modeAssessments: updatedModeAssessments,
          technical: {
            trend: { status: "bullish" },
            macd: { signal: "injected" },
            technical_score: 99,
            rating: "injected_rating",
          },
        },
      });

    assert.equal(patched.status, 200);
    assert.equal(patched.body.action, "legacy_watch");
    assert.deepEqual(
      patched.body.tradingPlanSummary,
      { action: "legacy_watch", maxPositionPct: 10 },
    );
    assert.equal(Object.hasOwn(patched.body, "rating"), false);
    assert.equal(patched.body.frozenSnapshot.action, "legacy_snapshot_action");
    assert.deepEqual(patched.body.frozenSnapshot.candidateContext, updatedCandidateContext);
    assert.deepEqual(patched.body.frozenSnapshot.modeAssessments, updatedModeAssessments);
    assert.deepEqual(patched.body.frozenSnapshot.technical.trend, { status: "bullish" });
    assert.deepEqual(patched.body.frozenSnapshot.technical.macd, { signal: "legacy" });
    assert.equal(patched.body.frozenSnapshot.technical.technical_score, 66);
    assert.equal(Object.hasOwn(patched.body.frozenSnapshot.technical, "rating"), false);
  });

  it("cleans retired POST input for an existing id without overwriting legacy fields", async () => {
    const legacyRoot = join(root, "trade-records");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "legacy-post-snapshot.json"), JSON.stringify({
      id: "legacy-post-snapshot",
      stockCode: "000333",
      stockName: "美的集团",
      accountType: "simulated",
      tradeType: "system",
      status: "draft",
      action: "legacy_hold",
      frozenSnapshot: {
        strategySummary: { legacy: true },
        candidateContext: { strategy: "原候选路径", leaderScore: 70 },
        modeAssessments: [{ modeId: "trend", fitScore: 58 }],
        technical: {
          volume: { status: "normal" },
          technical_score: 63,
          rsi: { value: 50 },
        },
      },
      createdAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    }));

    const updatedCandidateContext = {
      strategy: "POST 更新候选路径",
      mainlineScore: 90,
      persistenceScore: 80,
      leaderScore: 93,
    };
    const updatedModeAssessments = [{
      modeId: "trend",
      fitScore: 84,
      fitLevel: "strong",
      confidence: "medium",
    }];
    const posted = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        id: "legacy-post-snapshot",
        action: "injected_action",
        tradingPlanSummary: { action: "injected_action", maxPositionPct: 100 },
        frozenSnapshot: {
          strategySummary: { injected: true },
          candidateContext: updatedCandidateContext,
          modeAssessments: updatedModeAssessments,
          technical: {
            volume: { status: "expanded" },
            technical_score: 100,
            rsi: { value: 99 },
            macd: { signal: "injected" },
          },
        },
      });

    assert.equal(posted.status, 200);
    assert.equal(posted.body.action, "legacy_hold");
    assert.equal(Object.hasOwn(posted.body, "tradingPlanSummary"), false);
    assert.deepEqual(posted.body.frozenSnapshot.strategySummary, { legacy: true });
    assert.deepEqual(posted.body.frozenSnapshot.candidateContext, updatedCandidateContext);
    assert.deepEqual(posted.body.frozenSnapshot.modeAssessments, updatedModeAssessments);
    assert.deepEqual(posted.body.frozenSnapshot.technical.volume, { status: "expanded" });
    assert.equal(posted.body.frozenSnapshot.technical.technical_score, 63);
    assert.deepEqual(posted.body.frozenSnapshot.technical.rsi, { value: 50 });
    assert.equal(Object.hasOwn(posted.body.frozenSnapshot.technical, "macd"), false);
  });

  it("requires a manual position cap for new records but keeps legacy fallback", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "600036",
        stockName: "招商银行",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 10,
        failurePrice: 9,
        targetPrice: 13,
      });
    assert.equal(created.status, 201);

    const rejected = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /单票最大仓位/);

    const legacyRoot = join(root, "trade-records");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "legacy-position-cap.json"), JSON.stringify({
      id: "legacy-position-cap",
      stockCode: "601398",
      stockName: "工商银行",
      accountType: "simulated",
      tradeType: "system",
      status: "draft",
      validForTradeDate: "2026-07-15",
      triggerPrice: 8,
      failurePrice: 7.5,
      targetPrice: 9.5,
      tradingPlanSummary: { action: "watch", maxPositionPct: 10 },
      createdAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    }));

    const patchedLegacy = await request(app)
      .patch("/api/quant/decision/trade-records/legacy-position-cap")
      .send({ entryNotes: "保留历史仓位口径", manualMaxPositionPct: null });
    assert.equal(patchedLegacy.status, 200);
    assert.equal(Object.hasOwn(patchedLegacy.body, "manualMaxPositionPct"), false);

    const legacyLicense = await request(app)
      .post("/api/quant/decision/trade-records/legacy-position-cap/license")
      .send({});
    assert.equal(legacyLicense.status, 200);
    assert.equal(legacyLicense.body.licenseSnapshot.maxPositionPct, 10);

    writeFileSync(join(legacyRoot, "legacy-invalid-position-cap.json"), JSON.stringify({
      id: "legacy-invalid-position-cap",
      stockCode: "601288",
      stockName: "农业银行",
      accountType: "simulated",
      tradeType: "system",
      status: "draft",
      validForTradeDate: "2026-07-15",
      triggerPrice: 6,
      failurePrice: 5.5,
      targetPrice: 7.5,
      tradingPlanSummary: { maxPositionPct: 101 },
      createdAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    }));
    const invalidLegacyLicense = await request(app)
      .post("/api/quant/decision/trade-records/legacy-invalid-position-cap/license")
      .send({});
    assert.equal(invalidLegacyLicense.status, 400);
    assert.match(invalidLegacyLicense.body.error.message, /单票最大仓位/);
  });

  it("records a manual exit for a system trade when an exit reason is provided", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "000001",
        stockName: "平安银行",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 10,
        failurePrice: 9,
        targetPrice: 13,
        manualMaxPositionPct: 20,
      });
    const licensed = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    const entered = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/entry`)
      .send({
        actualEntryDate: "2026-07-15",
        actualEntryPrice: 10,
        actualEntryQuantity: licensed.body.plannedQuantity,
      });
    assert.equal(entered.status, 200);

    const exited = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/exit`)
      .send({
        exitSignalType: "manual",
        exitSignalDate: "2026-07-15",
        exitSignalPrice: 10.5,
        actualExitDate: "2026-07-15",
        actualExitPrice: 10.45,
        actualExitQuantity: licensed.body.plannedQuantity,
        exitReason: "盘中结构转弱，主动退出",
      });
    assert.equal(exited.status, 200);
    assert.equal(exited.body.status, "exited");
    assert.equal(exited.body.exitSignalType, "manual");
    assert.equal(exited.body.exitReason, "盘中结构转弱，主动退出");
  });

  it("normalizes unlicensed planned records to drafts and revokes a license when anchors change", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "600000",
        stockName: "浦发银行",
        accountType: "simulated",
        tradeType: "system",
        status: "planned",
        validForTradeDate: "2026-07-15",
        triggerPrice: 10,
        failurePrice: 9,
        targetPrice: 13,
        manualMaxPositionPct: 20,
      });
    assert.equal(created.body.status, "draft");
    assert.deepEqual(created.body.violations, []);

    const licensed = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/license`)
      .send({});
    assert.equal(licensed.body.status, "planned");

    const revised = await request(app)
      .patch(`/api/quant/decision/trade-records/${created.body.id}`)
      .send({ targetPrice: 14 });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.status, "draft");
    assert.equal(revised.body.licenseSnapshot, null);

    const cancelled = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/cancel`)
      .send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
  });

  it("records off-system entries explicitly as violations", async () => {
    const created = await request(app)
      .post("/api/quant/decision/trade-records")
      .send({
        stockCode: "000002",
        stockName: "纪律测试",
        accountType: "simulated",
        tradeType: "system",
        status: "draft",
        validForTradeDate: "2026-07-15",
        triggerPrice: 20,
        failurePrice: 19,
        targetPrice: 24,
        tradingPlanSummary: { action: "avoid_chasing", maxPositionPct: 20 },
      });

    const violation = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/violation-entry`)
      .send({
        actualEntryDate: "2026-07-15",
        actualEntryPrice: 20.8,
        actualEntryQuantity: 100,
        violationReason: "盘中临时追涨",
      });
    assert.equal(violation.status, 200);
    assert.equal(violation.body.status, "entered");
    assert.equal(violation.body.tradeType, "violation");
    assert.equal(violation.body.violationReason, "盘中临时追涨");
    assert.ok(violation.body.violations.includes("NO_VALID_LICENSE"));

    const exited = await request(app)
      .post(`/api/quant/decision/trade-records/${created.body.id}/exit`)
      .send({
        exitSignalType: "manual",
        exitSignalDate: "2026-07-15",
        exitSignalPrice: 20.3,
        actualExitDate: "2026-07-15",
        actualExitPrice: 20.2,
        actualExitQuantity: 100,
        exitReason: "违规单主动退出",
      });
    assert.equal(exited.status, 200);
    assert.equal(exited.body.status, "exited");
    assert.equal(exited.body.exitSignalType, "manual");
    assert.equal(exited.body.exitReason, "违规单主动退出");
  });
});
