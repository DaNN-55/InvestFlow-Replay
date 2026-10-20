import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import { startOrderTestServer } from "./test-support/order-server.js";

let fixture;
before(async () => { fixture = await startOrderTestServer(); });
after(async () => { await fixture?.close(); });

test("HTTP limit orders and partial cancellation persist without leaking future identity", async () => {
  const client = request(fixture.server);
  const created = await client.post("/api/quant/replay/sessions").send({ gameLength: 20, interval: "hybrid" }).expect(201);
  const path = `/api/quant/replay/sessions/${created.body.session.id}`;
  assert.equal(created.body.session.executionModelVersion, "bar-orders-v2");
  const order = await client.post(`${path}/orders`).send({ actionId: "limit", expectedRevision: 0,
    side: "buy", quantity: 5000, orderType: "limit", limitPrice: 10 }).expect(201);
  let session = order.body.session;
  for (let i = 0; i < 2; i++) {
    const response = await client.post(`${path}/advance`).send({ actionId: `step-${i}`, expectedRevision: session.revision }).expect(200);
    session = response.body.session;
  }
  assert.equal(session.account.positionQuantity, 1000);
  assert.equal(session.pendingOrders[0].remainingQuantity, 4000);
  const cancelPath = `${path}/orders/${session.pendingOrders[0].orderId}/cancel`;
  const command = { actionId: "cancel", expectedRevision: session.revision };
  const cancelled = await client.post(cancelPath).send(command).expect(200);
  assert.equal(cancelled.body.session.pendingOrders.length, 0);
  assert.equal((await client.post(cancelPath).send(command).expect(200)).body.idempotent, true);
  const restored = (await client.get(path).expect(200)).body.session;
  assert.deepEqual(restored, cancelled.body.session);
  const serialized = JSON.stringify(restored);
  for (const hidden of ["tradeDate", "2024-10-21", "测试股票", "000001.SZ", "expirySequence", "feeByDay"]) assert.equal(serialized.includes(hidden), false, hidden);
  await client.post(cancelPath).send({ actionId: "bad-cancel", expectedRevision: restored.revision, force: true }).expect(400);
});

test("HTTP rejects malformed order types and stop parameters without changing the session", async () => {
  const client = request(fixture.server);
  const created = await client.post("/api/quant/replay/sessions").send({ gameLength: 20 }).expect(201);
  const path = `/api/quant/replay/sessions/${created.body.session.id}`;
  for (const extra of [{ orderType: "unknown" }, { orderType: "limit" }, { orderType: "market", limitPrice: 10 },
    { orderType: "limit", limitPrice: 10.005 }, { orderType: "stop", stopPrice: 9.8 }]) {
    await client.post(`${path}/orders`).send({ actionId: "bad", expectedRevision: 0, side: "buy", quantity: 100, ...extra }).expect(400);
  }
  assert.equal((await client.get(path)).body.session.revision, 0);
  await client.post(`${path}/orders`).send({ actionId: "invalid-protection", expectedRevision: 0, side: "buy", quantity: 100,
    decision: { confidence: 3, reasonTags: ["回踩"], thesis: "价格到达事先观察的支撑范围", plan: "等待确认后按原计划持仓观察",
      riskPlan: "跌破既定防守价后执行预设止损", stopLossPrice: 9.801 } }).expect(400);
  assert.equal((await client.get(path)).body.session.revision, 0);
});
