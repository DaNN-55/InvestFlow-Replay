<script setup>
import { ChartCandlestick } from "lucide-vue-next";
import { computed, toRef } from "vue";

import { useReplayChartPresentation } from "../../composables/useReplayChartPresentation.js";
import { formatDisplayDate } from "../../utils/datePresentation.js";
import CandlestickChart from "../CandlestickChart.vue";
import ReplayIndicatorWorkspace from "./ReplayIndicatorWorkspace.vue";

const props = defineProps({
  account:{type:Object,default:()=>({})},
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

const {
  period,
  periodOptions,
  chart,
  selectPeriod,
  setIndicators,
} = useReplayChartPresentation({
  bars: toRef(props, "bars"),
  executions: toRef(props, "executions"),
  sessionInterval: toRef(props, "sessionInterval"),
  observationBars: toRef(props, "observationBars"),
  stepMinutes: toRef(props, "stepMinutes"),
});
const costLines = computed(() => {
  const cost = Number(props.account.averageCost), quantity = Number(props.account.positionQuantity);
  return quantity > 0 && cost > 0 && Number.isFinite(cost) ? [{id:'ashare-position-cost',price:props.account.averageCost,reference:'entry',label:'持仓成本',compactLabel:`成本 ${cost.toFixed(2)} · ${quantity}股`,contracts:quantity,color:'#2563eb',dashed:false}] : [];
});
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
            {{ formatDisplayDate(reveal.startDate) }} 至 {{ formatDisplayDate(reveal.endDate) }} · 完整行情
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
          @click="selectPeriod(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </header>

    <ReplayIndicatorWorkspace
      :bars="chart.bars"
      @chart-indicators-change="setIndicators"
    />
    <div class="replay-chart-panel__chart">
      <CandlestickChart
        :key="chart.key"
        :bars="chart.bars"
        compact
        volume-unit="股"
        :price-lines="costLines"
        :trades="chart.trades"
        :indicators="chart.indicators"
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
