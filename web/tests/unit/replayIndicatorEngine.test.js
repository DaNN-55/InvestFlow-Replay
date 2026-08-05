import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReplayIndicatorExpressionError,
  calculateBoll,
  calculateKdj,
  calculateMa,
  calculateMacd,
  calculateRsi,
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

describe("default replay indicators", () => {
  it("calculates causal MA5/10/20/60 and BOLL from close prices", () => {
    const longBars = Array.from({ length: 65 }, (_, index) => ({
      close: index + 1,
      high: index + 2,
      low: index,
    }));
    const ma = calculateMa(longBars);
    assert.deepEqual(Object.keys(ma), ["ma5", "ma10", "ma20", "ma60"]);
    assert.equal(ma.ma5[3], null);
    assert.equal(ma.ma5[4], 3);
    assert.equal(ma.ma60[59], 30.5);

    const boll = calculateBoll(longBars.slice(0, 3), {
      period: 3,
      multiplier: 2,
    });
    const deviation = Math.sqrt(2 / 3);
    assert.deepEqual(boll.middle, [null, null, 2]);
    assert.ok(Math.abs(boll.upper[2] - (2 + deviation * 2)) < 1e-12);
    assert.ok(Math.abs(boll.lower[2] - (2 - deviation * 2)) < 1e-12);

    const prefixMa = calculateMa(longBars.slice(0, 32));
    const completeMa = calculateMa(longBars);
    assert.deepEqual(prefixMa.ma20, completeMa.ma20.slice(0, 32));
  });

  it("calculates causal KDJ with null warm-up values", () => {
    const source = [
      { high: 11, low: 8, close: 10 },
      { high: 13, low: 9, close: 12 },
      { high: 15, low: 10, close: 14 },
      { high: 16, low: 11, close: 13 },
      { high: 17, low: 12, close: 16 },
    ];
    const kdj = calculateKdj(source, {
      period: 3,
      kPeriod: 3,
      dPeriod: 3,
    });
    assert.deepEqual(kdj.k.slice(0, 2), [null, null]);
    assert.ok(Number.isFinite(kdj.k[2]));
    assert.ok(Number.isFinite(kdj.d[2]));
    assert.ok(Math.abs(kdj.j[2] - (kdj.k[2] * 3 - kdj.d[2] * 2)) < 1e-12);

    const prefix = calculateKdj(source.slice(0, 4), {
      period: 3,
      kPeriod: 3,
      dPeriod: 3,
    });
    assert.deepEqual(prefix.k, kdj.k.slice(0, 4));
    assert.deepEqual(prefix.d, kdj.d.slice(0, 4));
    assert.deepEqual(prefix.j, kdj.j.slice(0, 4));
  });

  it("returns causal MACD lines with matching lengths and the standard histogram", () => {
    const macd = calculateMacd(bars);
    assert.equal(macd.dif.length, bars.length);
    assert.equal(macd.dea.length, bars.length);
    assert.equal(macd.histogram.length, bars.length);
    assert.equal(macd.dif[0], 0);
    assert.equal(macd.dea[0], 0);
    for (let index = 0; index < bars.length; index += 1) {
      assert.ok(
        Math.abs(
          macd.histogram[index] -
            (macd.dif[index] - macd.dea[index]) * 2,
        ) < 1e-12,
      );
    }

    const prefix = calculateMacd(bars.slice(0, 4));
    assert.deepEqual(prefix.dif, macd.dif.slice(0, 4));
    assert.deepEqual(prefix.dea, macd.dea.slice(0, 4));
    assert.deepEqual(prefix.histogram, macd.histogram.slice(0, 4));
  });

  it("calculates Wilder RSI and covers rising, flat, falling and short series", () => {
    assert.deepEqual(calculateRsi(bars.slice(0, 2), 3), [null, null]);
    assert.deepEqual(
      calculateRsi(
        [1, 2, 3, 4].map((close) => ({ close })),
        3,
      ),
      [null, null, null, 100],
    );
    assert.deepEqual(
      calculateRsi(
        [4, 3, 2, 1].map((close) => ({ close })),
        3,
      ),
      [null, null, null, 0],
    );
    assert.deepEqual(
      calculateRsi(
        [2, 2, 2, 2].map((close) => ({ close })),
        3,
      ),
      [null, null, null, 50],
    );

    const fullRsi = calculateRsi(bars, 3);
    assert.deepEqual(calculateRsi(bars.slice(0, 5), 3), fullRsi.slice(0, 5));
  });

  it("returns stable empty output and isolates invalid close values", () => {
    assert.deepEqual(calculateMacd(undefined), {
      dif: [],
      dea: [],
      histogram: [],
    });
    assert.deepEqual(calculateRsi([], 14), []);
    assert.deepEqual(calculateMa([], [5]), { ma5: [] });
    assert.deepEqual(calculateBoll([]), {
      middle: [],
      upper: [],
      lower: [],
    });
    assert.deepEqual(calculateKdj([]), { k: [], d: [], j: [] });

    const values = [{ close: 1 }, { close: 2 }, { close: null }, { close: 3 }];
    assert.deepEqual(calculateRsi(values, 2), [null, null, null, null]);
    assert.equal(calculateMacd(values).dif[2], null);
  });
});
