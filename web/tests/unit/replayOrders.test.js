import assert from "node:assert/strict";
import { test } from "node:test";
import { useReplaySession } from "../../src/composables/useReplaySession.js";
import { buildReplayOrderSubmission } from "../../src/utils/replayReviewPresentation.js";
import { getReplayAutoplayStopReason } from "../../src/utils/replayAutoplay.js";

test("order ticket sends limit price and whole-position stop protection through the public payload", () => {
  const limit = buildReplayOrderSubmission({ side: "buy", inputMode: "shares", quantity: 5000,
    orderType: "limit", limitPrice: "10", stopLossPrice: "9.8" });
  assert.equal(limit.limitPrice, 10);
  assert.equal(limit.quantity, 5000);
  assert.equal(limit.decision.stopLossPrice, 9.8);
  const stop = buildReplayOrderSubmission({ side: "sell", orderType: "stop", protectionPrice: "9.8", quantity: 100 });
  assert.equal(stop.stopPrice, 9.8);
  assert.equal(stop.positionRatio, 1);
  assert.equal(Object.hasOwn(stop, "quantity"), false);
});

test("cancelling updates the session revision and a conflict reloads the authoritative session", async () => {
  let state = { id: "orders", revision: 4, status: "active", pendingOrders: [{ orderId: "stop" }] };
  let conflict = false;
  const calls = [];
  const controller = useReplaySession({ restoreOnMount: false,
    storage: { getItem: () => "orders", setItem() {}, removeItem() {} },
    client: {
      getReplaySession: async () => ({ session: state }),
      cancelReplayOrder: async (id, orderId, command) => {
        calls.push({ id, orderId, command });
        if (conflict) throw Object.assign(new Error("版本冲突"), { status: 409 });
        state = { ...state, revision: 5, pendingOrders: [] };
        return { session: state };
      },
    },
  });
  await controller.refreshSession();
  await controller.cancelOrder("stop");
  assert.equal(calls[0].command.expectedRevision, 4);
  assert.equal(controller.session.value.revision, 5);
  assert.equal(controller.isBusy.value, false);
  conflict = true;
  state = { ...state, revision: 6 };
  assert.equal(await controller.cancelOrder("another"), null);
  assert.equal(controller.session.value.revision, 6);
  assert.match(controller.statusMessage.value, /已刷新/);
  assert.equal(controller.isBusy.value, false);
});

test("armed protection permits autoplay while actual execution pauses for review", () => {
  const session = { id: "orders", status: "active", executionModelVersion: "bar-orders-v1",
    pendingOrders: [{ orderType: "stop", triggeredSequence: null }], executions: [] };
  assert.equal(getReplayAutoplayStopReason(session), "");
  session.executions.push({ status: "filled" });
  assert.match(getReplayAutoplayStopReason(session, { executionStartIndex: 0 }), /已有成交或状态变化/);
});
