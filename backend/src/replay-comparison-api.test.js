import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import request from "supertest";

import { startComparisonTestServer } from "./test-support/comparison-server.js";

let fixture;
let client;

before(async () => {
  fixture = await startComparisonTestServer();
  client = request(fixture.server);
});

after(async () => {
  await fixture?.close();
});

test("comparison API keeps multi-generation identity, redacts pending attempts, and preserves frozen scores", async () => {
  const { first, retrain2, retrain3, hidden, isolated } = fixture.sessionIds;
  const comparison = await client.get(`/api/quant/replay/sessions/${retrain3}/comparison`).expect(200);
  assert.equal(comparison.body.firstSessionId, first);
  assert.equal(comparison.body.selectedSessionId, retrain3);
  assert.deepEqual(comparison.body.counts, { first: 1, retrain: 3 });
  assert.equal(comparison.body.attempts.length, 4);
  const selected = comparison.body.attempts.find((item) => item.id === retrain3);
  assert.equal(selected.available, true);
  assert.equal(selected.sourceSessionId, retrain2);
  assert.equal(comparison.body.attempts.find((item) => item.id === retrain2).sourceSessionId, first);
  assert.equal(typeof selected.scoreCard.total, "number");
  const firstAttempt = comparison.body.attempts.find((item) => item.id === first);
  assert.ok(firstAttempt.executions[0].totalFee > 5);
  assert.equal(firstAttempt.executions[0].step, 1);
  const pending = comparison.body.attempts.find((item) => item.id === hidden);
  assert.equal(pending.available, false);
  assert.equal(Object.hasOwn(pending, "metrics"), false);
  assert.equal(Object.hasOwn(pending, "executions"), false);

  await client.get(`/api/quant/replay/sessions/${hidden}/comparison`).expect(409);
  const isolatedComparison = await client.get(`/api/quant/replay/sessions/${isolated}/comparison`).expect(200);
  assert.equal(isolatedComparison.body.firstSessionId, isolated);
  assert.deepEqual(isolatedComparison.body.counts, { first: 1, retrain: 0 });

  const scoreBefore = selected.scoreCard;
  const detail = await client.get(`/api/quant/replay/sessions/${retrain3}`).expect(200);
  const correctionPayload = {
    actionId: "comparison-correction",
    expectedRevision: detail.body.session.revision,
    changeNote: "补充复盘说明",
    outcome: "partial",
    executionReview: "修正后仍保留原始执行事实，补充对成交时点的解释。",
    mistakes: "未及时确认成交后的价格变化。",
    lessons: "继续按成交后价格变化记录执行复盘。",
    disciplineScore: 5,
    riskControlScore: 4,
    strategyAdjustment: "增加成交后观察记录。",
  };
  await client.post(`/api/quant/replay/sessions/${retrain3}/reviews/post/corrections`).send(correctionPayload).expect(200);
  const afterCorrection = await client.get(`/api/quant/replay/sessions/${retrain3}/comparison`).expect(200);
  const scoreAfter = afterCorrection.body.attempts.find((item) => item.id === retrain3).scoreCard;
  assert.deepEqual(scoreAfter, scoreBefore);

  const sqlite = new DatabaseSync(fixture.root + "/replay.sqlite");
  sqlite.prepare("UPDATE replay_sessions SET cost_config_json = ? WHERE id = ?").run(JSON.stringify({ commissionRate: 0.002, minCommission: 0, stampTaxRate: 0, transferFeeRate: 0, slippageBps: 0 }), retrain2);
  sqlite.close();
  const changed = await client.get(`/api/quant/replay/sessions/${retrain3}/comparison`).expect(200);
  const changedAttempt = changed.body.attempts.find((item) => item.id === retrain2);
  assert.equal(changedAttempt.comparison.comparable, false);
  assert.equal(changedAttempt.comparison.delta, null);
  assert.ok(changedAttempt.comparison.reasons.includes("费用设置不同"));

  await client.delete(`/api/quant/replay/sessions/${first}`).expect(200);
  const afterDelete = await client.get(`/api/quant/replay/sessions/${retrain3}/comparison`).expect(200);
  assert.equal(afterDelete.body.firstSessionId, null);
  assert.equal(afterDelete.body.firstUnavailable, "deleted");
  assert.equal(afterDelete.body.counts.first, 0);
});
