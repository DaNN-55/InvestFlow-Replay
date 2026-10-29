import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOrderTestServer } from './test-support/order-server.js';

test('five-character decisions, reviews and corrections persist with full completeness; four characters and unchanged maxima reject', async () => {
  const fixture = await startOrderTestServer();
  try {
    const base = `${fixture.url}/api/quant/replay/sessions`, text = '按计划执行';
    let response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameLength: 20, interval: 'hybrid' }) });
    assert.equal(response.status, 201); let { session } = await response.json();
    const url = `${base}/${session.id}`;
    async function action(path, body = {}, expected = 200, method = 'POST') {
      const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId: crypto.randomUUID(), expectedRevision: session.revision, ...body }) });
      const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result));
      if (result.session) session = result.session;
      return result;
    }
    const decision = { reasonTags: ['回踩'], confidence: 3, thesis: text, plan: text, riskPlan: text, stopLossPrice: 9.8, invalidationRule: null };
    for (const field of ['thesis', 'plan', 'riskPlan']) {
      for (const invalid of ['继续观察', '  继续观察  ', '字'.repeat(field === 'riskPlan' ? 1001 : 2001)]) {
        await action('/orders', { side: 'buy', quantity: 100, decision: { ...decision, [field]: invalid } }, 400);
      }
    }
    await action('/orders', { side: 'buy', quantity: 100, decision: { ...decision, thesis: ` ${text} ` } }, 201);
    assert.equal(session.pendingOrders[0].decision.thesis, text);
    await action('/advance', { mode: 'day' }); await action('/advance', { mode: 'minute' });
    const sell = { reasonTags: ['风险'], confidence: 3, thesis: text, plan: text, exitType: 'reduce_risk', remainingPositionPlan: '继续观察' };
    for (const field of ['thesis', 'plan']) await action('/orders', { side: 'sell', quantity: 100, decision: { ...sell, [field]: '继续观察' } }, 400);
    await action('/orders', { side: 'sell', quantity: 100, decision: sell }, 201);
    await action('/finish');
    const blind = { thesis: text, tradePlan: text, riskPlan: text, confidence: 3, trendView: 'bullish', outlook: 'bullish', reasonTags: ['回踩'], stopLossPrice: null, invalidationRule: null };
    async function boundaries(path, payload, fields, extra = {}) {
      for (const field of fields) {
        await action(path, { ...payload, ...extra, [field]: '继续观察' }, 400);
        await action(path, { ...payload, ...extra, [field]: '字'.repeat(field === 'riskPlan' ? 1001 : 2001) }, 400);
      }
    }
    await boundaries('/reviews/blind', blind, ['thesis', 'tradePlan', 'riskPlan']);
    await action('/reviews/blind', { ...blind, thesis: ` ${text} ` }); assert.equal(session.review.blindReview.thesis, text);
    await action('/reveal');
    const post = { outcome: 'partial', executionReview: text, mistakes: '无', lessons: text, disciplineScore: 3, riskControlScore: 3 };
    await boundaries('/reviews/post', post, ['executionReview', 'lessons']); await action('/reviews/post', post);
    const score = session.scoreCard;
    assert.equal(score.completeness.completedRequiredFields, score.completeness.totalRequiredFields);
    for (const [stage, payload, fields] of [['blind', blind, ['thesis', 'tradePlan', 'riskPlan']], ['post', post, ['executionReview', 'lessons']]]) {
      const path = `/reviews/${stage}/corrections`, extra = { changeNote: '修正' };
      await boundaries(path, payload, fields, extra); const result = await action(path, { ...payload, ...extra });
      assert.equal(result.correction.fullReviewSnapshot[fields[0]], text);
      await action(`${path}/${result.correction.id}`, { ...payload, ...extra, [fields[0]]: '继续观察' }, 400, 'PATCH');
      await action(`${path}/${result.correction.id}`, { ...payload, ...extra }, 200, 'PATCH');
      assert.deepEqual(session.scoreCard, score);
    }
    session = (await (await fetch(url)).json()).session;
    assert.equal(session.review.postReview.lessons, text); assert.equal(session.review.blindReview.thesis, text);
    assert.equal(session.scoreCard.completeness.completedRequiredFields, session.scoreCard.completeness.totalRequiredFields);
  } finally { await fixture.close(); }
});
