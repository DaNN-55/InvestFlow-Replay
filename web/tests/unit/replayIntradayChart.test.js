import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReplayIntradaySeries } from "../../src/utils/replayIntradayChart.js";

describe("buildReplayIntradaySeries", () => {
  it("uses minute closes for price and cumulative amount divided by volume for average price", () => {
    const result = buildReplayIntradaySeries(
      [
        { close: 10, volume: 100, amount: 1000 },
        { close: 12, volume: 200, amount: 2400 },
      ],
      { previousClose: 10, totalMinutes: 48 },
    );

    assert.deepEqual(result.priceValues, [10, 12]);
    assert.deepEqual(result.averageValues, [10, 11.333333333333334]);
    assert.equal(result.xRatios[0], 0);
    assert.equal(result.xRatios[1], 1 / 47);
  });

  it("keeps the price scale symmetric around the previous close", () => {
    const result = buildReplayIntradaySeries(
      [
        { close: 9, volume: 100, amount: 900 },
        { close: 12, volume: 100, amount: 1200 },
      ],
      { previousClose: 10, totalMinutes: 240 },
    );

    assert.equal(result.priceMin, 7.9);
    assert.equal(result.priceMax, 12.1);
    assert.equal(result.maxVolume, 100);
  });
});
