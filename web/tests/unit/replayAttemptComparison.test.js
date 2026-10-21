import assert from "node:assert/strict";
import test from "node:test";
import { buildAttemptComparisonRows, formatComparisonExecution, formatComparisonValue, selectComparisonAttempt } from "../../src/utils/replayAttemptComparison.js";

test("comparison preserves missing scores and unavailable attempts instead of inventing zero results", () => {
  const first = { available: true, scoreCard: null, metrics: { totalReturnPct: 0, totalTradingCosts: 0 } };
  const pending = { available: false, metrics: { totalReturnPct: 99 }, comparison: { delta: null } };
  const rows = buildAttemptComparisonRows(first, pending);
  assert.equal(rows.find(item => item.key === "scoreTotal").first, "—");
  assert.equal(rows.find(item => item.key === "totalReturnPct").first, "0.00%");
  assert.equal(rows.find(item => item.key === "totalReturnPct").attempt, "—");
  assert.ok(rows.every(item => item.delta === "—"));
  assert.equal(formatComparisonValue(null, "money"), "—");
});

test("only server-approved comparable deltas render, with percentage points rather than percent returns", () => {
  const first = { available: true, scoreCard: { total: 80 }, metrics: { totalReturnPct: -2, totalTradingCosts: 30 } };
  const retrain = { available: true, scoreCard: { total: 83 }, metrics: { totalReturnPct: 1, totalTradingCosts: 17.5 }, comparison: { comparable: true, delta: { totalReturnPct: 3, scoreTotal: 3, totalTradingCosts: -12.5 } } };
  const rows = buildAttemptComparisonRows(first, retrain);
  assert.equal(rows.find(item => item.key === "totalReturnPct").delta, "+3.00 个百分点");
  assert.equal(rows.find(item => item.key === "scoreTotal").delta, "+3.00 分");
  assert.equal(rows.find(item => item.key === "totalTradingCosts").delta, "−¥12.50");
});

test("comparison opens selected retrain across generations and never promotes a retrain to first", () => {
  const attempts = [{ id: "r2", kind: "retrain", available: true }, { id: "r3", kind: "retrain", available: true }, { id: "r4", kind: "retrain", available: false }];
  assert.equal(selectComparisonAttempt(attempts, "r2"), "r2");
  assert.equal(selectComparisonAttempt(attempts, "first-deleted"), "r3");
  assert.equal(selectComparisonAttempt(attempts, "r4"), "r4");
  assert.equal(selectComparisonAttempt([], "unknown"), "");
});

test("trade comparison retains actual partial-fill quantities and separates unfilled exits", () => {
  assert.equal(formatComparisonExecution({ step: 3, side: "buy", status: "filled", quantity: 501, price: 10, totalFee: 5 }), "第 3 步 · 买入 501 股 · ¥10.00 · 费用 ¥5.00");
  assert.equal(formatComparisonExecution({ step: 4, side: "sell", status: "rejected", quantity: 5000 }), "第 4 步 · 卖出 未成交");
});
