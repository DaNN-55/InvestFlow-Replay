<script setup>
import { computed, shallowRef, watch } from "vue";

import {
  REPLAY_INDICATOR_LIMIT_MESSAGE,
  useReplayIndicators,
} from "../../composables/useReplayIndicators";
import {
  evaluateReplayAdvancedIndicator,
  evaluateReplayIndicator,
} from "../../utils/replayIndicatorEngine";
import ReplayIndicatorEditor from "./ReplayIndicatorEditor.vue";
import ReplayIndicatorToolbar from "./ReplayIndicatorToolbar.vue";

const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(["chart-indicators-change"]);

const {
  defaultVisibility,
  visiblePanelIds,
  visibleMainIndicatorIds,
  customIndicators,
  toggleDefaultIndicator,
  toggleCustomIndicator,
  saveCustomIndicator,
  removeCustomIndicator,
} = useReplayIndicators();

const editorOpen = shallowRef(false);
const editingIndicator = shallowRef(null);
const selectionMessage = shallowRef("");

function evaluateCustomIndicator(indicator) {
  const result = indicator.mode === "advanced"
    ? evaluateReplayAdvancedIndicator(indicator.advanced, props.bars)
    : evaluateReplayIndicator(indicator.expression, props.bars);
  const sourceSeries = indicator.mode === "advanced"
    ? result.series
    : [{
        label: indicator.name,
        color: indicator.color,
        type: "line",
        values: result.values,
      }];
  return {
    id: indicator.id,
    name: indicator.name,
    placement: indicator.placement,
    series: sourceSeries.map((series, index) => ({
      ...series,
      key: `series${index + 1}`,
    })),
    error: result.error ?? "",
  };
}

const chartIndicatorModel = computed(() => ({
  builtins: {
    main: [
      ...(defaultVisibility.value.ma ? ["MA"] : []),
      ...(defaultVisibility.value.boll ? ["BOLL"] : []),
    ],
    panes: visiblePanelIds.value
      .filter((id) => ["macd", "rsi", "kdj"].includes(id))
      .map((id) => id.toUpperCase()),
  },
  custom: customIndicators.value
    .filter((indicator) =>
      indicator.placement === "main"
        ? visibleMainIndicatorIds.value.includes(indicator.id)
        : visiblePanelIds.value.includes(indicator.id),
    )
    .map(evaluateCustomIndicator),
}));

const indicatorErrors = computed(() =>
  chartIndicatorModel.value.custom
    .filter((indicator) => indicator.error)
    .map((indicator) => `${indicator.name}：${indicator.error}`),
);

watch(chartIndicatorModel, (value) => emit("chart-indicators-change", value), {
  immediate: true,
});

function openCreateEditor() {
  editingIndicator.value = null;
  editorOpen.value = true;
}

function openEditEditor(indicator) {
  editingIndicator.value = indicator;
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
  editingIndicator.value = null;
}

function handleSave(indicator) {
  const saved = saveCustomIndicator(indicator);
  if (!saved) {
    return;
  }
  selectionMessage.value = visiblePanelIds.value.includes(saved.id)
    || saved.placement === "main"
      ? ""
      : REPLAY_INDICATOR_LIMIT_MESSAGE;
  closeEditor();
}

function handleToggleDefault(key) {
  const result = toggleDefaultIndicator(key);
  selectionMessage.value = result.message;
}

function handleToggleCustom(id) {
  const result = toggleCustomIndicator(id);
  selectionMessage.value = result.message;
}
</script>

<template>
  <section class="replay-indicator-workspace" aria-label="行情指标">
    <div class="replay-indicator-workspace__heading">
      <div>
        <h2>行情指标</h2>
        <p>仅根据当前已揭示的 {{ bars.length }} 根 K 线计算</p>
      </div>
      <ReplayIndicatorToolbar
        :default-visibility="defaultVisibility"
        :custom-indicators="customIndicators"
        :visible-panel-ids="visiblePanelIds"
        :visible-main-indicator-ids="visibleMainIndicatorIds"
        @toggle-default="handleToggleDefault"
        @toggle-custom="handleToggleCustom"
        @edit-custom="openEditEditor"
        @remove-custom="removeCustomIndicator"
        @create="openCreateEditor"
      />
    </div>

    <p
      v-if="selectionMessage"
      class="replay-indicator-workspace__limit"
      role="status"
      aria-live="polite"
    >
      {{ selectionMessage }}
    </p>

    <p
      v-for="error in indicatorErrors"
      :key="error"
      class="replay-indicator-workspace__error"
      role="status"
    >
      {{ error }}
    </p>

    <ReplayIndicatorEditor
      v-if="editorOpen"
      :indicator="editingIndicator"
      @save="handleSave"
      @cancel="closeEditor"
    />
  </section>
</template>

<style scoped>
.replay-indicator-workspace {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--ql-line);
  background: var(--ql-paper-soft);
}

.replay-indicator-workspace__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.replay-indicator-workspace h2 {
  margin: 0;
  color: var(--ql-ink);
  font-size: 13px;
  font-weight: 740;
}

.replay-indicator-workspace p {
  margin: 3px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

.replay-indicator-workspace__limit {
  margin: 0;
  padding: 7px 9px;
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 7px;
  color: #92400e !important;
  background: var(--ql-color-warning-soft);
  font-size: 11px !important;
}

.replay-indicator-workspace__error {
  margin: 0;
  padding: 7px 9px;
  border: 1px solid rgba(220, 38, 38, 0.2);
  border-radius: 7px;
  color: #b91c1c !important;
  background: #fef2f2;
  font-size: 11px !important;
}

@media (max-width: 640px) {
  .replay-indicator-workspace {
    padding: 10px 6px;
  }

  .replay-indicator-workspace__heading {
    align-items: stretch;
    flex-direction: column;
    gap: 9px;
  }
}
</style>
