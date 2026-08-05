<script setup>
import { Clock3 } from "lucide-vue-next";
import { computed, shallowRef } from "vue";

import { buildReplayIntradaySeries } from "../../utils/replayIntradayChart.js";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 270;
const PLOT_LEFT = 46;
const PLOT_RIGHT = 588;
const PRICE_TOP = 16;
const PRICE_BOTTOM = 178;
const VOLUME_TOP = 204;
const VOLUME_BOTTOM = 244;
const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
  intraday: {
    type: Object,
    default: null,
  },
  previousClose: {
    type: Number,
    default: 0,
  },
  stepMinutes: {
    type: Number,
    default: 1,
  },
});

const hoverIndex = shallowRef(null);
const barsPerDay = computed(() => Math.floor(240 / Math.max(1, props.stepMinutes)));
const series = computed(() =>
  buildReplayIntradaySeries(props.bars, {
    previousClose: props.previousClose,
    totalMinutes: barsPerDay.value,
  }),
);
const latestIndex = computed(() => props.bars.length - 1);
const activeIndex = computed(() =>
  hoverIndex.value == null ? latestIndex.value : hoverIndex.value,
);
const activeBar = computed(() => props.bars[activeIndex.value] ?? null);
const activeAverage = computed(() =>
  series.value.averageValues[activeIndex.value] ?? null,
);
const progressText = computed(() => {
  if (!props.bars.length) return "等待开盘";
  if (props.intraday?.currentDayComplete) return "已收盘";
  return `${props.bars.length} / ${barsPerDay.value} 根`;
});
const priceTicks = computed(() =>
  Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const price = series.value.priceMax -
      (series.value.priceMax - series.value.priceMin) * ratio;
    const percent = series.value.referencePrice > 0
      ? ((price / series.value.referencePrice) - 1) * 100
      : 0;
    return {
      y: PRICE_TOP + (PRICE_BOTTOM - PRICE_TOP) * ratio,
      price,
      percent,
    };
  }),
);
const timeTicks = computed(() => {
  const lastIndex = Math.max(1, barsPerDay.value - 1);
  const quarter = barsPerDay.value / 4;
  return [
    { ratio: 0, label: "09:30", anchor: "start" },
    { ratio: quarter / lastIndex, label: "10:30", anchor: "middle" },
    { ratio: quarter * 2 / lastIndex, label: "11:30 / 13:00", anchor: "middle" },
    { ratio: quarter * 3 / lastIndex, label: "14:00", anchor: "middle" },
    { ratio: 1, label: "15:00", anchor: "end" },
  ];
});
const intradayTitle = computed(() =>
  props.stepMinutes === 5 ? "当日5分钟分时" : "当日分时",
);

function xAt(index) {
  return PLOT_LEFT +
    Number(series.value.xRatios[index] ?? 0) * (PLOT_RIGHT - PLOT_LEFT);
}

function yAt(price) {
  const range = series.value.priceMax - series.value.priceMin || 1;
  return PRICE_TOP +
    ((series.value.priceMax - Number(price)) / range) *
      (PRICE_BOTTOM - PRICE_TOP);
}

function linePath(values) {
  return values
    .map((value, index) =>
      `${index === 0 ? "M" : "L"} ${xAt(index).toFixed(2)} ${yAt(value).toFixed(2)}`,
    )
    .join(" ");
}

const pricePath = computed(() => linePath(series.value.priceValues));
const averagePath = computed(() => linePath(series.value.averageValues));
const referenceY = computed(() => yAt(series.value.referencePrice));

function volumeHeight(bar) {
  if (series.value.maxVolume <= 0) return 0;
  return Number(bar.volume ?? 0) / series.value.maxVolume *
    (VOLUME_BOTTOM - VOLUME_TOP);
}

function volumeColor(bar, index) {
  const previous = Number(
    props.bars[index - 1]?.close ?? series.value.referencePrice,
  );
  return Number(bar.close) >= previous ? "#ef4444" : "#10b981";
}

function handlePointerMove(event) {
  if (!props.bars.length) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const svgX = (event.clientX - bounds.left) / bounds.width * CHART_WIDTH;
  const ratio = Math.min(
    1,
    Math.max(0, (svgX - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)),
  );
  const index = Math.round(ratio * (barsPerDay.value - 1));
  hoverIndex.value = index < props.bars.length ? index : null;
}

function formatPrice(value) {
  return Number(value ?? 0).toFixed(2);
}

function formatVolume(value) {
  const volume = Number(value ?? 0);
  return volume >= 10000 ? `${(volume / 10000).toFixed(1)}万` : volume.toFixed(0);
}
</script>

<template>
  <section class="replay-intraday-panel">
    <header class="replay-intraday-panel__header">
      <div>
        <h2><Clock3 :size="15" />{{ intradayTitle }}</h2>
        <p v-if="activeBar">
          价 <strong>{{ formatPrice(activeBar.close) }}</strong>
          均 <strong class="replay-intraday-panel__average">{{ formatPrice(activeAverage) }}</strong>
          量 <strong>{{ formatVolume(activeBar.volume) }}</strong>
        </p>
        <p v-else>价格 · 均价 · 成交量</p>
      </div>
      <span>{{ progressText }}</span>
    </header>

    <svg
      v-if="bars.length"
      class="replay-intraday-panel__chart"
      :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      aria-label="当日分时折线图"
      @pointermove="handlePointerMove"
      @pointerleave="hoverIndex = null"
    >
      <rect width="640" height="270" fill="var(--ql-color-bg-muted)" />
      <g class="replay-intraday-panel__grid">
        <template v-for="tick in priceTicks" :key="tick.y">
          <line :x1="PLOT_LEFT" :x2="PLOT_RIGHT" :y1="tick.y" :y2="tick.y" />
          <text x="4" :y="tick.y + 3">{{ formatPrice(tick.price) }}</text>
          <text
            x="636"
            :y="tick.y + 3"
            text-anchor="end"
            :class="tick.percent > 0 ? 'rise' : tick.percent < 0 ? 'fall' : ''"
          >
            {{ tick.percent > 0 ? "+" : "" }}{{ tick.percent.toFixed(2) }}%
          </text>
        </template>
        <line
          v-for="tick in timeTicks"
          :key="tick.label"
          :x1="PLOT_LEFT + tick.ratio * (PLOT_RIGHT - PLOT_LEFT)"
          :x2="PLOT_LEFT + tick.ratio * (PLOT_RIGHT - PLOT_LEFT)"
          :y1="PRICE_TOP"
          :y2="VOLUME_BOTTOM"
        />
      </g>
      <line
        :x1="PLOT_LEFT"
        :x2="PLOT_RIGHT"
        :y1="referenceY"
        :y2="referenceY"
        class="replay-intraday-panel__reference"
      />
      <path :d="pricePath" class="replay-intraday-panel__price-line" />
      <path :d="averagePath" class="replay-intraday-panel__average-line" />
      <g class="replay-intraday-panel__volumes">
        <rect
          v-for="(bar, index) in bars"
          :key="bar.sequence ?? index"
          :x="xAt(index) - 1"
          :y="VOLUME_BOTTOM - volumeHeight(bar)"
          width="2.2"
          :height="volumeHeight(bar)"
          :fill="volumeColor(bar, index)"
        />
      </g>
      <g v-if="activeBar" class="replay-intraday-panel__crosshair">
        <line :x1="xAt(activeIndex)" :x2="xAt(activeIndex)" :y1="PRICE_TOP" :y2="VOLUME_BOTTOM" />
        <circle :cx="xAt(activeIndex)" :cy="yAt(activeBar.close)" r="3.5" />
      </g>
      <g class="replay-intraday-panel__times">
        <text
          v-for="tick in timeTicks"
          :key="tick.label"
          :x="PLOT_LEFT + tick.ratio * (PLOT_RIGHT - PLOT_LEFT)"
          y="263"
          :text-anchor="tick.anchor"
        >
          {{ tick.label }}
        </text>
      </g>
    </svg>

    <div v-else class="replay-intraday-panel__empty">
      <Clock3 :size="18" />
      <span>{{ stepMinutes === 5 ? "推进5分钟后开始绘制当日分时" : "推进1分钟后开始绘制当日分时" }}</span>
    </div>
  </section>
</template>

<style scoped>
.replay-intraday-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 12px;
  background: var(--ql-color-bg-surface-strong);
}

.replay-intraday-panel__header {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--ql-line);
}

.replay-intraday-panel__header h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.replay-intraday-panel__header p,
.replay-intraday-panel__header > span {
  margin: 3px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.replay-intraday-panel__header p {
  display: flex;
  gap: 5px;
}

.replay-intraday-panel__header strong {
  color: var(--ql-ink);
}

.replay-intraday-panel__header .replay-intraday-panel__average {
  color: #d97706;
}

.replay-intraday-panel__chart {
  display: block;
  width: 100%;
  height: 248px;
  touch-action: none;
}

.replay-intraday-panel__grid line {
  stroke: #e5e7eb;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.replay-intraday-panel__grid text,
.replay-intraday-panel__times text {
  fill: var(--ql-color-text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.replay-intraday-panel__grid .rise {
  fill: #dc2626;
}

.replay-intraday-panel__grid .fall {
  fill: #059669;
}

.replay-intraday-panel__reference {
  stroke: #94a3b8;
  stroke-dasharray: 4 4;
  vector-effect: non-scaling-stroke;
}

.replay-intraday-panel__price-line,
.replay-intraday-panel__average-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.replay-intraday-panel__price-line {
  stroke: #2563eb;
  stroke-width: 1.5;
}

.replay-intraday-panel__average-line {
  stroke: #f59e0b;
  stroke-width: 1.35;
}

.replay-intraday-panel__crosshair line {
  stroke: #64748b;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.replay-intraday-panel__crosshair circle {
  fill: var(--ql-color-bg-surface-strong);
  stroke: #2563eb;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.replay-intraday-panel__empty {
  display: grid;
  min-height: 180px;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
}
</style>
