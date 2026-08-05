import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTradeRecordAnalytics } from "../../src/utils/tradeRecordAnalytics.js";

describe("buildTradeRecordAnalytics", () => {
  it("uses the authoritative ledger for a completed multi-fill trade", () => {
    const result = buildTradeRecordAnalytics([
      {
        status: "exited",
        actualEntryPrice: 10,
        actualExitPrice: 9,
        violations: [],
        ledger: {
          state: "closed",
          returnPct: 12.5,
        },
      },
    ]);

    assert.deepEqual(result.summary, {
      completedCount: 1,
      winRatePct: 100,
      averageProfitPct: 12.5,
      deviationRatePct: 0,
    });
  });

  it("groups completed trades by market phase, mainline and candidate role", () => {
    const result = buildTradeRecordAnalytics([
      {
        status: "exited",
        actualEntryPrice: 10,
        actualExitPrice: 11,
        actualEntryQuantity: 100,
        violations: [],
        frozenSnapshot: { candidateContext: { marketPhase: "up_continuation", sectorName: "油气", candidateRole: "趋势龙头" } },
      },
      {
        status: "reviewed",
        actualEntryPrice: 10,
        actualExitPrice: 9,
        actualEntryQuantity: 100,
        violations: ["OUTSIDE_ENTRY_RANGE"],
        frozenSnapshot: { candidateContext: { marketPhase: "weak_flat", sectorName: "油气", candidateRole: "连板龙头" } },
      },
    ]);

    assert.deepEqual(result.summary, {
      completedCount: 2,
      winRatePct: 50,
      averageProfitPct: 0,
      deviationRatePct: 50,
    });
    assert.deepEqual(result.groups.marketPhase, [
      { label: "上涨延续", completedCount: 1, winRatePct: 100, averageProfitPct: 10, deviationRatePct: 0 },
      { label: "震荡偏弱", completedCount: 1, winRatePct: 0, averageProfitPct: -10, deviationRatePct: 100 },
    ]);
    assert.deepEqual(result.groups.mainline, [
      { label: "油气", completedCount: 2, winRatePct: 50, averageProfitPct: 0, deviationRatePct: 50 },
    ]);
    assert.deepEqual(result.groups.role, [
      { label: "趋势龙头", completedCount: 1, winRatePct: 100, averageProfitPct: 10, deviationRatePct: 0 },
      { label: "连板龙头", completedCount: 1, winRatePct: 0, averageProfitPct: -10, deviationRatePct: 100 },
    ]);
  });
});
