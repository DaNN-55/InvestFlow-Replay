<script setup>
import { ChartCandlestick } from "lucide-vue-next";
import { computed, shallowRef, watch } from "vue";

import {
  aggregateReplayBars,
  mapReplayExecutionsToTrades,
} from "../../utils/replayMarket";
import CandlestickChart from "../CandlestickChart.vue";
import ReplayIndicatorWorkspace from "./ReplayIndicatorWorkspace.vue";

const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
  executions: {
    type: Array,
    default: () => [],
  },
  reveal: {
    type: Object,
    default: null,
  },
  sessionInterval: {
    type: String,
    default: "1d",
  },
  observationBars: {
    type: Number,
    default: 0,
  },
  stepMinutes: {
    type: Number,
    default: 1,
  },
});

const period = shallowRef("day");
const chartIndicators = shallowRef({
  builtins: { main: ["MA"], panes: ["MACD", "RSI"] },
  custom: [],
});
const periodOptions = computed(() =>
  props.sessionInterval === "1m"
    ? [
        { value: "minute", label: "分" },
      ]
    : [
        { value: "day", label: "日" },
        { value: "week", label: "周" },
        { value: "month", label: "月" },
      ],
);

watch(
  () => props.sessionInterval,
  (interval) => {
    period.value = interval === "1m" ? "minute" : "day";
  },
  { immediate: true },
);

const chartBars = computed(() =>
  aggregateReplayBars(props.bars, period.value),
);
const chartTrades = computed(() =>
  mapReplayExecutionsToTrades(props.executions, chartBars.value, {
    sessionInterval: props.sessionInterval,
    observationBars: props.observationBars,
    stepMinutes: props.stepMinutes,
  }),
);
const latestBar = computed(() => props.bars.at(-1) ?? null);
const chartResetKey = computed(() => `${period.value}-chart`);

function formatPrice(value) {
  return Number(value ?? 0).toFixed(2);
}

function formatAmount(value) {
  const amount = Number(value ?? 0);
  if (amount >= 100000000) {
    return `${(amount / 100000000).toFixed(2)} 亿`;
  }
  if (amount >= 10000) {
    return `${(amount / 10000).toFixed(2)} 万`;
  }
  return amount.toFixed(0);
}
</script>

<template>
  <section class="replay-chart-panel">
    <header class="replay-chart-panel__header">
      <div class="replay-chart-panel__heading">
        <span class="replay-chart-panel__icon">
          <ChartCandlestick :size="17" />
        </span>
        <div v-if="reveal">
          <h2 class="replay-chart-panel__title">
            {{ reveal.name || reveal.tsCode }} · {{ reveal.tsCode }}
          </h2>
          <p class="replay-chart-panel__subtitle">
            {{ reveal.startDate }} 至 {{ reveal.endDate }} · 完整行情
          </p>
        </div>
        <div v-else>
          <h2 class="replay-chart-panel__title">
            匿名标的 · {{ sessionInterval === "1m" ? "1 分钟" : "日线" }}盲测
          </h2>
          <p class="replay-chart-panel__subtitle">
            仅包含当前已揭示行情
          </p>
        </div>
      </div>
      <div class="replay-chart-panel__periods" aria-label="K线周期">
        <button
          v-for="option in periodOptions"
          :key="option.value"
          type="button"
          :aria-pressed="period === option.value"
          class="replay-chart-panel__period"
          :class="{ 'replay-chart-panel__period--active': period === option.value }"
          @click="period = option.value"
        >
          {{ option.label }}
        </button>
      </div>
    </header>

    <div v-if="latestBar" class="replay-chart-panel__quote">
      <span class="replay-chart-panel__quote-label">
        {{ latestBar.displayLabel }}
      </span>
      <span>开 <strong>{{ formatPrice(latestBar.open) }}</strong></span>
      <span>高 <strong class="replay-chart-panel__rise">{{ formatPrice(latestBar.high) }}</strong></span>
      <span>低 <strong class="replay-chart-panel__fall">{{ formatPrice(latestBar.low) }}</strong></span>
      <span>收 <strong>{{ formatPrice(latestBar.close) }}</strong></span>
      <span>额 <strong>{{ formatAmount(latestBar.amount) }}</strong></span>
    </div>

    <ReplayIndicatorWorkspace
      :bars="chartBars"
      @chart-indicators-change="chartIndicators = $event"
    />
    <div class="replay-chart-panel__chart">
      <CandlestickChart
        :key="chartResetKey"
        :bars="chartBars"
        :trades="chartTrades"
        :indicators="chartIndicators"
      />
    </div>
  </section>
</template>

<style scoped>
.replay-chart-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 12px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-xs);
}

.replay-chart-panel__header {
  display: flex;
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ql-line);
}

.replay-chart-panel__heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.replay-chart-panel__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-chart-panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 720;
  letter-spacing: -0.02em;
}

.replay-chart-panel__subtitle {
  margin: 3px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 11px;
}

.replay-chart-panel__periods {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  background: var(--ql-paper-soft);
}

.replay-chart-panel__period {
  min-width: 38px;
  min-height: 30px;
  border: 0;
  border-radius: 6px;
  color: var(--ql-color-text-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.replay-chart-panel__period--active {
  color: var(--ql-accent);
  background: var(--ql-color-bg-surface-strong);
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
}

.replay-chart-panel__quote {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 18px;
  overflow-x: auto;
  padding: 0 18px;
  border-bottom: 1px solid var(--ql-line);
  color: var(--ql-color-text-muted);
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 11px;
  white-space: nowrap;
}

.replay-chart-panel__quote strong {
  color: var(--ql-ink);
  font-size: 12px;
}

.replay-chart-panel__quote-label {
  color: var(--ql-accent);
  font-family: inherit;
  font-weight: 700;
}

.replay-chart-panel__quote .replay-chart-panel__rise {
  color: var(--ql-rise);
}

.replay-chart-panel__quote .replay-chart-panel__fall {
  color: var(--ql-fall);
}

.replay-chart-panel__chart {
  padding: 12px;
}

.replay-chart-panel__chart :deep(.ql-rounded-2xl) {
  border: 0;
  box-shadow: none;
}

@media (max-width: 640px) {
  .replay-chart-panel__header {
    align-items: flex-start;
  }

  .replay-chart-panel__chart {
    padding: 6px;
  }
}
</style>
