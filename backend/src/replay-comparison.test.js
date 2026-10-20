import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReplayComparison } from "./replay-comparison.js";

function session({
  id,
  attemptNumber,
  kind = "first",
  revealedAt = "2026-10-20T10:00:00.000Z",
  initialCapital = 100,
  completed = 3,
  score = null,
  scoreAlgorithmVersion = "replay-score-v3",
  executions = [],
  costConfig = { commissionRate: 0.001, minCommission: 0, stampTaxRate: 0, transferFeeRate: 0, slippageBps: 0 },
}) {
  return {
    id,
    createdAt: `2026-10-20T10:0${attemptNumber}:00.000Z`,
    revealedAt,
    status: revealedAt ? "completed" : "active",
    completionReason: revealedAt ? "natural" : null,
    observationBars: 1,
    gameLength: 3,
    revealedFutureBars: completed,
    account: { initialCapital, positionQuantity: 0 },
    costConfig,
    executionModelVersion: "bar-orders-v2",
    scoringConfig: { algorithmVersion: "replay-score-v3", weights: { riskControl: 20 } },
    snapshot: {
      bars: [
        { close: 10, tradeDate: "2026-10-01" },
        { close: 11, tradeDate: "2026-10-02", tradeTime: "09:35" },
        { close: 9, tradeDate: "2026-10-03", tradeTime: "09:40" },
        { close: 9, tradeDate: "2026-10-04", tradeTime: "09:45" },
      ],
    },
    attemptInfo: { attemptNumber, kind, countsTowardFirstScore: kind === "first", sourceSessionId: kind === "retrain" ? "first" : null },
    executions,
    review: { blindReview: { thesis: "原始判断" }, postReview: { outcome: "partial" }, scoreCard: score ? { algorithmVersion: scoreAlgorithmVersion, total: score, metrics: { totalReturnPct: score } } : null },
    corrections: [{ id: "c1", stage: "post", revisionNumber: 1, fullReviewSnapshot: { outcome: "wrong" }, changeNote: "修正", createdAt: "2026-10-21T00:00:00.000Z" }],
  };
}

describe("replay comparison aggregation", () => {
  it("keeps first identity across retrains and exposes relative executions", () => {
    const first = session({
      id: "first",
      attemptNumber: 1,
      score: 70,
      executions: [{ orderId: "o1", executionId: "f1", status: "filled", sequence: 2, side: "buy", quantity: 10, price: 10, notional: 100, totalFee: 1, decision: { thesis: "first" } }],
    });
    const retrain = session({
      id: "retrain",
      attemptNumber: 2,
      kind: "retrain",
      score: 80,
      executions: [{ orderId: "o2", executionId: "r1", status: "filled", sequence: 3, side: "sell", quantity: 10, price: 9, notional: 90, totalFee: 2, decision: { thesis: "retry" } }],
    });
    const result = buildReplayComparison({ selectedSession: retrain, attempts: [first, retrain] });
    assert.equal(result.firstSessionId, "first");
    assert.deepEqual(result.counts, { first: 1, retrain: 1 });
    assert.equal(result.attempts[1].executions[0].step, 2);
    assert.equal(result.attempts[1].executions[0].tradeDate, "2026-10-03");
    assert.equal(result.attempts[1].comparison.comparable, true);
    assert.equal(result.attempts[1].comparison.delta.scoreTotal, 10);
    assert.equal(result.attempts[1].corrections[0].changeNote, "修正");
  });

  it("redacts unrevealed attempts and blocks deltas for different conditions", () => {
    const first = session({ id: "first", attemptNumber: 1, score: 70 });
    const unrevealed = session({ id: "hidden", attemptNumber: 2, kind: "retrain", revealedAt: null });
    const different = session({ id: "different", attemptNumber: 3, kind: "retrain", initialCapital: 200 });
    const result = buildReplayComparison({ selectedSession: first, attempts: [first, unrevealed, different] });
    const hidden = result.attempts.find((item) => item.id === "hidden");
    assert.equal(hidden.available, false);
    assert.equal(Object.hasOwn(hidden, "metrics"), false);
    const changed = result.attempts.find((item) => item.id === "different");
    assert.equal(changed.comparison.comparable, false);
    assert.equal(changed.comparison.delta, null);
    assert.match(changed.comparison.reasons[0], /初始资金不同/u);
  });

  it("does not compare scores when frozen score-card versions disagree", () => {
    const first = session({ id: "first-version", attemptNumber: 1, score: 70, scoreAlgorithmVersion: "replay-score-v2" });
    const current = session({ id: "current-version", attemptNumber: 2, kind: "retrain", score: 80, scoreAlgorithmVersion: "replay-score-v3" });
    const result = buildReplayComparison({ selectedSession: current, attempts: [first, current] });
    const compared = result.attempts.find((item) => item.id === "current-version");
    assert.equal(compared.comparison.comparable, false);
    assert.equal(compared.comparison.delta, null);
    assert.ok(compared.comparison.reasons.includes("评分规则不同"));
  });
});


it("does not compare a legacy score of unknown version with an explicitly versioned score", () => {
  const first = session({ id: "first", attemptNumber: 1, score: 70 });
  const retrain = session({ id: "retry", attemptNumber: 2, kind: "retrain", score: 80 });
  delete first.review.scoreCard.algorithmVersion;
  retrain.review.scoreCard.algorithmVersion = "replay-score-v3";
  const comparison = buildReplayComparison({ selectedSession: retrain, attempts: [first, retrain] });
  assert.equal(comparison.attempts[1].comparison.comparable, false);
  assert.equal(comparison.attempts[1].comparison.delta, null);
  assert.ok(comparison.attempts[1].comparison.reasons.includes("评分规则不同"));
});
