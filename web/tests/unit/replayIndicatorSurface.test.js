import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  assert.equal(existsSync(url), true, relativePath);
  return readFileSync(url, "utf8");
}

const chartSource = read("../../src/components/replay/ReplayChartPanel.vue");
const workspaceSource = read("../../src/components/replay/ReplayIndicatorWorkspace.vue");
const toolbarSource = read("../../src/components/replay/ReplayIndicatorToolbar.vue");
const editorSource = read("../../src/components/replay/ReplayIndicatorEditor.vue");
const composableSource = read("../../src/composables/useReplayIndicators.js");
const lifecycleSource = read("../../src/composables/useReplayKlineChart.js");
const candlestickSource = read("../../src/components/CandlestickChart.vue");
const viewSource = read("../../src/views/MarketReplayView.vue");
const drawingSource = read("../../src/utils/replayKlineDrawings.js");
const indicatorSource = read("../../src/utils/replayKlineIndicators.js");

describe("replay indicator frontend surface", () => {
  it("sends one indicator model and the same revealed bars to KLineChart", () => {
    assert.match(chartSource, /const chartBars = computed/u);
    assert.match(chartSource, /:indicators="chartIndicators"/u);
    assert.match(workspaceSource, /chartIndicatorModel/u);
    assert.match(workspaceSource, /builtins:[\s\S]*?main:[\s\S]*?panes:/u);
    assert.match(workspaceSource, /evaluateReplayIndicator/u);
    assert.match(workspaceSource, /evaluateReplayAdvancedIndicator/u);
    assert.match(workspaceSource, /chart-indicators-change/u);
    assert.match(workspaceSource, /仅根据当前已揭示的/u);
    assert.ok(
      chartSource.indexOf("<ReplayIndicatorWorkspace") <
        chartSource.indexOf('class="replay-chart-panel__chart"'),
      "指标工具栏应位于 K 线图上方",
    );
  });

  it("keeps default visibility, limits and local preferences", () => {
    for (const label of ["MACD", "RSI", "KDJ", "BOLL", "MA", "自定义指标"]) {
      assert.match(toolbarSource, new RegExp(label, "u"));
    }
    assert.match(composableSource, /investflow\.replay\.indicator-preferences\.v1/u);
    assert.match(composableSource, /MAX_REPLAY_SUBCHARTS = 3/u);
    assert.match(composableSource, /最多同时显示 3 个副图/u);
  });

  it("owns the complete KLineChart lifecycle in one composable", () => {
    assert.match(lifecycleSource, /init\(host\.value/u);
    assert.match(lifecycleSource, /applyNewData/u);
    assert.match(lifecycleSource, /updateData/u);
    assert.match(lifecycleSource, /dispose\(chart\.value\)/u);
    assert.match(lifecycleSource, /ResizeObserver/u);
    assert.match(lifecycleSource, /MutationObserver/u);
    assert.match(lifecycleSource, /OnVisibleRangeChange/u);
    assert.match(lifecycleSource, /OnCrosshairChange/u);
    assert.match(lifecycleSource, /scrollToRealTime/u);
    assert.match(lifecycleSource, /addEventListener\("wheel"/u);
    assert.match(candlestickSource, /Ctrl\/⌘ \+ 滚轮缩放/u);
    assert.match(candlestickSource, /shallowRef/u);
    assert.match(candlestickSource, /replay-klinecharts-host/u);
  });

  it("uses native built-ins, VOL and isolated custom indicator errors", () => {
    assert.match(lifecycleSource, /createIndicator\("VOL"/u);
    assert.match(indicatorSource, /MA: \[5, 10, 30, 60\]/u);
    assert.match(indicatorSource, /BOLL: \[20, 2\]/u);
    assert.match(indicatorSource, /MACD: \[12, 26, 9\]/u);
    assert.match(indicatorSource, /RSI: \[6, 12, 24\]/u);
    assert.match(indicatorSource, /KDJ: \[9, 3, 3\]/u);
    assert.match(lifecycleSource, /if \(custom\.error \|\| !custom\.series\?\.length\)/u);
    assert.match(workspaceSource, /indicatorErrors/u);
  });

  it("exposes native drawing controls and hybrid trade mapping context", () => {
    for (const label of ["趋势线", "水平线", "射线", "矩形", "斐波那契", "撤销", "删除选中", "清空画图"]) {
      assert.match(`${candlestickSource}\n${drawingSource}`, new RegExp(label, "u"));
    }
    assert.match(lifecycleSource, /startDrawing/u);
    assert.match(lifecycleSource, /undoDrawing/u);
    assert.match(lifecycleSource, /deleteSelectedDrawing/u);
    assert.match(lifecycleSource, /clearDrawings/u);
    assert.match(viewSource, /:observation-bars="session\.observationBars"/u);
    assert.match(viewSource, /:step-minutes="session\.stepMinutes"/u);
  });

  it("renders the drawing toolbar as icons without visible text labels", () => {
    assert.doesNotMatch(candlestickSource, /<span>\{\{ tool\.label \}\}<\/span>/u);
    assert.doesNotMatch(candlestickSource, /<span>撤销<\/span>/u);
    assert.doesNotMatch(candlestickSource, /<span>删除选中<\/span>/u);
    assert.doesNotMatch(candlestickSource, /<span>清空画图<\/span>/u);
    assert.match(candlestickSource, /:aria-label="tool\.label"/u);
    assert.match(candlestickSource, /title="撤销最后一笔画图"/u);
  });

  it("retains formula editing and advanced range bars", () => {
    assert.match(editorSource, /函数表达式/u);
    assert.match(editorSource, /MA\(close, 5\) - MA\(close, 20\)/u);
    assert.match(editorSource, /高级公式/u);
    assert.match(editorSource, /区间柱/u);
    assert.match(editorSource, /HHV、LLV、SMA、IF/u);
  });

  it("places the simple formula color after placement on the first row", () => {
    const placement = editorSource.indexOf('id="replay-indicator-placement"');
    const color = editorSource.indexOf('id="replay-indicator-color"');
    const actions = editorSource.indexOf('class="replay-indicator-editor__actions"');
    assert.ok(placement >= 0 && placement < color);
    assert.ok(color < actions);
  });

  it("uses responsive layouts without the old SVG panel or navigator", () => {
    assert.match(workspaceSource, /min-width: 0/u);
    assert.match(workspaceSource, /@media \(max-width: 640px\)/u);
    assert.match(candlestickSource, /min-width: 0/u);
    assert.doesNotMatch(candlestickSource, /<svg|navigator/u);
    assert.equal(
      existsSync(new URL("../../src/components/replay/ReplayIndicatorPanel.vue", import.meta.url)),
      false,
    );
  });
});
