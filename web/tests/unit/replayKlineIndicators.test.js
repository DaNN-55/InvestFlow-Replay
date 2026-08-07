import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReplayMainIndicatorLegends,
  createReplayBuiltinIndicatorConfig,
  createReplayCustomIndicatorTemplate,
  replayCustomIndicatorName,
} from "../../src/utils/replayKlineIndicators.js";

describe("replay KLineChart custom indicators", () => {
  it("uses a stable registration name derived from the custom id", () => {
    assert.equal(replayCustomIndicatorName("alpha / beta"), "REPLAY_CUSTOM_alpha_beta");
  });

  it("maps line, histogram and rangeBar series to aligned indicator rows", () => {
    const template = createReplayCustomIndicatorTemplate({
      id: "custom-1",
      name: "自定义指标",
      series: [
        { key: "line", label: "线", type: "line", color: "#2563eb", values: [1, 2] },
        { key: "hist", label: "柱", type: "histogram", color: "#ef4444", values: [-1, 1] },
        {
          key: "range",
          label: "区间",
          type: "rangeBar",
          risingColor: "#ef4444",
          fallingColor: "#10b981",
          fromValues: [0, 3],
          values: [2, 1],
        },
      ],
    }, 2);

    assert.equal(template.name, "REPLAY_CUSTOM_custom_1");
    assert.deepEqual(template.calc(), [
      { line: 1, hist: -1, range: 2, rangeFrom: 0 },
      { line: 2, hist: 1, range: 1, rangeFrom: 3 },
    ]);
    assert.deepEqual(template.figures.map((figure) => figure.type), ["line", "bar", "bar"]);
    assert.equal(typeof template.figures[0].styles, "function");
    assert.deepEqual(template.figures[0].styles(), { color: "#2563eb", size: 1.5 });
    assert.deepEqual(
      template.figures[2].attrs({
        data: { current: { range: 2, rangeFrom: 0 } },
        coordinate: { current: { x: 20 } },
        barSpace: { gapBar: 6, halfGapBar: 3 },
        yAxis: { convertToPixel: (value) => 100 - value * 10 },
      }),
      { x: 17, y: 80, width: 6, height: 20 },
    );
    assert.deepEqual(
      template.figures[2].styles({ current: { indicatorData: { range: 1, rangeFrom: 3 } } }),
      { color: "#10b981" },
    );
    assert.equal(template.draw, null);
  });

  it("moves main-chart indicator legends into the candle tooltip", () => {
    const builtIn = createReplayBuiltinIndicatorConfig("MA", "main");
    const custom = createReplayCustomIndicatorTemplate({
      id: "custom-main",
      name: "短期线",
      placement: "main",
      series: [{ key: "line", label: "短期线", type: "line", color: "#2563eb", values: [3.36] }],
    }, 1);

    assert.deepEqual(builtIn.createTooltipDataSource(), {
      name: "",
      calcParamsText: "",
      values: [],
      icons: [],
    });
    assert.deepEqual(custom.createTooltipDataSource(), {
      name: "",
      calcParamsText: "",
      values: [],
      icons: [],
    });

    assert.deepEqual(buildReplayMainIndicatorLegends({
      model: {
        custom: [{
          name: "短期线",
          placement: "main",
          series: [{ label: "短期线", color: "#2563eb", values: [3.36] }],
        }],
      },
      replayIndex: 0,
      builtins: [{
        figures: [{ key: "ma5", title: "MA5: " }],
        result: [{ ma5: 3.4 }],
        colors: ["#ff9600"],
      }],
    }), [
      {
        title: { text: "MA5: ", color: "#ff9600" },
        value: { text: "3.40", color: "#ff9600" },
      },
      {
        title: { text: "短期线: ", color: "#2563eb" },
        value: { text: "3.36", color: "#2563eb" },
      },
    ]);
  });
});
