import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReplayIndicatorExpressionError,
  evaluateReplayAdvancedIndicator,
  evaluateReplayIndicator,
  parseReplayIndicatorExpression,
  validateReplayIndicatorExpression,
} from "../../src/utils/replayIndicatorEngine.js";

const bars = [
  { open: 9, high: 11, low: 8, close: 10, volume: 100, amount: 1000 },
  { open: 10, high: 13, low: 9, close: 12, volume: 120, amount: 1440 },
  { open: 12, high: 15, low: 11, close: 14, volume: 90, amount: 1260 },
  { open: 14, high: 16, low: 12, close: 13, volume: 150, amount: 1950 },
  { open: 13, high: 17, low: 12, close: 16, volume: 180, amount: 2880 },
  { open: 16, high: 18, low: 14, close: 15, volume: 110, amount: 1650 },
];

describe("replay indicator expression engine", () => {
  it("calculates nested expressions and arithmetic without executable code", () => {
    const result = evaluateReplayIndicator(
      "MA(close, 3) - REF(MA(close, 2), 1)",
      bars,
    );

    assert.equal(result.error, null);
    assert.deepEqual(result.values.slice(0, 3), [null, null, 1]);
    assert.equal(result.values[3], 0);
    assert.ok(Math.abs(result.values[5] - 1 / 6) < 1e-12);
  });

  it("never changes revealed values when future bars are appended", () => {
    const expression = "EMA(close, 3) + MAX(high, 2) - MIN(low, 2)";
    for (let revealedCount = 1; revealedCount < bars.length; revealedCount += 1) {
      const prefix = evaluateReplayIndicator(
        expression,
        bars.slice(0, revealedCount),
      );
      const complete = evaluateReplayIndicator(expression, bars);
      assert.equal(prefix.error, null);
      assert.deepEqual(
        prefix.values,
        complete.values.slice(0, revealedCount),
        `第 ${revealedCount} 根 K 线的计算读取了未来数据`,
      );
    }
  });

  it("rejects unknown fields, functions, arbitrary JavaScript and bad periods", () => {
    for (const expression of [
      "price",
      "SUM(close, 3)",
      "globalThis.alert(1)",
      "close; alert(1)",
      "MA(close, 0)",
      "REF(close, 1.5)",
      "MA(close + 1)",
    ]) {
      const validation = validateReplayIndicatorExpression(expression);
      assert.equal(validation.valid, false, expression);
      assert.ok(validation.error, expression);

      const result = evaluateReplayIndicator(expression, bars);
      assert.deepEqual(result.values, []);
      assert.ok(result.error, expression);
    }

    assert.throws(
      () => parseReplayIndicatorExpression("close[0]"),
      ReplayIndicatorExpressionError,
    );
  });

  it("handles empty bars, invalid field values, division by zero and windows", () => {
    assert.deepEqual(evaluateReplayIndicator("close", null), {
      values: [],
      error: null,
    });
    assert.deepEqual(
      evaluateReplayIndicator("close / (high - high)", bars).values,
      Array.from({ length: bars.length }, () => null),
    );

    const withInvalidValue = [
      ...bars.slice(0, 2),
      { ...bars[2], close: "not-a-number" },
      ...bars.slice(3),
    ];
    assert.deepEqual(
      evaluateReplayIndicator("MA(close, 2)", withInvalidValue).values,
      [null, 11, null, null, 14.5, 15.5],
    );
    assert.deepEqual(
      evaluateReplayIndicator("REF(volume, 2)", bars.slice(0, 3)).values,
      [null, null, 100],
    );
    assert.deepEqual(
      evaluateReplayIndicator("close", [
        { close: null },
        { close: " " },
        { close: false },
        { close: "12.5" },
      ]).values,
      [null, null, null, 12.5],
    );
    assert.equal(
      evaluateReplayIndicator("close * close", [
        { close: Number.MAX_VALUE },
      ]).values[0],
      null,
    );
  });
});

describe("advanced replay indicator engine", () => {
  const brickConfig = {
    definitions: [
      "range = HHV(high, 2) - LLV(low, 2)",
      "smooth = SMA(range, 3, 1)",
      "brick = IF(smooth > 3, smooth - 3, 0)",
    ].join("\n"),
    plot: {
      type: "rangeBar",
      label: "砖型图",
      fromExpression: "REF(brick, 1)",
      toExpression: "brick",
      risingColor: "#ef4444",
      fallingColor: "#10b981",
    },
  };

  it("evaluates ordered variables and builds a causal range-bar series", () => {
    const result = evaluateReplayAdvancedIndicator(brickConfig, bars);

    assert.equal(result.error, null);
    assert.equal(result.series.length, 1);
    assert.equal(result.series[0].type, "rangeBar");
    assert.equal(result.series[0].label, "砖型图");
    assert.deepEqual(result.series[0].fromValues.slice(0, 3), [null, null, 2]);
    assert.deepEqual(result.series[0].values.slice(0, 2), [null, 2]);
    assert.ok(Math.abs(result.series[0].values[2] - 7 / 3) < 1e-12);
    assert.equal(result.series[0].risingColor, "#ef4444");
    assert.equal(result.series[0].fallingColor, "#10b981");

    const prefix = evaluateReplayAdvancedIndicator(brickConfig, bars.slice(0, 4));
    assert.deepEqual(prefix.series[0].values, result.series[0].values.slice(0, 4));
    assert.deepEqual(
      prefix.series[0].fromValues,
      result.series[0].fromValues.slice(0, 4),
    );
  });

  it("supports line and histogram plots from calculated variables", () => {
    for (const type of ["line", "histogram"]) {
      const result = evaluateReplayAdvancedIndicator({
        definitions: "change = close - REF(close, 1)",
        plot: {
          type,
          label: "涨跌",
          expression: "change",
          color: "#2563eb",
          negativeColor: "#10b981",
        },
      }, bars);
      assert.equal(result.error, null);
      assert.deepEqual(result.series[0].values.slice(0, 3), [null, 2, 2]);
      assert.equal(result.series[0].type, type);
    }
  });

  it("rejects unsafe, forward, duplicate and malformed definitions", () => {
    for (const definitions of [
      "brick = missing + 1",
      "next = current + 1\ncurrent = close",
      "value = close\nvalue = high",
      "close = high",
      "value = globalThis.alert(1)",
      "value = SMA(close, 3, 4)",
    ]) {
      const result = evaluateReplayAdvancedIndicator({
        definitions,
        plot: { type: "line", label: "错误", expression: "value" },
      }, bars);
      assert.deepEqual(result.series, [], definitions);
      assert.ok(result.error, definitions);
    }
  });
});
