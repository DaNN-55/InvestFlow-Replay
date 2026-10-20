import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";

import { buildReplayTrainingAnalytics } from "./replay-training-analytics.js";
import { startAnalyticsTestServer } from "./test-support/analytics-server.js";

let fixture;
let client;

before(async () => {
  fixture = await startAnalyticsTestServer();
  client = request(fixture.server);
});

after(async () => {
  await fixture?.close();
});

test("analytics keeps first and retrain groups separate and redacts unrevealed sessions", async () => {
  const response = await client.get("/api/quant/replay/analytics").expect(200);
  assert.deepEqual(response.body.filters, {
    from: null,
    to: null,
    interval: "all",
    gameLength: "all",
    board: "all",
  });
  assert.equal(response.body.groups.first.counts.sessions, 2);
  assert.equal(response.body.groups.retrain.counts.sessions, 3);
  assert.equal(response.body.groups.retrain.counts.unrevealed, 1);
  assert.equal(response.body.groups.first.distributions.returns.n, 1);
  assert.equal(response.body.groups.retrain.distributions.returns.n, 2);
  assert.ok(response.body.groups.first.distributions.returns.median != null);
  assert.equal(response.body.groups.retrain.issues.length, 0);
  assert.equal(Object.hasOwn(response.body, "tsCode"), false);
  assert.equal(Object.hasOwn(response.body.groups.retrain, "sessions"), false);
});

test("analytics applies interval, board and Beijing creation-date filters", async () => {
  for (const query of ["from=2026-02-30", "gameLength=5", "interval=1m&gameLength=20", "from=2026-10-20&to=2026-10-19"]) await client.get(`/api/quant/replay/analytics?${query}`).expect(400);
  const response = await client.get("/api/quant/replay/analytics?interval=1d&board=main").expect(200);
  assert.equal(response.body.filters.interval, "1d");
  assert.equal(response.body.groups.first.counts.sessions, 2);
  assert.equal(response.body.groups.retrain.counts.sessions, 3);

  const empty = await client.get("/api/quant/replay/analytics?board=star").expect(200);
  assert.equal(empty.body.groups.first.counts.sessions, 0);
  assert.equal(empty.body.groups.first.distributions.returns.n, 0);
  assert.equal(empty.body.groups.first.distributions.returns.median, null);
});

test("analytics pure aggregation only counts explicitly confirmed issue tags", () => {
  const session = {
    id: "s1",
    status: "completed",
    revealedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    gameLength: 20,
    observationBars: 1,
    revealedFutureBars: 1,
    snapshot: { interval: "1d", tsCode: "600000.SH", bars: [{ close: 10 }, { close: 10 }] },
    account: { initialCapital: 100000 },
    attemptInfo: { kind: "first", attemptNumber: 1 },
    executions: [],
    review: { postReview: { mistakes: "追涨导致开仓过早", issueTags: ["追涨"] }, scoreCard: null },
    corrections: [],
  };
  const result = buildReplayTrainingAnalytics({ sessions: [session], filters: {} });
  const hidden = { ...session, id: "hidden", status: "active", revealedAt: null, review: { postReview: { issueTags: ["退出犹豫"] } } };
  const demo = { ...session, id: "demo", snapshot: { ...session.snapshot, exchange: "DEMO", tsCode: "DEMO001.SYN", priceAdjustment: { factorSource: "fixture-generator" } } };
  const excluded = buildReplayTrainingAnalytics({ sessions: [session, hidden, demo], filters: {} }).groups.first;
  assert.equal(excluded.counts.sessions, 2);
  assert.equal(excluded.counts.analysed, 1);
  assert.equal(excluded.distributions.returns.n, 1);
  assert.equal(excluded.issues.length, 1);
  assert.equal(excluded.issues[0].samples.some(item => item.sessionId === "hidden"), false);
  assert.equal(result.groups.first.counts.tagged, 1);
  assert.deepEqual(result.groups.first.issues[0].tag, "追涨");
});

test("cohorts keep earlier and recent windows disjoint and leave earlier empty below 21 samples", () => {
  const sessions = Array.from({ length: 21 }, (_, index) => ({
    id: `cohort-${index}`,
    status: "completed",
    revealedAt: "2026-02-01T00:00:00.000Z",
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    gameLength: 1,
    observationBars: 1,
    revealedFutureBars: 1,
    snapshot: { interval: "1d", tsCode: "600000.SH", bars: [{ close: 10 }, { close: 10 }] },
    account: { initialCapital: 100000 },
    attemptInfo: { kind: "first", attemptNumber: 1 },
    executions: [],
    pendingOrders: [],
    review: { postReview: null, scoreCard: null },
    corrections: [],
  }));
  const result = buildReplayTrainingAnalytics({ sessions, filters: {} });
  assert.equal(result.groups.first.cohorts.earlier.n, 1);
  assert.equal(result.groups.first.cohorts.recent.n, 20);
  assert.equal(result.groups.first.cohorts.earlier.to < result.groups.first.cohorts.recent.from, true);
  const short = buildReplayTrainingAnalytics({ sessions: sessions.slice(0, 20), filters: {} });
  assert.equal(short.groups.first.cohorts.earlier.n, 0);
  assert.equal(short.groups.first.cohorts.recent.n, 20);
});

test("execution facts count for all revealed sessions while condition denominator stays separate", () => {
  const base = {
    status: "completed", revealedAt: "2026-02-01T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z",
    gameLength: 1, observationBars: 1, revealedFutureBars: 1,
    snapshot: { interval: "1d", tsCode: "600000.SH", bars: [{ close: 10 }, { close: 10 }] },
    account: { initialCapital: 100000 }, attemptInfo: { kind: "first", attemptNumber: 1 }, review: { postReview: null, scoreCard: null }, corrections: [],
  };
  const conditionSession = {
    ...base,
    id: "condition",
    executions: [
      { orderId: "buy", side: "buy", status: "filled", quantity: 100, sequence: 2, decision: { stopLossPrice: 9.9 } },
      { orderId: "stop", side: "sell", orderType: "stop", status: "filled", quantity: 50, sequence: 3, stopPrice: 9.9 },
    ],
  };
  const ordinarySession = {
    ...base,
    id: "ordinary",
    executions: [
      { orderId: "buy2", side: "buy", status: "filled", quantity: 100, sequence: 2 },
      { orderId: "sell2", side: "sell", status: "rejected", reasonCode: "insufficient_sellable", quantity: 0 },
    ],
    pendingOrders: [{ orderId: "sell2", side: "sell", orderType: "limit", status: "pending", targetQuantity: 100, filledQuantity: 0, remainingQuantity: 100 }],
  };
  const eventsBySession = new Map([
    [conditionSession.id, [{ eventType: "training_execution_observed", payload: { observations: [{ side: "sell", orderType: "stop", status: "filled", filledThisStep: 50, filledQuantity: 50, remainingQuantity: 50 }] } }]],
  ]);
  const result = buildReplayTrainingAnalytics({ sessions: [conditionSession, ordinarySession], eventsBySession, filters: {} });
  assert.equal(result.groups.first.events.evaluableSessions, 1);
  assert.equal(result.groups.first.events.autoExitSessions, 1);
  assert.equal(result.groups.first.events.partialFillSessions, 1);
  assert.equal(result.groups.first.events.exitOrderSessions, 2);
  assert.equal(result.groups.first.events.protectedSessions, 1);
  assert.equal(result.groups.first.events.restrictedSessions, 1);
  assert.equal(result.groups.first.counts.uncomputable, 1);
  const stoppedAtEnd = { ...ordinarySession, pendingOrders: [], executions: [...ordinarySession.executions, { orderId: "stop-end", side: "sell", orderType: "stop", stopPrice: 9, status: "cancelled", reasonCode: "session_finished_early" }] };
  assert.equal(buildReplayTrainingAnalytics({ sessions: [stoppedAtEnd] }).groups.first.events.stopCancelledSessions, 0);
  stoppedAtEnd.executions.at(-1).reasonCode = "cancelled_by_user";
  assert.equal(buildReplayTrainingAnalytics({ sessions: [stoppedAtEnd] }).groups.first.events.stopCancelledSessions, 1);
});

test("post correction tags are effective and deletion falls back without changing the score", async () => {
  const sessionId = fixture.sessionIds.retrain3;
  const detail = await client.get(`/api/quant/replay/sessions/${sessionId}`).expect(200);
  const beforeScore = detail.body.session.scoreCard;
  const correction = await client.post(`/api/quant/replay/sessions/${sessionId}/reviews/post/corrections`).send({
    actionId: "analytics-tag-correction",
    expectedRevision: detail.body.session.revision,
    changeNote: "确认一个问题标签",
    outcome: "partial",
    executionReview: "补充成交执行过程的复盘说明，保留原始执行事实。",
    mistakes: "开仓确认稍早，应该继续等待承接信号。",
    lessons: "把承接确认纳入下一次练习的执行清单。",
    disciplineScore: 4,
    riskControlScore: 4,
    strategyAdjustment: "增加成交后观察记录。",
    issueTags: ["提前入场"],
  }).expect(200);
  assert.deepEqual(correction.body.session.scoreCard, beforeScore);
  let report = await client.get("/api/quant/replay/analytics").expect(200);
  assert.equal(report.body.groups.retrain.issues[0].tag, "提前入场");
  const correctionId = correction.body.correction.id;
  const current = await client.get(`/api/quant/replay/sessions/${sessionId}`).expect(200);
  await client.delete(`/api/quant/replay/sessions/${sessionId}/reviews/post/corrections/${correctionId}`).send({
    actionId: "analytics-tag-correction-delete",
    expectedRevision: current.body.session.revision,
  }).expect(200);
  report = await client.get("/api/quant/replay/analytics").expect(200);
  assert.equal(report.body.groups.retrain.issues.length, 0);
});

test("advance records deduplicated objective condition events in the same ledger", async () => {
  const created = await client.post("/api/quant/replay/sessions").send({ gameLength: 20, benchmarkCode: "000001.SH" }).expect(201);
  const sessionId = created.body.session.id;
  const order = await client.post(`/api/quant/replay/sessions/${sessionId}/orders`).send({
    actionId: "analytics-event-order",
    expectedRevision: 0,
    side: "buy",
    quantity: 5000,
    decision: {
      reasonTags: ["突破"],
      confidence: 4,
      thesis: "价格突破整理区间，量价配合后尝试建仓。",
      plan: "开仓后观察承接，跌破止损价则退出。",
      riskPlan: "单次风险控制在计划范围内，严格执行止损。",
      stopLossPrice: 9.9,
      invalidationRule: null,
    },
  }).expect(201);
  const first = await client.post(`/api/quant/replay/sessions/${sessionId}/advance`).send({ actionId: "analytics-event-advance-1", expectedRevision: order.body.session.revision }).expect(200);
  const second = await client.post(`/api/quant/replay/sessions/${sessionId}/advance`).send({ actionId: "analytics-event-advance-2", expectedRevision: first.body.session.revision }).expect(200);
  const retried = await client.post(`/api/quant/replay/sessions/${sessionId}/advance`).send({ actionId: "analytics-event-advance-2", expectedRevision: first.body.session.revision }).expect(200);
  assert.equal(retried.body.idempotent, true);
  assert.equal(retried.body.session.revision, second.body.session.revision);
  const sqlite = new DatabaseSync(`${fixture.root}/replay.sqlite`);
  const rows = sqlite.prepare("SELECT event_type, payload_json FROM replay_events WHERE session_id = ? AND event_type = 'training_condition_triggered'").all(sessionId);
  const observed = sqlite.prepare("SELECT sequence, payload_json FROM replay_events WHERE session_id = ? AND event_type = 'training_execution_observed' ORDER BY sequence").all(sessionId);
  sqlite.close();
  assert.equal(rows.length, 1);
  assert.equal(observed.length, 2);
  assert.equal(JSON.parse(observed[0].payload_json).observations[0].filledThisStep > 0, true);
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ruleKey, "stop_touch");
  assert.ok(payload.dedupeKey);
  assert.equal(JSON.parse(observed[0].payload_json).observations.some(item => item.reasonCode === "insufficient_sellable"), true);
  let saved = await client.post(`/api/quant/replay/sessions/${sessionId}/finish`).send({ actionId: "analytics-finish", expectedRevision: second.body.session.revision }).expect(200);
  saved = await client.post(`/api/quant/replay/sessions/${sessionId}/reviews/blind`).send({
    actionId: "analytics-blind", expectedRevision: saved.body.session.revision,
    strategyName: "趋势练习", thesis: "等待整理突破后确认成交与风险边界。", tradePlan: "观察突破后承接并设置明确止损保护。",
    riskPlan: "止损触发后继续退出并记录受限原因。", confidence: 4, trendView: "bullish", outlook: "bullish", reasonTags: ["突破"], stopLossPrice: 9.9, invalidationRule: null,
  }).expect(200);
  await client.post(`/api/quant/replay/sessions/${sessionId}/reveal`).send({ actionId: "analytics-reveal", expectedRevision: saved.body.session.revision }).expect(200);
  const aggregate = (await client.get("/api/quant/replay/analytics").expect(200)).body.groups.retrain;
  // The first T+1 restriction remains visible after the stop has fully filled,
  // and revealed results do not require a later post-review to be included.
  assert.equal(aggregate.events.evaluableSessions, 1);
  assert.equal(aggregate.events.stopTriggeredSessions, 1);
  assert.equal(aggregate.events.autoExitSessions, 1);
  assert.equal(aggregate.events.protectedSessions, 1);
  assert.equal(aggregate.events.restrictedSessions, 1);
  assert.equal(aggregate.counts.analysed, 3);
});

test("analytics filters by Beijing boundary, full filter tuple and stays read-only; deletion is excluded", async () => {
  const sqlite = new DatabaseSync(`${fixture.root}/replay.sqlite`);
  sqlite.prepare("UPDATE replay_sessions SET created_at = ? WHERE id = ?").run("2026-01-01T15:59:59.000Z", fixture.sessionIds.first);
  sqlite.prepare("UPDATE replay_sessions SET created_at = ? WHERE id = ?").run("2026-01-01T16:00:00.000Z", fixture.sessionIds.isolated);
  sqlite.close();
  const before = readFileSync(`${fixture.root}/replay.sqlite`);
  const boundary = await client.get("/api/quant/replay/analytics?from=2026-01-01&to=2026-01-01&interval=1d&gameLength=20&board=main").expect(200);
  assert.equal(boundary.body.groups.first.counts.sessions, 1);
  assert.equal(boundary.body.groups.retrain.counts.sessions, 0);
  assert.equal(Buffer.compare(before, readFileSync(`${fixture.root}/replay.sqlite`)), 0);
  const allBeforeDelete = await client.get("/api/quant/replay/analytics").expect(200);
  await client.delete(`/api/quant/replay/sessions/${fixture.sessionIds.isolated}`).expect(200);
  const allAfterDelete = await client.get("/api/quant/replay/analytics").expect(200);
  assert.equal(allAfterDelete.body.groups.first.counts.sessions, allBeforeDelete.body.groups.first.counts.sessions - 1);
});
