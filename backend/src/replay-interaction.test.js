import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicErrorCode } from "./app.js";
import { createReplayInteraction, ReplayInteractionError } from "./replay-interaction.js";

const bars = Array.from({ length: 270 }, (_, i) => ({
  tradeDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
  open: 10, high: 11, low: 9, close: 10, volume: 100, amount: 1000,
}));

function session(overrides = {}) {
  return {
    id: "s1", sourceDataVersion: "v1", gameLength: 20, observationBars: 250,
    revealedFutureBars: 0, status: "active", revision: 0,
    snapshot: { interval: "1d", bars, benchmark: { code: "000001.SH" }, tsCode: "600000.SH" },
    account: { initialCapital: 100000, cash: 100000, positionQuantity: 0, availableQuantity: 0, lockedQuantity: 0, averageCost: 0, totalFees: 0, realizedPnl: 0 },
    costConfig: { commissionRate: 0.0003, minCommission: 5, stampTaxRate: 0.0005, transferFeeRate: 0.00001, slippageBps: 5 },
    trainingConfig: { mode: "free" }, pendingOrders: [], executions: [], corrections: [], reviewDrafts: {},
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}

function makeInteraction(initial = session()) {
  const state = new Map([[initial.id, initial]]);
  const calls = [];
  const store = {
    calls,
    getScenarioUsage: () => ({ usedTsCodes: [], recentWindowEndDates: [] }),
    createSession: (value) => { state.set(value.id, value); return value; },
    getSession: (id) => state.get(id) ?? null,
    listSessions: (query) => ({ query, items: [...state.values()].map((value) => ({ id: value.id, status: value.status })) }),
    submitOrder: (command) => { calls.push(["submitOrder", command]); return { created: true, idempotent: false, session: state.get(command.sessionId) }; },
    saveReviewDraft: (command) => { calls.push(["saveReviewDraft", command]); return { ...state.get(command.sessionId), reviewDrafts: { [command.stage]: { ...command.draft, revision: 1, updatedAt: "now" } } }; },
    saveBlindReview: (command) => { calls.push(["saveBlindReview", command]); return { saved: true, idempotent: false, session: state.get(command.sessionId) }; },
    savePostReview: (command) => { calls.push(["savePostReview", command]); return { saved: true, idempotent: false, session: state.get(command.sessionId) }; },
    appendReviewCorrection: (command) => { calls.push(["appendReviewCorrection", command]); return { saved: true, idempotent: true, correction: { id: "c1" }, session: state.get(command.sessionId) }; },
    updateReviewCorrection: (command) => { calls.push(["updateReviewCorrection", command]); return { correction: { id: command.correctionId }, session: state.get(command.sessionId) }; },
    deleteReviewCorrection: (command) => { calls.push(["deleteReviewCorrection", command]); return { deleted: true, idempotent: true, session: state.get(command.sessionId) }; },
    revealSession: (command) => { calls.push(["revealSession", command]); return { revealed: true, idempotent: false, session: session({ ...state.get(command.sessionId), revealedFutureBars: 20, revision: 1 }) }; },
  };
  const interaction = createReplayInteraction({
    store, scenarioSource: { createReplayScenario: async () => ({ sourceDataVersion: "v1", tsCode: "600000.SH", interval: "1d", observationBars: 250, gameLength: 20, bars }), prefetchReplayStocks: async () => {} },
    createId: () => "created", now: () => "now",
  });
  return { interaction, store };
}

describe("createReplayInteraction", () => {
  it("keeps the existing Express error code contract", async () => {
    assert.equal(publicErrorCode(new ReplayInteractionError("INVALID_REPLAY_COMMAND", "bad", 400)), "INVALID_REQUEST");
    assert.equal(publicErrorCode(new ReplayInteractionError("REPLAY_SESSION_NOT_FOUND", "missing", 404)), "NOT_FOUND");
  });

  it("normalizes list/query and hides future identity and bars before reveal", () => {
    const { interaction } = makeInteraction();
    assert.deepEqual(interaction.list({ state: "active", page: "2", pageSize: "10" }).query, { state: "active", attemptKind: "all", keyword: "", page: 2, pageSize: 10 });
    const projected = interaction.get("s1").session;
    assert.equal(projected.revealed, false);
    assert.equal(projected.reveal, undefined);
    assert.equal(projected.bars.length, 250);
    assert.equal(projected.bars.at(-1).tradeDate, undefined);
  });

  it("uses stable 404 and validation errors", () => {
    const { interaction } = makeInteraction();
    assert.throws(() => interaction.get("missing"), (error) => error instanceof ReplayInteractionError && error.status === 404 && error.code === "REPLAY_SESSION_NOT_FOUND");
    assert.throws(() => interaction.submitOrder("s1", { actionId: "a", expectedRevision: 0, side: "buy" }), /只能指定一种数量/);
    assert.rejects(() => interaction.create({ interval: "1d", gameLength: 1 }), /只支持/);
  });

  it("delegates orders, blind review, draft, post review, correction, reveal and preserves revisions", () => {
    const { interaction, store } = makeInteraction();
    interaction.submitOrder("s1", { actionId: "order-1", expectedRevision: 0, side: "buy", quantity: 100 });
    interaction.saveReviewDraft("s1", "blind", { expectedRevision: 0, draft: { thesis: "draft" } });
    interaction.saveBlindReview("s1", { actionId: "blind-1", expectedRevision: 0, strategyName: "", thesis: "这是一个足够长的判断内容", tradePlan: "这是一个足够长的交易计划", riskPlan: "这是一个足够长的风险计划", confidence: 3, reasonTags: ["趋势"] });
    interaction.savePostReview("s1", { actionId: "post-1", expectedRevision: 0, outcome: "correct", executionReview: "这是足够长的执行复盘内容", mistakes: "无", lessons: "这是一个足够长的经验总结", disciplineScore: 4, riskControlScore: 4 });
    interaction.appendReviewCorrection("s1", "blind", { actionId: "fix-1", expectedRevision: 0, changeNote: "修正", strategyName: "", thesis: "这是一个足够长的判断内容", tradePlan: "这是一个足够长的交易计划", riskPlan: "这是一个足够长的风险计划", confidence: 3, reasonTags: ["趋势"] });
    interaction.updateReviewCorrection("s1", "blind", "c1", { actionId: "fix-2", expectedRevision: 0, changeNote: "再次修正", strategyName: "", thesis: "这是一个足够长的判断内容", tradePlan: "这是一个足够长的交易计划", riskPlan: "这是一个足够长的风险计划", confidence: 3, reasonTags: ["趋势"] });
    interaction.deleteReviewCorrection("s1", "blind", "c1", { actionId: "fix-3", expectedRevision: 0 });
    interaction.reveal("s1", { actionId: "reveal-1", expectedRevision: 0 });
    assert.deepEqual(store.calls.map(([name]) => name), ["submitOrder", "saveReviewDraft", "saveBlindReview", "savePostReview", "appendReviewCorrection", "updateReviewCorrection", "deleteReviewCorrection", "revealSession"]);
    assert.equal(store.calls[0][1].requestPayload.expectedRevision, 0);
    assert.equal(store.calls[0][1].actionId, "order-1");
    assert.equal(store.calls[4][1].expectedRevision, 0);
    assert.equal(interaction.appendReviewCorrection("s1", "blind", { actionId: "fix-4", expectedRevision: 0, changeNote: "重复", strategyName: "", thesis: "这是一个足够长的判断内容", tradePlan: "这是一个足够长的交易计划", riskPlan: "这是一个足够长的风险计划", confidence: 3, reasonTags: ["趋势"] }).idempotent, true);
  });
});
