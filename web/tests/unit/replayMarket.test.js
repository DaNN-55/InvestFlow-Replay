import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateReplayBars,
  mapReplayExecutionsToTrades,
} from "../../src/utils/replayMarket.js";
import * as replayMarket from "../../src/utils/replayMarket.js";

const revealedBars = [
  {
    sequence: 249,
    displayLabel: "第 249 日",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1000,
    weekIndex: 50,
    monthIndex: 12,
  },
  {
    sequence: 250,
    displayLabel: "第 250 日",
    open: 11,
    high: 13,
    low: 10,
    close: 12,
    volume: 150,
    amount: 1600,
    weekIndex: 50,
    monthIndex: 12,
  },
  {
    sequence: 251,
    displayLabel: "第 251 日",
    open: 12,
    high: 14,
    low: 11,
    close: 13,
    volume: 180,
    amount: 2100,
    weekIndex: 51,
    monthIndex: 13,
  },
];

describe("replay market aggregation", () => {
  it("formats a benchmark option with its readable name before code and dates", () => {
    assert.equal(
      replayMarket.formatReplayBenchmarkLabel?.({
        name: "沪深300",
        code: "000300.SH",
        startDate: "2005-04-08",
        endDate: "2026-05-18",
      }),
      "沪深300 · 000300.SH · 2005-04-08 至 2026-05-18",
    );
  });

  it("keeps a zoomed historical viewport when one new bar is revealed", () => {
    const viewport = replayMarket.resolveReplayViewportAfterBarsChange?.({
      previousTotal: 266,
      nextTotal: 267,
      visibleStart: 100,
      visibleCount: 48,
    });

    assert.deepEqual(viewport, { visibleStart: 100, visibleCount: 48 });
  });

  it("keeps the zoom level and follows the newest bar from the right edge", () => {
    const viewport = replayMarket.resolveReplayViewportAfterBarsChange?.({
      previousTotal: 266,
      nextTotal: 267,
      visibleStart: 218,
      visibleCount: 48,
    });

    assert.deepEqual(viewport, { visibleStart: 219, visibleCount: 48 });
  });

  it("aggregates only the revealed bars into anonymous week and month candles", () => {
    const weeks = aggregateReplayBars(revealedBars, "week");
    assert.deepEqual(weeks, [
      {
        datetime: "第1周",
        period: "week",
        periodIndex: 1,
        startSequence: 249,
        endSequence: 250,
        open: 10,
        high: 13,
        low: 9,
        close: 12,
        volume: 250,
        amount: 2600,
      },
      {
        datetime: "第2周",
        period: "week",
        periodIndex: 2,
        startSequence: 251,
        endSequence: 251,
        open: 12,
        high: 14,
        low: 11,
        close: 13,
        volume: 180,
        amount: 2100,
      },
    ]);

    const months = aggregateReplayBars(revealedBars.slice(0, 2), "month");
    assert.equal(months.length, 1);
    assert.equal(months[0].datetime, "第1月");
    assert.equal(months[0].endSequence, 250);
    assert.equal(months[0].close, 12);
    assert.equal(
      JSON.stringify(months).includes("251"),
      false,
      "尚未揭示的第251日不能进入月线",
    );
  });

  it("keeps anonymous daily candles and maps fills to their containing period", () => {
    const days = aggregateReplayBars(revealedBars, "day");
    assert.equal(days[0].datetime, "第249日");
    assert.equal(days[2].endSequence, 251);

    const weeks = aggregateReplayBars(revealedBars, "week");
    const trades = mapReplayExecutionsToTrades(
      [
        {
          orderId: "fill-1",
          status: "filled",
          side: "buy",
          sequence: 250,
          price: 12.1,
          quantity: 100,
        },
        {
          orderId: "rejection-1",
          status: "rejected",
          side: "sell",
          sequence: 251,
        },
      ],
      weeks,
    );
    assert.deepEqual(trades, [
      {
        id: "fill-1",
        datetime: "第1周",
        direction: "buy",
        price: 12.1,
        quantity: 100,
        sequence: 250,
      },
    ]);
  });

  it("uses real trading dates only when revealed bars include them", () => {
    const days = aggregateReplayBars(
      [
        {
          ...revealedBars[0],
          tradeDate: "2024-01-02",
          displayLabel: "2024-01-02",
        },
      ],
      "day",
    );
    assert.equal(days[0].datetime, "2024-01-02");
    assert.equal(
      aggregateReplayBars([revealedBars[0]], "day")[0].datetime,
      "第249日",
    );
  });
});
