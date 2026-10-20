import test from "node:test";
import assert from "node:assert/strict";
import { detectTrainingConditionEvents } from "./replay-training-events.js";

const bar = (close, { low = close, tradeDate = "2026-01-02", tradeTime = 1500 } = {}) => ({
  open: close,
  high: close,
  low,
  close,
  volume: 1000,
  tradeDate,
  tradeTime,
});

const session = ({ bars, model = "legacy-next-open", interval = "1d", observationBars = 0, revealedFutureBars = bars.length } = {}) => ({
  observationBars,
  revealedFutureBars,
  executionModelVersion: model,
  snapshot: { interval, bars },
});

const buy = ({ id = "buy-1", sequence = 1, quantity = 100, decision = {} } = {}) => ({
  id,
  side: "buy",
  submittedSequence: sequence,
  decision,
  fills: [{ sequence, side: "buy", quantity }],
});

test("legacy stop touch is emitted once and survives a rebound", () => {
  const result = detectTrainingConditionEvents({
    session: session({ bars: [bar(10), bar(9, { low: 8.8 }), bar(10.2, { low: 9.9 }), bar(8.7, { low: 8.5 })] }),
    orders: [buy({ decision: { stopLossPrice: 9 } })],
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    key: "stop_touch:buy-1:2:1",
    kind: "stop_touch",
    orderId: "buy-1",
    sequence: 2,
    ruleStartSequence: 1,
    basis: "touch",
    operator: "lte",
    threshold: 9,
    price: 8.8,
    source: "frozen_decision",
    automatic: false,
  });
});

test("bar-order stop uses persisted trigger and requires a filled parent", () => {
  const bars = [bar(10), bar(9.8, { low: 9.6 }), bar(9.1, { low: 9.05 })];
  const result = detectTrainingConditionEvents({
    session: session({ bars, model: "bar-orders-v2" }),
    orders: [
      buy({ id: "parent", decision: { stopLossPrice: 9.5 } }),
      {
        id: "protect-1",
        side: "sell",
        submittedSequence: 1,
        sourceOrderId: "parent",
        orderType: "stop",
        stopPrice: 9.5,
        triggeredSequence: 2,
        triggerPrice: 9.5,
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "execution");
  assert.equal(result[0].automatic, true);
  assert.equal(result[0].sequence, 2);

  const compactExecutionView = detectTrainingConditionEvents({
    session: session({ bars, model: "bar-orders-v2" }),
    orders: [
      buy({ id: "parent-compact" }),
      {
        id: "protect-compact", side: "sell", orderType: "stop", stopPrice: 9.5,
        triggeredSequence: 2, triggerPrice: 9.5,
      },
    ],
  });
  assert.equal(compactExecutionView.length, 1);

  const noParentFill = detectTrainingConditionEvents({
    session: session({ bars, model: "bar-orders-v2" }),
    orders: [{
      id: "protect-2", side: "sell", orderType: "stop", sourceOrderId: "never-filled",
      stopPrice: 9.5, triggeredSequence: 2, triggerPrice: 9.5,
    }],
  });
  assert.deepEqual(noParentFill, []);
});

test("compact execution records preserve a same-bar protection trigger", () => {
  const result = detectTrainingConditionEvents({
    session: {
      observationBars: 0,
      revealedFutureBars: 1,
      executionModelVersion: "bar-orders-v2",
      snapshot: { interval: "1d", bars: [bar(8.9, { low: 8.8 })] },
      executions: [
        {
          orderId: "compact-buy",
          side: "buy",
          status: "filled",
          sequence: 1,
          quantity: 100,
          submittedSequence: 1,
          decision: { stopLossPrice: 9 },
        },
        {
          orderId: "compact-stop",
          side: "sell",
          orderType: "stop",
          submittedSequence: 1,
          triggeredSequence: 1,
          triggerPrice: 9,
          stopPrice: null,
          decision: { stopLossPrice: 9 },
        },
      ],
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sequence, 1);
  assert.equal(result[0].ruleStartSequence, 1);
  assert.equal(result[0].threshold, 9);
});

test("T+1 does not erase a persisted stop touch while the position remains held", () => {
  const result = detectTrainingConditionEvents({
    session: session({ bars: [bar(10), bar(8.9, { low: 8.8 })], model: "bar-orders-v1" }),
    orders: [
      buy({ id: "t-plus-one", quantity: 100 }),
      {
        id: "t-plus-one-stop", side: "sell", orderType: "stop", sourceOrderId: "t-plus-one",
        stopPrice: 9, triggeredSequence: 2, triggerPrice: 9,
        // No sell fill is provided: the position is still held under T+1.
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sequence, 2);
});

test("partial fill creates a position and can produce a stop event", () => {
  const result = detectTrainingConditionEvents({
    session: session({ bars: [bar(10), bar(8.9, { low: 8.8 })] }),
    orders: [buy({ quantity: 100, decision: { stopLossPrice: 9 } })],
  });
  assert.equal(result.length, 1);
});

test("invalidation waits for a complete hybrid trading day", () => {
  const bars = [
    bar(10, { tradeDate: "2026-01-02", tradeTime: 930 }),
    bar(8.5, { tradeDate: "2026-01-02", tradeTime: 1400 }),
    bar(8.4, { tradeDate: "2026-01-02", tradeTime: 1500 }),
    bar(8.3, { tradeDate: "2026-01-05", tradeTime: 930 }),
  ];
  const result = detectTrainingConditionEvents({
    session: session({ bars, interval: "hybrid", revealedFutureBars: 4 }),
    orders: [buy({ decision: { invalidationRule: { basis: "close", operator: "lte", threshold: 9 } } })],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sequence, 3);
  assert.equal(result[0].basis, "day_close");
  assert.equal(result[0].price, 8.4);

  const unfinished = detectTrainingConditionEvents({
    session: session({
      bars: bars.slice(0, 2),
      interval: "hybrid",
      revealedFutureBars: 2,
    }),
    orders: [buy({ decision: { invalidationRule: { basis: "close", operator: "lte", threshold: 9 } } })],
  });
  assert.deepEqual(unfinished, []);
});

test("invalidation requires close basis, supports same-bar daily close, and parses close time strings", () => {
  const sameBar = detectTrainingConditionEvents({
    session: session({ bars: [bar(8.8, { low: 8.7 })] }),
    orders: [buy({ decision: { invalidationRule: { basis: "close", operator: "lte", threshold: 9 } } })],
  });
  assert.equal(sameBar.length, 1);
  assert.equal(sameBar[0].sequence, 1);

  const stringClose = detectTrainingConditionEvents({
    session: session({
      interval: "hybrid",
      bars: [
        bar(10, { tradeDate: "2026-01-02", tradeTime: "2026-01-02 09:30" }),
        bar(8.8, { tradeDate: "2026-01-02", tradeTime: "2026-01-02 14:55" }),
      ],
      revealedFutureBars: 2,
    }),
    orders: [buy({ decision: { invalidationRule: { basis: "close", operator: "lte", threshold: 9 } } })],
  });
  assert.equal(stringClose.length, 1);
  assert.equal(stringClose[0].sequence, 2);

  const truncated = detectTrainingConditionEvents({
    session: session({
      interval: "hybrid",
      bars: [
        bar(10, { tradeDate: "2026-01-02", tradeTime: "2026-01-02 09:30" }),
        bar(8.8, { tradeDate: "2026-01-02", tradeTime: "2026-01-02 13:00" }),
      ],
      revealedFutureBars: 2,
    }),
    orders: [buy({ decision: { invalidationRule: { basis: "close", operator: "lte", threshold: 9 } } })],
  });
  assert.deepEqual(truncated, []);

  const wrongBasis = detectTrainingConditionEvents({
    session: session({ bars: [bar(8.8)] }),
    orders: [buy({ decision: { invalidationRule: { basis: "touch", operator: "lte", threshold: 9 } } })],
  });
  assert.deepEqual(wrongBasis, []);
});

test("an unfilled replacement cannot replace a filled plan", () => {
  const result = detectTrainingConditionEvents({
    session: session({ bars: [bar(10), bar(9.4, { low: 9.4 }), bar(8.8, { low: 8.7 })] }),
    orders: [
      buy({ id: "filled", sequence: 1, decision: { stopLossPrice: 9 } }),
      { id: "unfilled", side: "buy", submittedSequence: 2, decision: { stopLossPrice: 9.5 }, fills: [] },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].orderId, "filled");
  assert.equal(result[0].threshold, 9);
});

test("a later filled plan replaces the earlier plan and a cleared position has no event", () => {
  const bars = [bar(10), bar(9.4, { low: 9.4 }), bar(8.8, { low: 8.7 }), bar(8.2, { low: 8.1 })];
  const replaced = detectTrainingConditionEvents({
    session: session({ bars }),
    orders: [
      buy({ id: "first", sequence: 1, decision: { stopLossPrice: 9 } }),
      buy({ id: "second", sequence: 3, decision: { stopLossPrice: 8.5 } }),
    ],
  });
  assert.deepEqual(replaced.map((event) => [event.orderId, event.sequence, event.threshold]), [["first", 3, 9], ["second", 4, 8.5]]);

  const cleared = detectTrainingConditionEvents({
    session: session({ bars }),
    orders: [
      buy({ id: "held", sequence: 1, decision: { stopLossPrice: 9 } }),
      { id: "exit", side: "sell", submittedSequence: 2, fills: [{ sequence: 2, side: "sell", quantity: 100 }] },
    ],
  });
  assert.deepEqual(cleared, []);
});

test("fromSequence limits historical results without changing rule evaluation", () => {
  const result = detectTrainingConditionEvents({
    session: session({ bars: [bar(10), bar(8.9, { low: 8.8 }), bar(8.7, { low: 8.6 })] }),
    orders: [buy({ decision: { stopLossPrice: 9 } })],
    fromSequence: 3,
  });
  assert.deepEqual(result, []);
});
