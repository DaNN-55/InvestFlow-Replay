import {
  ActionType,
  dispose,
  init,
  registerIndicator,
  registerOverlay,
} from "klinecharts";
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  shallowRef,
  watch,
} from "vue";

import {
  adaptReplayBars,
  adaptReplayTrades,
  classifyReplayKlineUpdate,
  createReplayTradeMarkerFigures,
  getReplayWheelZoomScale,
} from "../utils/replayKlineAdapter.js";
import {
  buildReplayMainIndicatorLegends,
  createReplayBuiltinIndicatorConfig,
  createReplayCustomIndicatorTemplate,
  replayCustomIndicatorName,
} from "../utils/replayKlineIndicators.js";
import {
  REPLAY_CANDLE_PANE_OPTIONS,
  createReplayChartStyles,
} from "../utils/replayKlineConfig.js";
import {
  REPLAY_DRAWING_GROUP_ID,
  REPLAY_RECTANGLE_OVERLAY,
  createReplayDrawingOverlay,
} from "../utils/replayKlineDrawings.js";

const CANDLE_PANE_ID = "candle_pane";
const TRADE_OVERLAY_NAME = "replayTradeMarker";
let tradeOverlayRegistered = false;
let drawingOverlaysRegistered = false;

function ensureTradeOverlayRegistered() {
  if (tradeOverlayRegistered) {
    return;
  }
  registerOverlay({
    name: TRADE_OVERLAY_NAME,
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: createReplayTradeMarkerFigures,
  });
  tradeOverlayRegistered = true;
}

function ensureDrawingOverlaysRegistered() {
  if (drawingOverlaysRegistered) {
    return;
  }
  registerOverlay(REPLAY_RECTANGLE_OVERLAY);
  drawingOverlaysRegistered = true;
}

function cssToken(style, name, fallback) {
  return style.getPropertyValue(name).trim() || fallback;
}

function resolveChartStyles(mainIndicatorLegends) {
  const rootStyle = getComputedStyle(document.documentElement);
  return createReplayChartStyles({
    background: cssToken(rootStyle, "--ql-color-bg-surface-strong", "#ffffff"),
    grid: cssToken(rootStyle, "--ql-line", "#e5e7eb"),
    text: cssToken(rootStyle, "--ql-color-text-muted", "#64748b"),
    rise: cssToken(rootStyle, "--ql-rise", "#ef4444"),
    fall: cssToken(rootStyle, "--ql-fall", "#10b981"),
    mainIndicatorLegends,
  });
}

export function useReplayKlineChart({
  host,
  model,
}) {
  const chart = shallowRef(null);
  const activeDrawingTool = shallowRef("");
  const selectedDrawingId = shallowRef("");
  const hasDrawings = shallowRef(false);
  const visibleRange = shallowRef({
    startLabel: "",
    endLabel: "",
    visibleCount: 0,
    total: 0,
  });
  const error = shallowRef("");
  const bars = computed(() => model.value?.bars ?? []);
  const trades = computed(() => model.value?.trades ?? []);
  const indicators = computed(() => model.value?.indicators ?? {
    builtins: { main: [], panes: [] },
    custom: [],
  });
  let appliedData = [];
  let labelByTimestamp = new Map();
  let resizeObserver = null;
  let themeObserver = null;
  let indicatorInstances = [];
  let indicatorStructureKey = "";
  let overlayIds = [];
  let tradeOverlayKey = "";
  let drawingIds = [];
  let pendingDrawingId = "";

  function reportError(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    chartError(message);
  }

  function chartError(message) {
    error.value = message;
  }

  function emitVisibleRange(range) {
    const total = appliedData.length;
    const start = Math.max(0, Math.floor(range?.from ?? 0));
    const endExclusive = Math.min(total, Math.ceil(range?.to ?? total));
    visibleRange.value = {
      start,
      endExclusive,
      visibleCount: Math.max(0, endExclusive - start),
      total,
      startLabel: labelByTimestamp.get(appliedData[start]?.timestamp) ?? "",
      endLabel: labelByTimestamp.get(appliedData[endExclusive - 1]?.timestamp) ?? "",
    };
  }

  function removeIndicators() {
    const current = chart.value;
    if (!current) {
      return;
    }
    for (const instance of indicatorInstances) {
      current.removeIndicator(instance.paneId, instance.name);
    }
    indicatorInstances = [];
    indicatorStructureKey = "";
  }

  function createIndicator(name, placement, paneId) {
    const current = chart.value;
    const targetId = current?.createIndicator(
      createReplayBuiltinIndicatorConfig(name, placement),
      placement === "main",
      placement === "main"
        ? { id: CANDLE_PANE_ID }
        : { id: paneId, height: 126, minHeight: 80 },
    );
    if (targetId) {
      indicatorInstances.push({ paneId: targetId, name });
    }
  }

  function mainIndicatorLegends(replayIndex) {
    const current = chart.value;
    const model = indicators.value ?? { builtins: {}, custom: [] };
    const lineColors = current?.getStyles()?.indicator?.lines
      ?.map((line) => line.color) ?? [];
    const builtins = (model.builtins?.main ?? []).flatMap((name) => {
      const indicator = current?.getIndicatorByPaneId(CANDLE_PANE_ID, name);
      return indicator
        ? [{
            figures: indicator.figures,
            result: indicator.result,
            colors: lineColors,
          }]
        : [];
    });
    return buildReplayMainIndicatorLegends({ model, replayIndex, builtins });
  }

  function syncIndicators() {
    const current = chart.value;
    if (!current) {
      return;
    }
    const model = indicators.value ?? { builtins: {}, custom: [] };
    const nextStructureKey = JSON.stringify({
      main: model.builtins?.main ?? [],
      panes: model.builtins?.panes ?? [],
      custom: (model.custom ?? []).filter((item) => !item.error && item.series?.length)
        .map((item) => [item.id, item.placement]),
    });
    if (indicatorStructureKey === nextStructureKey) {
      for (const custom of model.custom ?? []) {
        const instance = indicatorInstances.find((item) => item.customId === custom.id);
        if (!instance || custom.error || !custom.series?.length) continue;
        try {
          const template = createReplayCustomIndicatorTemplate(custom, appliedData.length);
          registerIndicator(template);
          current.overrideIndicator(template, instance.paneId);
        } catch (error) {
          reportError(error);
        }
      }
      return;
    }
    removeIndicators();
    indicatorStructureKey = nextStructureKey;
    for (const name of model.builtins?.main ?? []) {
      createIndicator(name, "main", CANDLE_PANE_ID);
    }
    for (const name of model.builtins?.panes ?? []) {
      createIndicator(name, "sub", `replay-builtin-${name.toLowerCase()}`);
    }
    for (const custom of model.custom ?? []) {
      if (custom.error || !custom.series?.length) {
        continue;
      }
      try {
        const template = createReplayCustomIndicatorTemplate(custom, appliedData.length);
        registerIndicator(template);
        const paneId = current.createIndicator(
          template.name,
          custom.placement === "main",
          custom.placement === "main"
            ? { id: CANDLE_PANE_ID }
            : { id: `replay-custom-${custom.id}`, height: 126, minHeight: 80 },
        );
        if (paneId) {
          indicatorInstances.push({ paneId, name: replayCustomIndicatorName(custom.id), customId: custom.id });
        }
      } catch (error) {
        reportError(error);
      }
    }
  }

  function syncTrades() {
    const current = chart.value;
    if (!current) {
      return;
    }
    const descriptions = adaptReplayTrades(trades.value, appliedData);
    const nextTradeOverlayKey = JSON.stringify(descriptions);
    if (nextTradeOverlayKey === tradeOverlayKey) return;
    tradeOverlayKey = nextTradeOverlayKey;
    for (const id of overlayIds) {
      current.removeOverlay(id);
    }
    overlayIds = [];
    for (const description of descriptions) {
      const id = current.createOverlay({
        name: TRADE_OVERLAY_NAME,
        id: description.id,
        lock: true,
        points: [{ timestamp: description.timestamp, value: description.value }],
        extendData: description,
      }, CANDLE_PANE_ID);
      if (typeof id === "string") {
        overlayIds.push(id);
      }
    }
  }

  function removeDrawingId(id) {
    drawingIds = drawingIds.filter((drawingId) => drawingId !== id);
    if (pendingDrawingId === id) {
      pendingDrawingId = "";
    }
    if (selectedDrawingId.value === id) {
      selectedDrawingId.value = "";
    }
    hasDrawings.value = drawingIds.length > 0;
  }

  function startDrawing(toolId) {
    const current = chart.value;
    if (!current) {
      return;
    }
    if (pendingDrawingId) {
      current.removeOverlay(pendingDrawingId);
      removeDrawingId(pendingDrawingId);
    }
    activeDrawingTool.value = toolId;
    const overlay = createReplayDrawingOverlay(toolId, {
      onDrawEnd: ({ overlay: drawn }) => {
        pendingDrawingId = "";
        activeDrawingTool.value = "";
        selectedDrawingId.value = drawn.id;
        return false;
      },
      onSelected: ({ overlay: selected }) => {
        selectedDrawingId.value = selected.id;
        return false;
      },
      onDeselected: ({ overlay: deselected }) => {
        if (selectedDrawingId.value === deselected.id) {
          selectedDrawingId.value = "";
        }
        return false;
      },
      onRemoved: ({ overlay: removed }) => {
        removeDrawingId(removed.id);
        return false;
      },
    });
    const id = overlay ? current.createOverlay(overlay, CANDLE_PANE_ID) : null;
    if (typeof id !== "string") {
      activeDrawingTool.value = "";
      return;
    }
    pendingDrawingId = id;
    drawingIds.push(id);
    hasDrawings.value = true;
  }

  function undoDrawing() {
    const id = pendingDrawingId || drawingIds.at(-1);
    if (!id || !chart.value) {
      return;
    }
    removeDrawingId(id);
    chart.value.removeOverlay(id);
    activeDrawingTool.value = "";
  }

  function deleteSelectedDrawing() {
    const id = selectedDrawingId.value;
    if (!id || !chart.value) {
      return;
    }
    removeDrawingId(id);
    chart.value.removeOverlay(id);
  }

  function clearDrawings() {
    if (!chart.value || !drawingIds.length) {
      return;
    }
    chart.value.removeOverlay({ groupId: REPLAY_DRAWING_GROUP_ID });
    drawingIds = [];
    indicatorInstances = [];
    indicatorStructureKey = "";
    overlayIds = [];
    tradeOverlayKey = "";
    pendingDrawingId = "";
    activeDrawingTool.value = "";
    selectedDrawingId.value = "";
    hasDrawings.value = false;
  }

  function showLatestHundred() {
    const current = chart.value;
    if (!current || !appliedData.length) {
      return;
    }
    const width = host.value?.clientWidth ?? 800;
    current.setBarSpace(Math.max(3, Math.min(16, width / Math.min(100, appliedData.length))));
    current.scrollToRealTime(0);
  }

  function applyBars() {
    const current = chart.value;
    if (!current) {
      return;
    }
    try {
      const adapted = adaptReplayBars(bars.value);
      const update = classifyReplayKlineUpdate(appliedData, adapted.data);
      const wasAtRight =
        Math.ceil(current.getVisibleRange().to) >= appliedData.length - 1;
      if (update === "append" || update === "tail-update") {
        current.updateData(adapted.data.at(-1));
      } else if (update === "replace") {
        current.applyNewData(adapted.data);
      }
      appliedData = adapted.data;
      labelByTimestamp = adapted.labelByTimestamp;
      current.setCustomApi({
        formatDate: (_formatter, timestamp) => labelByTimestamp.get(timestamp) ?? "",
      });
      if (update === "replace") {
        showLatestHundred();
      } else if (update === "append" && wasAtRight) {
        current.scrollToRealTime(0);
      }
      syncIndicators();
      syncTrades();
      emitVisibleRange(current.getVisibleRange());
      chartError("");
    } catch (error) {
      reportError(error);
    }
  }

  function handleWheel(event) {
    const scale = getReplayWheelZoomScale(event);
    event.stopImmediatePropagation();
    if (scale === null) {
      return;
    }
    event.preventDefault();
    const bounds = host.value?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    chart.value?.zoomAtCoordinate(scale, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    }, 0);
  }

  function mountChart() {
    if (!host.value || chart.value) {
      return;
    }
    ensureTradeOverlayRegistered();
    ensureDrawingOverlaysRegistered();
    chart.value = init(host.value, {
      locale: "zh-CN",
      styles: resolveChartStyles(mainIndicatorLegends),
    });
    if (!chart.value) {
      reportError(new Error("KLineChart 初始化失败。"));
      return;
    }
    chart.value.setPaneOptions(REPLAY_CANDLE_PANE_OPTIONS);
    chart.value.createIndicator(createReplayBuiltinIndicatorConfig("VOL"), false, {
      id: "replay-volume",
      height: 92,
      minHeight: 72,
      dragEnabled: false,
    });
    chart.value.subscribeAction(ActionType.OnVisibleRangeChange, emitVisibleRange);
    resizeObserver = new ResizeObserver(() => chart.value?.resize());
    resizeObserver.observe(host.value);
    themeObserver = new MutationObserver(() =>
      chart.value?.setStyles(resolveChartStyles(mainIndicatorLegends))
    );
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    host.value.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    applyBars();
  }

  function unmountChart() {
    host.value?.removeEventListener("wheel", handleWheel, true);
    resizeObserver?.disconnect();
    themeObserver?.disconnect();
    if (chart.value) {
      chart.value.unsubscribeAction(ActionType.OnVisibleRangeChange, emitVisibleRange);
      dispose(chart.value);
      chart.value = null;
    }
    drawingIds = [];
    pendingDrawingId = "";
    activeDrawingTool.value = "";
    selectedDrawingId.value = "";
    hasDrawings.value = false;
  }

  onMounted(() => nextTick(mountChart));
  onActivated(() => nextTick(mountChart));
  onDeactivated(unmountChart);
  onBeforeUnmount(unmountChart);
  watch(bars, applyBars);
  watch(trades, syncTrades);
  watch(indicators, syncIndicators, { deep: true });

  const state = computed(() => ({
    visibleRange: visibleRange.value,
    error: error.value,
  }));
  const drawing = computed(() => ({
    activeTool: activeDrawingTool.value,
    selectedId: selectedDrawingId.value,
    hasDrawings: hasDrawings.value,
  }));

  return {
    state,
    drawing,
    commands: {
      startDrawing,
      undoDrawing,
      deleteSelectedDrawing,
      clearDrawings,
    },
  };
}
