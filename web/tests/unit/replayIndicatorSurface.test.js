import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  assert.equal(existsSync(url), true, relativePath);
  return readFileSync(url, "utf8");
}

const chartSource = read(
  "../../src/components/replay/ReplayChartPanel.vue",
);
const workspaceSource = read(
  "../../src/components/replay/ReplayIndicatorWorkspace.vue",
);
const toolbarSource = read(
  "../../src/components/replay/ReplayIndicatorToolbar.vue",
);
const editorSource = read(
  "../../src/components/replay/ReplayIndicatorEditor.vue",
);
const panelSource = read(
  "../../src/components/replay/ReplayIndicatorPanel.vue",
);
const composableSource = read(
  "../../src/composables/useReplayIndicators.js",
);
const candlestickSource = read(
  "../../src/components/CandlestickChart.vue",
);

describe("replay indicator frontend surface", () => {
  it("calculates indicators from the same revealed and aggregated chart bars", () => {
    assert.match(chartSource, /const chartBars = computed/u);
    assert.match(
      chartSource,
      /<ReplayIndicatorWorkspace[\s\S]*?:bars="chartBars"/u,
    );
    assert.match(workspaceSource, /calculateMacd\(props\.bars\)/u);
    assert.match(workspaceSource, /calculateRsi\(props\.bars\)/u);
    assert.match(workspaceSource, /calculateKdj\(props\.bars\)/u);
    assert.match(workspaceSource, /calculateMa\(props\.bars\)/u);
    assert.match(workspaceSource, /calculateBoll\(props\.bars\)/u);
    assert.match(
      workspaceSource,
      /evaluateReplayIndicator\(indicator\.expression, props\.bars\)/u,
    );
    assert.match(workspaceSource, /仅根据当前已揭示的/u);
  });

  it("keeps default visibility and custom indicator actions explicit", () => {
    assert.match(toolbarSource, /MACD/u);
    assert.match(toolbarSource, /RSI/u);
    assert.match(toolbarSource, /KDJ/u);
    assert.match(toolbarSource, /BOLL/u);
    assert.match(toolbarSource, /MA/u);
    assert.match(toolbarSource, /自定义指标/u);
    assert.match(composableSource, /investflow\.replay\.indicator-preferences\.v1/u);
    assert.match(composableSource, /function toggleDefaultIndicator/u);
    assert.match(composableSource, /function saveCustomIndicator/u);
    assert.match(composableSource, /function removeCustomIndicator/u);
    assert.match(composableSource, /visiblePanelIds/u);
    assert.match(composableSource, /MAX_REPLAY_SUBCHARTS = 3/u);
    assert.match(composableSource, /最多同时显示 3 个副图/u);
    assert.match(composableSource, /localStorage/u);
  });

  it("shares one global viewport and hover index across main and subcharts", () => {
    assert.match(chartSource, /const visibleRange = shallowRef/u);
    assert.match(chartSource, /const sharedHoverIndex = shallowRef\(null\)/u);
    assert.match(chartSource, /:visible-range="visibleRange"/u);
    assert.match(chartSource, /:shared-hover-index="sharedHoverIndex"/u);
    assert.match(chartSource, /@viewport-change="handleViewportChange"/u);
    assert.match(
      candlestickSource,
      /defineEmits\(\["viewport-change", "hover-index-change"\]\)/u,
    );
    assert.match(
      candlestickSource,
      /resolveReplayChartPointer/u,
    );
    assert.match(candlestickSource, /emit\("hover-index-change", pointer\.globalIndex\)/u);
    assert.match(panelSource, /normalizedRange/u);
    assert.match(panelSource, /props\.sharedHoverIndex - normalizedRange\.value\.start/u);
    assert.match(panelSource, /emit\("hover-index-change", index\)/u);
    assert.match(panelSource, /tickLabels/u);
  });

  it("offers a minimal editable formula and isolates calculation errors", () => {
    assert.match(editorSource, /函数表达式/u);
    assert.match(editorSource, /MA\(close, 5\) - MA\(close, 20\)/u);
    assert.match(editorSource, /REF、MA、EMA、MAX、MIN/u);
    assert.match(workspaceSource, /result\.error \?\? ""/u);
    assert.match(panelSource, /表达式无法计算/u);
    assert.match(panelSource, /v-if="error"/u);
    assert.match(panelSource, /编辑指标/u);
    assert.match(panelSource, /删除指标/u);
    assert.match(
      panelSource,
      /value !== null && value !== undefined && value !== ""/u,
    );
    assert.match(panelSource, /\.map\(Number\)[\s\S]*?\.filter\(Number\.isFinite\)/u);
  });

  it("offers advanced formulas and renders range bars in subcharts", () => {
    assert.match(editorSource, /高级公式/u);
    assert.match(editorSource, /计算步骤/u);
    assert.match(editorSource, /区间柱/u);
    assert.match(editorSource, /HHV、LLV、SMA、IF/u);
    assert.match(workspaceSource, /evaluateReplayAdvancedIndicator/u);
    assert.match(panelSource, /rangeBar/u);
    assert.match(panelSource, /fromValues/u);
    assert.match(panelSource, /risingColor/u);
    assert.match(panelSource, /fallingColor/u);
  });

  it("uses constrained mobile layouts without horizontal fixed-width panels", () => {
    assert.match(workspaceSource, /min-width: 0/u);
    assert.match(workspaceSource, /@media \(max-width: 640px\)/u);
    assert.match(editorSource, /@media \(max-width: 760px\)/u);
    assert.match(panelSource, /width: 100%/u);
    assert.doesNotMatch(
      `${workspaceSource}\n${editorSource}\n${panelSource}`,
      /min-width:\s*[4-9]\d{2}px/u,
    );
  });

  it("uses theme tokens for the custom indicator editor surface", () => {
    assert.match(
      editorSource,
      /background:\s*var\(--ql-color-bg-muted\)/u,
    );
    assert.match(
      editorSource,
      /border:\s*1px solid var\(--ql-line-strong\)/u,
    );
    assert.doesNotMatch(editorSource, /rgba\(239, 246, 255, 0\.55\)/u);
  });
});
