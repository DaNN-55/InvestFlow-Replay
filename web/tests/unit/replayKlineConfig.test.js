import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPLAY_CANDLE_PANE_OPTIONS,
  createReplayChartStyles,
} from "../../src/utils/replayKlineConfig.js";

describe("replay KLineChart configuration", () => {
  it("keeps the price axis automatic and exposes the crosshair price label", () => {
    const styles = createReplayChartStyles({
      background: "#ffffff",
      grid: "#e5e7eb",
      text: "#64748b",
      rise: "#ef4444",
      fall: "#10b981",
    });

    assert.deepEqual(REPLAY_CANDLE_PANE_OPTIONS, {
      id: "candle_pane",
      gap: { top: 0.12, bottom: 0.08 },
      axisOptions: { scrollZoomEnabled: false },
    });
    assert.equal(styles.yAxis.type, "normal");
    assert.equal(styles.yAxis.position, "right");
    assert.equal(styles.crosshair.show, true);
    assert.equal(styles.crosshair.horizontal.show, true);
    assert.equal(styles.crosshair.horizontal.text.show, true);
    assert.equal(styles.crosshair.horizontal.text.color, "#ffffff");
  });

  it("appends main-chart indicator values to the candle data row", () => {
    const styles = createReplayChartStyles({
      background: "#ffffff",
      grid: "#e5e7eb",
      text: "#64748b",
      rise: "#ef4444",
      fall: "#10b981",
      mainIndicatorLegends: (replayIndex) => [{
        title: { text: "短期线: ", color: "#2563eb" },
        value: { text: `${replayIndex}.36`, color: "#2563eb" },
      }],
    });

    const legends = styles.candle.tooltip.custom({
      current: { replayIndex: 3 },
    });

    assert.equal(legends.length, 7);
    assert.deepEqual(legends.at(-1), {
      title: { text: "短期线: ", color: "#2563eb" },
      value: { text: "3.36", color: "#2563eb" },
    });
  });
});
