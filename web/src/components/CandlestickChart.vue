<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import {
  resolveReplayChartPointer,
  resolveReplayMainChartRange,
} from "../utils/replayChartScale.js";
import { resolveReplayViewportAfterBarsChange } from "../utils/replayMarket.js";

const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
  trades: {
    type: Array,
    default: () => [],
  },
  mainOverlays: {
    type: Array,
    default: () => [],
  },
  sharedHoverIndex: {
    type: Number,
    default: null,
  },
});

const emit = defineEmits(["viewport-change", "hover-index-change"]);

const width = 1120;
const height = 290;
const padding = { top: 18, right: 48, bottom: 16, left: 12 };
const volumeHeight = 92;
const volumePadding = { top: 10, right: 48, bottom: 24, left: 12 };
const minVisibleCount = 24;
const zoomStep = 12;

const overviewWidth = 1120;
const overviewHeight = 42;
const overviewPadding = 0;
const riseColor = "var(--ql-rise)";
const fallColor = "var(--ql-fall)";

const visibleCount = ref(70);
const visibleStart = ref(0);
const dragState = ref(null);
const overviewDragState = ref(null);
const pointerPosition = shallowRef(null);
let previousBarsTotal = 0;
let previousFirstBarKey = "";

const barsCount = computed(() => props.bars.length);
const minZoomCount = computed(() => {
  if (!props.bars.length) {
    return 1;
  }
  return Math.min(minVisibleCount, props.bars.length);
});
const maxVisibleCount = computed(() => Math.max(props.bars.length, 1));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatDateLabel(value) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function formatTickLabel(value) {
  const text = formatDateLabel(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5, 10) : text;
}

function formatPrice(value) {
  return Number(value ?? 0).toFixed(2);
}

function formatVolume(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0";
  }
  if (numeric >= 100000000) {
    return `${(numeric / 100000000).toFixed(2)}亿`;
  }
  if (numeric >= 10000) {
    return `${(numeric / 10000).toFixed(2)}万`;
  }
  return numeric.toFixed(0);
}

function syncViewport(resetToFull = false) {
  if (!props.bars.length) {
    visibleCount.value = 1;
    visibleStart.value = 0;
    return;
  }

  const targetCount = resetToFull
    ? props.bars.length
    : visibleCount.value || props.bars.length;
  const nextVisibleCount = clamp(
    targetCount,
    minZoomCount.value,
    maxVisibleCount.value,
  );
  visibleCount.value = nextVisibleCount;

  const maxStart = Math.max(props.bars.length - nextVisibleCount, 0);
  visibleStart.value = resetToFull ? 0 : clamp(visibleStart.value, 0, maxStart);
}

watch(
  () =>
    [
      props.bars.length,
      props.bars[0]?.datetime ?? "",
      props.bars.at(-1)?.datetime ?? "",
    ].join("|"),
  () => {
    const nextTotal = props.bars.length;
    const nextFirstBarKey = String(props.bars[0]?.datetime ?? "");
    const collectionChanged =
      previousBarsTotal === 0 ||
      nextTotal < previousBarsTotal ||
      nextFirstBarKey !== previousFirstBarKey;
    if (collectionChanged) {
      syncViewport(true);
    } else {
      const nextViewport = resolveReplayViewportAfterBarsChange({
        previousTotal: previousBarsTotal,
        nextTotal,
        visibleStart: visibleStart.value,
        visibleCount: visibleCount.value,
      });
      visibleStart.value = nextViewport.visibleStart;
      visibleCount.value = nextViewport.visibleCount;
    }
    previousBarsTotal = nextTotal;
    previousFirstBarKey = nextFirstBarKey;
    pointerPosition.value = null;
    emit("hover-index-change", null);
  },
  { immediate: true },
);

const visibleBars = computed(() => {
  const start = clamp(
    visibleStart.value,
    0,
    Math.max(props.bars.length - visibleCount.value, 0),
  );
  return props.bars.slice(start, start + visibleCount.value);
});
const visibleMainOverlays = computed(() =>
  props.mainOverlays.map((overlay) => ({
    ...overlay,
    values: overlay.values.slice(
      visibleStart.value,
      visibleStart.value + visibleCount.value,
    ),
  })),
);

watch(
  () => [
    visibleStart.value,
    visibleCount.value,
    props.bars.length,
  ],
  () => {
    const start = clamp(
      visibleStart.value,
      0,
      Math.max(props.bars.length - visibleCount.value, 0),
    );
    const endExclusive = Math.min(
      start + visibleCount.value,
      props.bars.length,
    );
    emit("viewport-change", {
      start,
      endExclusive,
      visibleCount: Math.max(endExclusive - start, 0),
      total: props.bars.length,
    });
  },
  { immediate: true },
);

const visibleDateRange = computed(() => {
  if (!visibleBars.value.length) {
    return "";
  }
  const first = formatDateLabel(visibleBars.value[0].datetime);
  const last = formatDateLabel(visibleBars.value.at(-1)?.datetime);
  return `${first} - ${last}`;
});

const priceRange = computed(() =>
  resolveReplayMainChartRange({
    lows: visibleBars.value.map((item) => item.low),
    highs: visibleBars.value.map((item) => item.high),
    overlays: visibleMainOverlays.value,
  }),
);

function scaleX(index) {
  const innerWidth = width - padding.left - padding.right;
  return (
    padding.left +
    ((index + 0.5) / Math.max(visibleBars.value.length, 1)) * innerWidth
  );
}

function scaleY(value) {
  const innerHeight = height - padding.top - padding.bottom;
  const ratio =
    (Number(value) - priceRange.value.min) /
    (priceRange.value.max - priceRange.value.min || 1);
  return height - padding.bottom - ratio * innerHeight;
}

const candleWidth = computed(() => {
  const innerWidth = width - padding.left - padding.right;
  return Math.max(
    Math.min((innerWidth / Math.max(visibleBars.value.length, 1)) * 0.62, 13),
    4,
  );
});

const priceLabels = computed(() => {
  const steps = 5;
  const range = priceRange.value.max - priceRange.value.min || 1;
  return Array.from({ length: steps }, (_, index) => {
    const value =
      priceRange.value.max - (range / Math.max(steps - 1, 1)) * index;
    return {
      y:
        padding.top +
        ((height - padding.top - padding.bottom) / Math.max(steps - 1, 1)) *
          index,
      label: value.toFixed(2),
    };
  });
});

const volumeSeries = computed(() =>
  visibleBars.value.map((item) => {
    const raw = Number(item?.volume);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }),
);

const volumeRange = computed(() => {
  if (!volumeSeries.value.length) {
    return { max: 1 };
  }
  const rawMax = Math.max(...volumeSeries.value, 0);
  return {
    max: rawMax > 0 ? rawMax * 1.12 : 1,
  };
});

function scaleVolumeY(value) {
  const innerHeight = volumeHeight - volumePadding.top - volumePadding.bottom;
  const ratio = Number(value) / Math.max(volumeRange.value.max, 1);
  return volumeHeight - volumePadding.bottom - ratio * innerHeight;
}

const volumeBars = computed(() =>
  visibleBars.value.map((bar, index) => {
    const volume = volumeSeries.value[index] ?? 0;
    const y = scaleVolumeY(volume);
    const baseY = volumeHeight - volumePadding.bottom;
    return {
      x: scaleX(index) - candleWidth.value / 2,
      y,
      width: candleWidth.value,
      height: Math.max(baseY - y, volume > 0 ? 1.5 : 0),
      color:
        Number(bar.close) >= Number(bar.open)
          ? "rgba(239, 68, 68, 0.72)"
          : "rgba(16, 185, 129, 0.72)",
    };
  }),
);

const volumeLabels = computed(() => [
  {
    y: volumePadding.top + 4,
    label: formatVolume(volumeRange.value.max),
  },
  {
    y: volumeHeight - volumePadding.bottom + 4,
    label: "0",
  },
]);

const tickLabels = computed(() => {
  if (!visibleBars.value.length) {
    return [];
  }

  const steps = Math.min(7, visibleBars.value.length);
  return Array.from({ length: steps }, (_, index) => {
    const barIndex = Math.min(
      Math.round(
        (index / Math.max(steps - 1, 1)) * (visibleBars.value.length - 1),
      ),
      visibleBars.value.length - 1,
    );
    return {
      x: scaleX(barIndex),
      label: formatTickLabel(visibleBars.value[barIndex].datetime),
    };
  });
});

const tradeMarks = computed(() => {
  if (!visibleBars.value.length || !props.trades.length) {
    return [];
  }

  return props.trades
    .map((trade) => {
      const tradeDate = formatDateLabel(trade.datetime);
      const barIndex = visibleBars.value.findIndex(
        (bar) => formatDateLabel(bar.datetime) === tradeDate,
      );
      if (barIndex === -1) {
        return null;
      }

      const direction = String(trade.direction ?? "").toLowerCase();
      const isBuy = direction.includes("buy") || direction.includes("long");
      const referenceBar = visibleBars.value[barIndex];
      const markerPrice = Number.isFinite(Number(trade.price))
        ? Number(trade.price)
        : isBuy
          ? Number(referenceBar.low)
          : Number(referenceBar.high);

      return {
        x: scaleX(barIndex),
        y: scaleY(markerPrice),
        labelY: isBuy
          ? scaleY(referenceBar.low) + 18
          : scaleY(referenceBar.high) - 14,
        label: isBuy ? "B" : "S",
        type: isBuy ? "buy" : "sell",
      };
    })
    .filter(Boolean);
});

function zoomIn() {
  if (props.bars.length <= minZoomCount.value) {
    return;
  }
  const next = clamp(
    visibleCount.value - zoomStep,
    minZoomCount.value,
    maxVisibleCount.value,
  );
  const anchor = visibleStart.value + Math.floor(visibleCount.value / 2);
  visibleCount.value = next;
  visibleStart.value = clamp(
    anchor - Math.floor(next / 2),
    0,
    Math.max(props.bars.length - next, 0),
  );
}

function zoomOut() {
  const next = clamp(
    visibleCount.value + zoomStep,
    minZoomCount.value,
    maxVisibleCount.value,
  );
  const anchor = visibleStart.value + Math.floor(visibleCount.value / 2);
  visibleCount.value = next;
  visibleStart.value = clamp(
    anchor - Math.floor(next / 2),
    0,
    Math.max(props.bars.length - next, 0),
  );
}

function handleWheel(event) {
  if (!props.bars.length) {
    return;
  }
  event.preventDefault();
  if (event.deltaY < 0) {
    zoomIn();
  } else {
    zoomOut();
  }
}

function updateHover(event) {
  const bounds = event.currentTarget?.getBoundingClientRect?.();
  const pointer = resolveReplayChartPointer({
    clientX: event.clientX,
    clientY: event.clientY,
    bounds,
    chartWidth: width,
    chartHeight: height,
    padding,
    visibleCount: visibleBars.value.length,
    visibleStart: visibleStart.value,
    priceRange: priceRange.value,
  });
  if (!pointer) {
    clearHover();
    return;
  }
  pointerPosition.value = pointer;
  if (pointer.globalIndex !== props.sharedHoverIndex) {
    emit("hover-index-change", pointer.globalIndex);
  }
}

function clearHover() {
  pointerPosition.value = null;
  if (props.sharedHoverIndex !== null) {
    emit("hover-index-change", null);
  }
}

function startDrag(event) {
  if (!props.bars.length) {
    return;
  }
  dragState.value = {
    x: event.clientX,
    start: visibleStart.value,
  };
  window.addEventListener("pointermove", handleDrag);
  window.addEventListener("pointerup", stopDrag, { once: true });
}

function handleDrag(event) {
  if (!dragState.value || !visibleBars.value.length) {
    return;
  }
  const innerWidth = width - padding.left - padding.right;
  const pixelsPerBar = innerWidth / Math.max(visibleBars.value.length, 1);
  const deltaBars = Math.round(
    (dragState.value.x - event.clientX) / Math.max(pixelsPerBar, 1),
  );
  visibleStart.value = clamp(
    dragState.value.start + deltaBars,
    0,
    Math.max(props.bars.length - visibleCount.value, 0),
  );
}

function stopDrag() {
  dragState.value = null;
  window.removeEventListener("pointermove", handleDrag);
}

function startOverviewDrag(event) {
  if (!props.bars.length) {
    return;
  }
  overviewDragState.value = {
    x: event.clientX,
    start: visibleStart.value,
  };
  window.addEventListener("pointermove", handleOverviewDrag);
  window.addEventListener("pointerup", stopOverviewDrag, { once: true });
  event.preventDefault();
  event.stopPropagation();
}

function handleOverviewDrag(event) {
  if (!overviewDragState.value || !props.bars.length) {
    return;
  }
  const innerWidth = overviewWidth - overviewPadding * 2;
  const pixelsPerBar = innerWidth / Math.max(props.bars.length, 1);
  const deltaBars = Math.round(
    (event.clientX - overviewDragState.value.x) / Math.max(pixelsPerBar, 1),
  );
  const next = overviewDragState.value.start + deltaBars;
  visibleStart.value = clamp(
    next,
    0,
    Math.max(props.bars.length - visibleCount.value, 0),
  );
}

function stopOverviewDrag() {
  overviewDragState.value = null;
  window.removeEventListener("pointermove", handleOverviewDrag);
}

const hoveredBar = computed(() => {
  if (props.sharedHoverIndex === null) {
    return null;
  }
  const localIndex = props.sharedHoverIndex - visibleStart.value;
  if (localIndex < 0 || localIndex >= visibleBars.value.length) {
    return null;
  }
  return visibleBars.value[localIndex];
});

const hoverIndex = computed(() =>
  pointerPosition.value?.localIndex ??
  (hoveredBar.value ? props.sharedHoverIndex - visibleStart.value : -1),
);
const hoverX = computed(() =>
  pointerPosition.value?.x ??
  (hoveredBar.value ? scaleX(hoverIndex.value) : 0),
);
const hoverY = computed(() =>
  pointerPosition.value?.y ??
  (hoveredBar.value ? scaleY(hoveredBar.value.close) : 0),
);
const hoverPrice = computed(() =>
  formatPrice(pointerPosition.value?.price ?? hoveredBar.value?.close),
);
const hoverDate = computed(() => formatDateLabel(hoveredBar.value?.datetime));
const hoverDateTagX = computed(() =>
  clamp(hoverX.value - 34, padding.left, width - padding.right - 68),
);

function buildOverlayPath(overlay) {
  let drawing = false;
  return overlay.values
    .map((value, index) => {
      if (value == null || !Number.isFinite(Number(value))) {
        drawing = false;
        return "";
      }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command} ${scaleX(index).toFixed(2)} ${scaleY(value).toFixed(2)}`;
    })
    .filter(Boolean)
    .join(" ");
}

const renderedMainOverlays = computed(() =>
  visibleMainOverlays.value.map((overlay) => ({
    ...overlay,
    path: buildOverlayPath(overlay),
  })),
);

const activeOverlayValues = computed(() =>
  renderedMainOverlays.value.map((overlay) => {
    const value =
      hoverIndex.value >= 0
        ? overlay.values[hoverIndex.value]
        : overlay.values.findLast(
            (item) => item != null && Number.isFinite(Number(item)),
          );
    return {
      ...overlay,
      value:
        value == null || !Number.isFinite(Number(value))
          ? "--"
          : Number(value).toFixed(2),
    };
  }),
);

const tooltipStyle = computed(() => {
  if (!hoveredBar.value) {
    return {};
  }
  const x = hoverX.value;
  const rightSide = x > width * 0.7;
  const offsetPercent = ((rightSide ? width - x : x) / width) * 100;
  return {
    top: "12px",
    ...(rightSide
      ? {
          right: `${offsetPercent}%`,
          transform: "translateX(-12px)",
        }
      : {
          left: `${offsetPercent}%`,
          transform: "translateX(12px)",
        }),
  };
});

const overviewRange = computed(() => {
  if (!overviewCloses.value.length) {
    return { min: 0, max: 1 };
  }
  const values = overviewCloses.value;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return { min: min - 1, max: max + 1 };
  }
  return { min, max };
});

const overviewCloses = computed(() => {
  if (!props.bars.length) {
    return [];
  }

  const raw = props.bars.map((bar) => {
    const value = Number(bar?.close);
    return Number.isFinite(value) ? value : null;
  });

  const firstValid = raw.find((item) => item != null);
  if (firstValid == null) {
    return props.bars.map(() => 0);
  }

  const filled = raw.slice();

  for (let index = 0; index < filled.length; index += 1) {
    if (filled[index] == null) {
      filled[index] = index === 0 ? firstValid : filled[index - 1];
    }
  }

  for (let index = filled.length - 1; index >= 0; index -= 1) {
    if (filled[index] == null) {
      filled[index] =
        index === filled.length - 1 ? firstValid : filled[index + 1];
    }
  }

  return filled.map((item) => Number(item));
});

function scaleOverviewX(index) {
  const innerWidth = overviewWidth - overviewPadding * 2;
  return (
    overviewPadding + (index / Math.max(props.bars.length - 1, 1)) * innerWidth
  );
}

function scaleOverviewY(value) {
  const innerHeight = overviewHeight - overviewPadding * 2;
  const ratio =
    (Number(value) - overviewRange.value.min) /
    (overviewRange.value.max - overviewRange.value.min || 1);
  return overviewHeight - overviewPadding - ratio * innerHeight;
}

const overviewPath = computed(() => {
  if (!props.bars.length || !overviewCloses.value.length) {
    return "";
  }
  return overviewCloses.value
    .map(
      (close, index) =>
        `${index === 0 ? "M" : "L"} ${scaleOverviewX(index).toFixed(2)} ${scaleOverviewY(close).toFixed(2)}`,
    )
    .join(" ");
});

const overviewSelection = computed(() => {
  if (!props.bars.length) {
    return { x: overviewPadding, width: 0 };
  }
  const innerWidth = overviewWidth - overviewPadding * 2;
  const startRatio = visibleStart.value / Math.max(props.bars.length, 1);
  const widthRatio = visibleCount.value / Math.max(props.bars.length, 1);
  return {
    x: overviewPadding + innerWidth * startRatio,
    width: Math.max(innerWidth * widthRatio, 8),
  };
});

function seekFromOverview(event) {
  if (!props.bars.length) {
    return;
  }
  const bounds = event.currentTarget?.getBoundingClientRect?.();
  if (!bounds) {
    return;
  }
  const ratio = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
  const center = ratio * props.bars.length;
  const start = Math.round(center - visibleCount.value / 2);
  visibleStart.value = clamp(
    start,
    0,
    Math.max(props.bars.length - visibleCount.value, 0),
  );
}

onBeforeUnmount(() => {
  stopDrag();
  stopOverviewDrag();
});
</script>

<template>
  <div class="ql-w-full">
    <div class="ql-mb-3 ql-flex ql-items-center ql-justify-between ql-gap-3">
      <div
        class="ql-flex ql-min-w-0 ql-flex-wrap ql-items-center ql-gap-3 ql-text-xs ql-font-medium ql-text-slate-500"
      >
        <span>{{ visibleDateRange || "暂无可视区间" }}</span>
        <span v-if="visibleBars.length">显示 {{ visibleBars.length }} 根</span>
        <span
          v-for="overlay in activeOverlayValues"
          :key="overlay.id ?? overlay.label"
          class="ql-font-mono ql-text-[10px]"
          :style="{ color: overlay.color }"
        >
          {{ overlay.label }} {{ overlay.value }}
        </span>
      </div>

      <div class="ql-flex ql-items-center ql-gap-3">
        <div class="ql-flex ql-items-center ql-gap-4 ql-text-xs ql-font-bold">
          <span
            class="ql-inline-flex ql-items-center ql-gap-1.5 ql-text-emerald-600"
          >
            <span
              class="ql-h-3 ql-w-3 ql-rounded-full ql-bg-emerald-500 ql-ring-2 ql-ring-emerald-100"
            />
            买入 (B)
          </span>
          <span
            class="ql-inline-flex ql-items-center ql-gap-1.5 ql-text-rose-600"
          >
            <span
              class="ql-h-3 ql-w-3 ql-rounded-full ql-bg-rose-500 ql-ring-2 ql-ring-rose-100"
            />
            卖出 (S)
          </span>
        </div>
      </div>
    </div>

    <div
      class="ql-relative ql-overflow-hidden ql-rounded-xl ql-bg-slate-50/40"
      @wheel="handleWheel"
      @pointerdown="startDrag"
    >
      <svg
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="none"
        class="ql-block ql-h-[330px] ql-w-full ql-touch-none"
        role="img"
        aria-label="K线图"
        @pointermove="updateHover"
        @pointerleave="clearHover"
      >
        <line
          v-for="label in priceLabels"
          :key="label.y"
          :x1="padding.left"
          :x2="width - padding.right"
          :y1="label.y"
          :y2="label.y"
          stroke="rgba(148, 163, 184, 0.2)"
          stroke-dasharray="4 6"
        />

        <template v-if="visibleBars.length">
          <g v-for="(bar, index) in visibleBars" :key="bar.datetime ?? index">
            <line
              :x1="scaleX(index)"
              :x2="scaleX(index)"
              :y1="scaleY(bar.high)"
              :y2="scaleY(bar.low)"
              :stroke="
                Number(bar.close) >= Number(bar.open) ? riseColor : fallColor
              "
              stroke-width="1.2"
            />
            <rect
              :x="scaleX(index) - candleWidth / 2"
              :y="Math.min(scaleY(bar.open), scaleY(bar.close))"
              :width="candleWidth"
              :height="
                Math.max(Math.abs(scaleY(bar.close) - scaleY(bar.open)), 2)
              "
              :fill="
                Number(bar.close) >= Number(bar.open) ? riseColor : fallColor
              "
              rx="1.4"
            />
          </g>

          <path
            v-for="overlay in renderedMainOverlays.filter(
              (item) => item.path,
            )"
            :key="overlay.id ?? overlay.label"
            :d="overlay.path"
            fill="none"
            :stroke="overlay.color"
            stroke-width="1.45"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />

          <g
            v-for="(mark, markIndex) in tradeMarks"
            :key="`${mark.x}-${mark.y}-${mark.type}-${markIndex}`"
          >
            <path
              v-if="mark.type === 'buy'"
              :d="`M ${mark.x} ${mark.y - 10} L ${mark.x - 8.2} ${mark.y + 4.8} L ${mark.x + 8.2} ${mark.y + 4.8} Z`"
              fill="#10b981"
              stroke="white"
              stroke-width="1.7"
            />
            <path
              v-else
              :d="`M ${mark.x} ${mark.y + 10} L ${mark.x - 8.2} ${mark.y - 4.8} L ${mark.x + 8.2} ${mark.y - 4.8} Z`"
              fill="#ef4444"
              stroke="white"
              stroke-width="1.7"
            />
            <text
              :x="mark.x"
              :y="mark.type === 'buy' ? mark.labelY + 4 : mark.labelY - 2"
              text-anchor="middle"
              class="ql-text-[12px] ql-font-extrabold"
              :fill="mark.type === 'buy' ? '#059669' : '#dc2626'"
              stroke="white"
              stroke-width="0.8"
            >
              {{ mark.label }}
            </text>
          </g>
        </template>

        <template v-else>
          <text
            :x="width / 2"
            :y="height / 2"
            text-anchor="middle"
            class="ql-fill-slate-400 ql-text-[14px] ql-font-medium"
          >
            当前回测结果还没有可用的 K 线数据
          </text>
        </template>

        <template v-if="hoveredBar">
          <line
            :x1="hoverX"
            :x2="hoverX"
            :y1="padding.top"
            :y2="height - padding.bottom"
            stroke="#94a3b8"
            stroke-dasharray="4 5"
            stroke-width="1"
          />
          <line
            :x1="padding.left"
            :x2="width - padding.right"
            :y1="hoverY"
            :y2="hoverY"
            stroke="#cbd5e1"
            stroke-dasharray="4 5"
            stroke-width="1"
          />
          <g v-if="pointerPosition">
            <rect
              :x="width - padding.right"
              :y="hoverY - 10"
              :width="padding.right"
              height="20"
              rx="3"
              fill="#334155"
            />
            <text
              :x="width - padding.right / 2"
              :y="hoverY + 4"
              text-anchor="middle"
              fill="#fff"
              class="ql-text-[10px] ql-font-mono"
            >
              {{ hoverPrice }}
            </text>
            <rect
              :x="hoverDateTagX"
              :y="height - padding.bottom - 20"
              width="68"
              height="20"
              rx="3"
              fill="#334155"
            />
            <text
              :x="hoverDateTagX + 34"
              :y="height - padding.bottom - 6"
              text-anchor="middle"
              fill="#fff"
              class="ql-text-[10px] ql-font-mono"
            >
              {{ hoverDate }}
            </text>
          </g>
        </template>

        <text
          v-for="label in priceLabels"
          :key="label.label"
          :x="width - padding.right + 10"
          :y="label.y + 4"
          class="ql-fill-muted ql-text-[11px] ql-font-mono"
        >
          {{ label.label }}
        </text>

        <text
          v-for="label in tickLabels"
          :key="`${label.x}-${label.label}`"
          :x="label.x"
          :y="height - 10"
          text-anchor="middle"
          class="ql-hidden ql-fill-muted ql-text-[11px] ql-font-mono"
        >
          {{ label.label }}
        </text>
      </svg>

      <svg
        :viewBox="`0 0 ${width} ${volumeHeight}`"
        preserveAspectRatio="none"
        class="ql-block ql-h-[92px] ql-w-full ql-border-t ql-border-slate-200/70 ql-bg-slate-50/55"
        role="img"
        aria-label="成交量图"
      >
        <text
          :x="padding.left"
          :y="16"
          class="ql-fill-slate-400 ql-text-[11px] ql-font-semibold"
        >
          成交量
        </text>

        <line
          :x1="padding.left"
          :x2="width - padding.right"
          :y1="volumeHeight - volumePadding.bottom"
          :y2="volumeHeight - volumePadding.bottom"
          stroke="rgba(148, 163, 184, 0.18)"
        />

        <rect
          v-for="(bar, index) in volumeBars"
          :key="`volume-${visibleBars[index]?.datetime ?? index}`"
          :x="bar.x"
          :y="bar.y"
          :width="bar.width"
          :height="bar.height"
          :fill="bar.color"
          rx="1"
        />

        <line
          v-if="hoveredBar"
          :x1="hoverX"
          :x2="hoverX"
          :y1="volumePadding.top"
          :y2="volumeHeight - volumePadding.bottom"
          stroke="#94a3b8"
          stroke-dasharray="4 5"
          stroke-width="1"
        />

        <text
          v-for="label in volumeLabels"
          :key="`volume-${label.label}-${label.y}`"
          :x="width - volumePadding.right + 10"
          :y="label.y"
          class="ql-fill-muted ql-text-[10px] ql-font-mono"
        >
          {{ label.label }}
        </text>

        <text
          v-for="label in tickLabels"
          :key="`tick-${label.x}-${label.label}`"
          :x="label.x"
          :y="volumeHeight - 8"
          text-anchor="middle"
          class="ql-fill-muted ql-text-[11px] ql-font-mono"
        >
          {{ label.label }}
        </text>
      </svg>

      <div
        v-if="hoveredBar"
        class="ql-pointer-events-none ql-absolute ql-z-10 ql-min-w-[124px] ql-rounded-xl ql-border ql-border-slate-200 ql-bg-white/95 ql-p-3 ql-text-left ql-shadow-xl"
        :style="tooltipStyle"
      >
        <div class="ql-mb-1 ql-text-[12px] ql-font-semibold ql-text-slate-700">
          {{ formatDateLabel(hoveredBar.datetime) }}
        </div>
        <div class="ql-text-xs ql-leading-6 ql-text-slate-600">
          <div>
            <span class="ql-text-slate-400">开盘</span>
            {{ formatPrice(hoveredBar.open) }}
          </div>
          <div>
            <span class="ql-text-slate-400">收盘</span>
            {{ formatPrice(hoveredBar.close) }}
          </div>
          <div>
            <span class="ql-text-slate-400">最低</span>
            {{ formatPrice(hoveredBar.low) }}
          </div>
          <div>
            <span class="ql-text-slate-400">最高</span>
            {{ formatPrice(hoveredBar.high) }}
          </div>
          <div>
            <span class="ql-text-slate-400">成交量</span>
            {{ formatVolume(hoveredBar.volume) }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="barsCount" class="ql-mt-3 ql-space-y-2">
      <div
        class="ql-overflow-hidden ql-rounded-md ql-border ql-border-slate-200 ql-bg-slate-100/70"
        @pointerdown="seekFromOverview"
      >
        <svg
          :viewBox="`0 0 ${overviewWidth} ${overviewHeight}`"
          preserveAspectRatio="none"
          class="ql-h-[30px] ql-w-full"
          role="img"
          aria-label="K线缩略预览图"
        >
          <rect
            :x="overviewSelection.x"
            y="1"
            :width="overviewSelection.width"
            :height="overviewHeight - 2"
            fill="#93c5fd"
            fill-opacity="0.28"
            stroke="#60a5fa"
            stroke-width="1.2"
            rx="3"
            style="cursor: grab"
            @pointerdown.stop="startOverviewDrag"
          />
          <path
            v-if="overviewPath"
            :d="overviewPath"
            fill="none"
            stroke="#94a3b8"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    </div>
  </div>
</template>
