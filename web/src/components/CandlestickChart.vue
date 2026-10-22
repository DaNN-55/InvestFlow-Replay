<script setup>
import {
  ChartNoAxesCombined,
  Eraser,
  Minus,
  MoveRight,
  Square,
  Trash2,
  TrendingUp,
  Undo2,
} from "lucide-vue-next";
import { computed, shallowRef } from "vue";

import { useReplayKlineChart } from "../composables/useReplayKlineChart.js";
import { REPLAY_DRAWING_TOOLS } from "../utils/replayKlineDrawings.js";

const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
  priceLines: { type: Array, default: () => [] },
  priceStep: { type:String, default:'' },
  height: { type: Number, default: 0 },
  colors: { type: Object, default: () => ({}) },
  compact: Boolean,
  showVolume: { type: Boolean, default: true },
  trades: {
    type: Array,
    default: () => [],
  },
  indicators: {
    type: Object,
    default: () => ({
      builtins: { main: [], panes: [] },
      custom: [],
    }),
  },
});

const host = shallowRef(null);
const subPaneCount = computed(() =>
  (props.indicators?.builtins?.panes?.length ?? 0) +
  (props.indicators?.custom?.filter(
    (indicator) => indicator.placement === "sub" && !indicator.error,
  ).length ?? 0),
);
const chartHeight = computed(() => props.height || 330 + (props.showVolume ? 92 : 0) + subPaneCount.value * 126 + 24);
const emit = defineEmits(['crosshair','range','price-line-drag','price-line-cancel']);
const drawingIcons = Object.freeze({
  trend: TrendingUp,
  horizontal: Minus,
  ray: MoveRight,
  rectangle: Square,
  fibonacci: ChartNoAxesCombined,
});

const chartModel = computed(() => ({
  bars: props.bars,
  priceLines: props.priceLines,
  priceStep: props.priceStep,
  trades: props.trades,
  indicators: props.indicators,
  colors: props.colors,
  compact: props.compact,
  showVolume: props.showVolume,
}));
const { state, drawing, commands } = useReplayKlineChart({
  host,
  model: chartModel,
  onCrosshair: value => emit('crosshair',value),
  onRange: value => emit('range',value),
  onPriceLineDrag: value => emit('price-line-drag',value),
  onPriceLineCancel: value => emit('price-line-cancel',value),
});
defineExpose({ syncCrosshair: value=>commands.syncCrosshair(value), syncRange:(value,dateRange)=>commands.syncRange(value,dateRange), latest:()=>commands.latest() });
</script>

<template>
  <div class="replay-kline-chart">
    <p v-if="state.error" class="replay-kline-chart__error" role="alert">
      {{ state.error }}
    </p>
    <div class="replay-kline-chart__drawing-toolbar" role="toolbar" aria-label="K线画图工具">
      <button
        v-for="tool in REPLAY_DRAWING_TOOLS"
        :key="tool.id"
        type="button"
        :aria-label="tool.label"
        :title="tool.label"
        :aria-pressed="drawing.activeTool === tool.id"
        :class="{ 'replay-kline-chart__drawing-button--active': drawing.activeTool === tool.id }"
        class="replay-kline-chart__drawing-button"
        @click="commands.startDrawing(tool.id)"
      >
        <component :is="drawingIcons[tool.id]" :size="15" />
      </button>
      <span class="replay-kline-chart__drawing-separator" aria-hidden="true" />
      <button
        type="button"
        class="replay-kline-chart__drawing-button"
        aria-label="撤销"
        title="撤销最后一笔画图"
        :disabled="!drawing.hasDrawings"
        @click="commands.undoDrawing"
      >
        <Undo2 :size="15" />
      </button>
      <button
        type="button"
        class="replay-kline-chart__drawing-button"
        aria-label="删除选中"
        title="删除选中的画图"
        :disabled="!drawing.selectedId"
        @click="commands.deleteSelectedDrawing"
      >
        <Trash2 :size="15" />
      </button>
      <button
        type="button"
        class="replay-kline-chart__drawing-button"
        aria-label="清空画图"
        title="清空全部画图"
        :disabled="!drawing.hasDrawings"
        @click="commands.clearDrawings"
      >
        <Eraser :size="15" />
      </button>
    </div>
    <ul v-if="priceLines.length" class="replay-price-lines" :class="{'replay-price-lines--compact':compact}" aria-label="当前图表状态线">
      <li v-for="line in priceLines" :key="line.id" :data-price-line-id="line.id" :data-price-line-value="line.price" :data-price-line-quantity="line.contracts"><span :style="{ borderColor: line.color, borderStyle: line.dashed ? 'dashed' : 'solid' }" />{{ line.label }} · {{ line.price }}<button v-if="line.cancellable" type="button" :aria-label="`撤销${line.cancelLabel}`" @click="emit('price-line-cancel',{orderId:line.orderId,leg:line.protectionLeg})">×</button></li>
    </ul>
    <div
      ref="host"
      class="replay-kline-chart__canvas"
      :style="{ height: `${chartHeight}px` }"
      data-testid="replay-klinecharts-host"
    />
    <div v-if="!compact" class="replay-kline-chart__status" aria-live="polite">
      <span v-if="state.visibleRange.startLabel && state.visibleRange.endLabel">
        可视范围 {{ state.visibleRange.startLabel }} 至 {{ state.visibleRange.endLabel }}
      </span>
      <span>
        可视 {{ state.visibleRange.visibleCount }} / 共 {{ state.visibleRange.total }} 根
      </span>
      <span>Ctrl/⌘ + 滚轮缩放 · 拖拽平移</span>
    </div>
  </div>
</template>

<style scoped>
.replay-kline-chart {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 10px;
  background: var(--ql-color-bg-surface-strong);
}

.replay-kline-chart__canvas {
  width: 100%;
  min-width: 0;
  transition: height 160ms ease;
}

.replay-kline-chart__drawing-toolbar {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
  padding: 4px 8px;
  border-bottom: 1px solid var(--ql-line);
  background: var(--ql-paper-soft);
  scrollbar-width: thin;
}

.replay-kline-chart__drawing-button {
  display: inline-flex;
  width: 30px;
  height: 30px;
  min-height: 30px;
  flex: 0 0 auto;
  justify-content: center;
  align-items: center;
  padding: 0;
  border: 1px solid var(--ql-line-strong);
  border-radius: 6px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  cursor: pointer;
}

.replay-kline-chart__drawing-button:hover:not(:disabled),
.replay-kline-chart__drawing-button--active {
  border-color: var(--ql-accent);
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-kline-chart__drawing-button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.replay-kline-chart__drawing-separator {
  width: 1px;
  height: 20px;
  flex: 0 0 auto;
  margin: 0 2px;
  background: var(--ql-line-strong);
}

.replay-kline-chart__status {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-top: 1px solid var(--ql-line);
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

.replay-kline-chart__error {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(220, 38, 38, 0.2);
  color: #b91c1c;
  background: #fef2f2;
  font-size: 11px;
}

@media (max-width: 640px) {
  .replay-kline-chart__status {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
    padding: 7px 9px;
  }
}
</style>

<style scoped>
.replay-price-lines { list-style: none; margin: 0; padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11px; border-bottom: 1px solid var(--ql-line); }
.replay-price-lines li { display: inline-flex; align-items: center; gap: 6px; }
.replay-price-lines--compact { position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0; }
.replay-price-lines--compact:focus-within { z-index:10;top:36px;left:0;right:0;width:auto;height:auto;margin:0;padding:8px 12px;overflow:visible;clip-path:none;white-space:normal;background:var(--ql-color-bg-surface-strong); }
.replay-price-lines button { border:1px solid var(--ql-line-strong);border-radius:4px;background:var(--ql-color-bg-surface-strong);color:var(--ql-color-text-body);cursor:pointer; }
.replay-price-lines button:focus-visible { outline:2px solid var(--ql-accent);outline-offset:2px; }
.replay-price-lines span { width: 20px; border-top-width: 2px; }
</style>
