import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as tradeLicense from "../../src/utils/tradeLicense.js";

const { calculateTradeLicense } = tradeLicense;

describe("calculateTradeLicense", () => {
  it("applies the selected per-trade risk budget to the planned quantity", () => {
    const result = calculateTradeLicense({
      triggerPrice: 20,
      failurePrice: 19,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.25,
      maxPositionPct: 30,
      lotSize: 100,
    });

    assert.equal(result.valid, true);
    assert.equal(result.riskBudgetAmount, 250);
    assert.equal(result.plannedQuantity, 100);
    assert.equal(result.estimatedMaxLossAmount, 166);
  });

  it("requires an explicit manual single-stock position cap", () => {
    const result = calculateTradeLicense({
      triggerPrice: 10,
      failurePrice: 9,
      targetPrice: 13,
      accountEquity: 100000,
      maxAccountRiskPct: 0.5,
      maxPositionPct: null,
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "INVALID_POSITION_CAP" && item.message.includes("单票最大仓位")));

    const excessive = calculateTradeLicense({
      triggerPrice: 10,
      failurePrice: 9,
      targetPrice: 13,
      accountEquity: 100000,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 101,
    });
    assert.equal(excessive.valid, false);
  });

  it("rejects a risk budget above one hundred percent", () => {
    const result = calculateTradeLicense({
      triggerPrice: 10,
      failurePrice: 9,
      targetPrice: 13,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 101,
      maxPositionPct: 30,
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "INVALID_ACCOUNT_RISK"));
  });

  it("derives the no-chase price and risk-limited position from three manual anchors", () => {
    const result = calculateTradeLicense({
      triggerPrice: 20,
      failurePrice: 19,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 30,
      lotSize: 100,
    });

    assert.equal(result.valid, true);
    assert.equal(result.plannedEntryLow, 20);
    assert.equal(result.plannedEntryHigh, 20.66);
    assert.equal(result.noChasePrice, 20.66);
    assert.equal(result.stopLossPrice, 19);
    assert.equal(result.takeProfitPrice, 24);
    assert.equal(result.plannedQuantity, 300);
    assert.equal(result.plannedAmount, 6198);
    assert.equal(result.estimatedMaxLossAmount, 498);
    assert.ok(result.rewardRiskRatioAtTrigger > 3.9);
    assert.ok(result.rewardRiskRatioAtWorstEntry >= 2);
  });

  it("applies the diagnosis position cap before returning the share quantity", () => {
    const result = calculateTradeLicense({
      triggerPrice: 20,
      failurePrice: 19,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 2,
      maxPositionPct: 10,
      lotSize: 100,
    });

    assert.equal(result.valid, true);
    assert.equal(result.plannedQuantity, 400);
    assert.equal(result.plannedAmount, 8264);
    assert.ok(result.plannedPositionPct < 10);
  });

  it("rejects invalid anchor ordering and plans smaller than one board lot", () => {
    const invalidOrder = calculateTradeLicense({
      triggerPrice: 19,
      failurePrice: 20,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 10,
    });
    assert.equal(invalidOrder.valid, false);
    assert.ok(invalidOrder.errors.some((item) => item.code === "INVALID_PRICE_ORDER"));

    const tooSmall = calculateTradeLicense({
      triggerPrice: 100,
      failurePrice: 90,
      targetPrice: 140,
      accountEquity: 1000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 10,
    });
    assert.equal(tooSmall.valid, false);
    assert.ok(tooSmall.errors.some((item) => item.code === "QUANTITY_BELOW_LOT"));
  });
});

describe("trade record draft payload", () => {
  it("omits an untouched manual cap for legacy records but preserves explicit input", () => {
    assert.equal(typeof tradeLicense.buildTradeRecordDraftSavePayload, "function");

    const untouched = tradeLicense.buildTradeRecordDraftSavePayload({
      accountType: "simulated",
      manualMaxPositionPct: "",
      entryNotes: "legacy",
    }, { legacyPositionCap: true });
    const explicit = tradeLicense.buildTradeRecordDraftSavePayload({
      accountType: "simulated",
      manualMaxAccountRiskPct: "0.35",
      manualMaxPositionPct: "12",
    }, { legacyPositionCap: true });
    const newRecord = tradeLicense.buildTradeRecordDraftSavePayload({
      accountType: "simulated",
      manualMaxPositionPct: "",
    }, { legacyPositionCap: false });

    assert.equal(Object.hasOwn(untouched, "manualMaxPositionPct"), false);
    assert.equal(explicit.manualMaxPositionPct, "12");
    assert.equal(explicit.manualMaxAccountRiskPct, "0.35");
    assert.equal(newRecord.manualMaxPositionPct, null);
  });

  it("preserves the optional record-level risk budget in the draft payload", () => {
    const payload = tradeLicense.buildTradeRecordDraftSavePayload({
      accountType: "simulated",
      manualMaxAccountRiskPct: "1.2",
      manualMaxPositionPct: "20",
    });

    assert.equal(payload.manualMaxAccountRiskPct, "1.2");
  });

  it("uses the same legacy plan fallback order as the backend", () => {
    assert.equal(typeof tradeLicense.resolveLegacyTradeRecordPlan, "function");

    assert.equal(tradeLicense.resolveLegacyTradeRecordPlan({
      frozenSnapshot: {},
      evaluationSnapshot: { tradingPlan: { maxPositionPct: 13 } },
    }).maxPositionPct, 13);
    assert.equal(tradeLicense.resolveLegacyTradeRecordPlan({
      frozenSnapshot: { tradingPlan: { maxPositionPct: 12 } },
      evaluationSnapshot: { tradingPlan: { maxPositionPct: 13 } },
    }).maxPositionPct, 12);
    assert.equal(tradeLicense.resolveLegacyTradeRecordPlan({
      tradingPlanSummary: { maxPositionPct: 11 },
      frozenSnapshot: { tradingPlan: { maxPositionPct: 12 } },
    }).maxPositionPct, 11);
  });
});
