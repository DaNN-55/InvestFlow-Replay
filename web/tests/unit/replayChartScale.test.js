import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveReplayChartPointer,
  resolveReplayMainChartRange,
} from "../../src/utils/replayChartScale.js";

describe("replay main chart scale", () => {
  it("uses one shared price range for candles and every main overlay", () => {
    const range = resolveReplayMainChartRange({
      lows: [9, 9.5],
      highs: [10.5, 11],
      overlays: [{ values: [10, 12] }],
    });

    assert.deepEqual(range, { min: 8.76, max: 12.24 });
  });

  it("ignores invalid overlay values while calculating the shared range", () => {
    const range = resolveReplayMainChartRange({
      lows: [9],
      highs: [11],
      overlays: [{ values: [null, "invalid"] }],
    });

    assert.deepEqual(range, { min: 8.8, max: 11.2 });
  });

  it("maps free pointer coordinates to a price and the nearest candle", () => {
    const pointer = resolveReplayChartPointer({
      clientX: 600,
      clientY: 450,
      bounds: { left: 100, top: 200, width: 1000, height: 500 },
      chartWidth: 1120,
      chartHeight: 290,
      padding: { top: 18, right: 48, bottom: 16, left: 12 },
      visibleCount: 10,
      visibleStart: 20,
      priceRange: { min: 10, max: 50 },
    });

    assert.deepEqual(pointer, {
      x: 560,
      y: 145,
      price: 30.15625,
      localIndex: 5,
      globalIndex: 25,
    });
  });

});
