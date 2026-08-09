import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shallowRef } from "vue";

import { useReplayChartPresentation } from "../../src/composables/useReplayChartPresentation.js";

function replayBar(datetime, values = {}) {
  return {
    datetime,
    displayLabel: datetime.slice(0, 10),
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 120000,
    ...values,
  };
}

describe("replay chart presentation", () => {
  it("presents aggregated bars, mapped trades and the latest quote through one interface", () => {
    const bars = shallowRef([
      replayBar("2026-08-03T15:00:00"),
      replayBar("2026-08-04T15:00:00", { close: 12, amount: 200000000 }),
    ]);
    const executions = shallowRef([]);
    const interval = shallowRef("1d");
    const presentation = useReplayChartPresentation({
      bars,
      executions,
      sessionInterval: interval,
      observationBars: shallowRef(1),
      stepMinutes: shallowRef(5),
    });

    assert.deepEqual(Object.keys(presentation), [
      "period",
      "periodOptions",
      "latestQuote",
      "chart",
      "selectPeriod",
      "setIndicators",
    ]);
    assert.equal(presentation.chart.value.bars.length, 2);
    assert.equal(presentation.latestQuote.value.close, "12.00");
    assert.equal(presentation.latestQuote.value.amount, "2.00 亿");

    presentation.selectPeriod("week");
    assert.equal(presentation.chart.value.key, "week-chart");
    assert.equal(presentation.chart.value.bars.length, 1);
    presentation.selectPeriod("minute");
    assert.equal(presentation.period.value, "week");
  });

  it("resets the available period when the session interval changes", async () => {
    const interval = shallowRef("1d");
    const presentation = useReplayChartPresentation({
      bars: shallowRef([]),
      executions: shallowRef([]),
      sessionInterval: interval,
      observationBars: shallowRef(0),
      stepMinutes: shallowRef(1),
    });

    presentation.selectPeriod("month");
    interval.value = "1m";
    await Promise.resolve();

    assert.equal(presentation.period.value, "minute");
    assert.deepEqual(presentation.periodOptions.value, [
      { value: "minute", label: "分" },
    ]);
  });
});
