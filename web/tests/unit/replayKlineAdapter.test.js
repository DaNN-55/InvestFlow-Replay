import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReplayKlineDataError,
  adaptReplayBars,
  adaptReplayTrades,
  buildReplayCustomIndicatorRows,
  classifyReplayKlineUpdate,
  createReplayTradeMarkerFigures,
  getReplayWheelZoomScale,
} from "../../src/utils/replayKlineAdapter.js";

const sourceBars = [
  {
    datetime: "第249日",
    period: "day",
    startSequence: 249,
    endSequence: 249,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1000,
  },
  {
    datetime: "第250日",
    period: "day",
    startSequence: 250,
    endSequence: 250,
    open: 11,
    high: 13,
    low: 10,
    close: 12,
    volume: 120,
    amount: 1300,
  },
];

describe("replay KLineChart adapter", () => {
  it("uses stable synthetic timestamps while preserving anonymous labels", () => {
    const anonymous = adaptReplayBars(sourceBars);
    const revealed = adaptReplayBars([
      { ...sourceBars[0], datetime: "2026-08-03" },
      { ...sourceBars[1], datetime: "2026-08-04" },
    ]);

    assert.deepEqual(
      anonymous.data.map((item) => item.timestamp),
      revealed.data.map((item) => item.timestamp),
    );
    assert.equal(
      anonymous.labelByTimestamp.get(anonymous.data[0].timestamp),
      "第249日",
    );
    assert.equal(
      revealed.labelByTimestamp.get(revealed.data[0].timestamp),
      "2026-08-03",
    );
    assert.equal(JSON.stringify(anonymous.data).includes("2026"), false);
  });

  it("rejects an invalid OHLC bar instead of silently drawing partial data", () => {
    assert.throws(
      () => adaptReplayBars([{ ...sourceBars[0], high: "invalid" }]),
      (error) =>
        error instanceof ReplayKlineDataError &&
        /第 1 根 K 线/u.test(error.message),
    );
  });

  it("distinguishes appends, tail updates and collection replacements", () => {
    const initial = adaptReplayBars(sourceBars).data;
    const tailUpdated = adaptReplayBars([
      sourceBars[0],
      { ...sourceBars[1], close: 12.5 },
    ]).data;
    const appended = adaptReplayBars([
      ...sourceBars,
      {
        ...sourceBars[1],
        datetime: "第251日",
        startSequence: 251,
        endSequence: 251,
      },
    ]).data;
    const replaced = adaptReplayBars([
      { ...sourceBars[0], startSequence: 1, endSequence: 1 },
      { ...sourceBars[1], startSequence: 2, endSequence: 2 },
    ]).data;

    assert.equal(classifyReplayKlineUpdate(initial, tailUpdated), "tail-update");
    assert.equal(classifyReplayKlineUpdate(initial, appended), "append");
    assert.equal(classifyReplayKlineUpdate(initial, replaced), "replace");
  });

  it("zooms only for an explicit Ctrl or Command wheel gesture", () => {
    assert.equal(getReplayWheelZoomScale({ deltaY: -100 }), null);
    assert.equal(
      getReplayWheelZoomScale({ deltaY: -100, ctrlKey: true }),
      1.08,
    );
    assert.equal(
      getReplayWheelZoomScale({ deltaY: 100, metaKey: true }),
      0.92,
    );
  });

  it("maps filled trades to the timestamp of their aggregated candle", () => {
    const adapted = adaptReplayBars(sourceBars);
    const overlays = adaptReplayTrades(
      [
        {
          id: "fill-1",
          datetime: "第250日",
          direction: "buy",
          price: 12.1,
        },
      ],
      adapted.data,
    );

    assert.deepEqual(overlays, [
      {
        id: "replay-trade-fill-1",
        timestamp: adapted.data[1].timestamp,
        value: 10,
        side: "buy",
        text: "B ↑",
      },
    ]);
  });

  it("anchors buy markers below the candle and sell markers above it", () => {
    const adapted = adaptReplayBars(sourceBars);
    const overlays = adaptReplayTrades([
      { id: "buy", datetime: "第249日", direction: "buy", price: 11 },
      { id: "sell", datetime: "第250日", direction: "sell", price: 12 },
    ], adapted.data);

    assert.deepEqual(
      overlays.map(({ value, side, text }) => ({ value, side, text })),
      [
        { value: 9, side: "buy", text: "B ↑" },
        { value: 13, side: "sell", text: "S ↓" },
      ],
    );
  });

  it("renders trade markers as transparent text and arrows", () => {
    const figures = createReplayTradeMarkerFigures({
      overlay: { extendData: { side: "buy", text: "B ↑" } },
      coordinates: [{ x: 50, y: 80 }],
      bounding: { width: 200, height: 160 },
    });

    assert.equal(figures.length, 1);
    assert.equal(figures[0].type, "text");
    assert.equal(figures[0].attrs.text, "B ↑");
    assert.equal(figures[0].attrs.y, 104);
    assert.equal(figures[0].styles.backgroundColor, "transparent");
    assert.equal(figures[0].styles.borderSize, 0);
  });

  it("prefers the execution sequence when labels differ from aggregated bars", () => {
    const adapted = adaptReplayBars([
      { ...sourceBars[0], datetime: "第1周", period: "week", startSequence: 1, endSequence: 5 },
      { ...sourceBars[1], datetime: "第2周", period: "week", startSequence: 6, endSequence: 10 },
    ]);
    const overlays = adaptReplayTrades([
      { id: "fill-2", datetime: "第8日", sequence: 8, direction: "sell", price: 11 },
    ], adapted.data);

    assert.equal(overlays[0].timestamp, adapted.data[1].timestamp);
    assert.equal(overlays[0].side, "sell");
  });

  it("aligns line, histogram and range-bar series into indicator rows", () => {
    const rows = buildReplayCustomIndicatorRows(
      [
        { key: "line", type: "line", values: [null, 12] },
        { key: "hist", type: "histogram", values: [-1, 2] },
        {
          key: "range",
          type: "rangeBar",
          fromValues: [9, 10],
          values: [11, 12],
        },
      ],
      2,
    );

    assert.deepEqual(rows, [
      { line: null, hist: -1, range: 11, rangeFrom: 9 },
      { line: 12, hist: 2, range: 12, rangeFrom: 10 },
    ]);
    assert.throws(
      () =>
        buildReplayCustomIndicatorRows(
          [{ key: "line", type: "line", values: [1] }],
          2,
        ),
      /长度必须与 K 线一致/u,
    );
  });
});
