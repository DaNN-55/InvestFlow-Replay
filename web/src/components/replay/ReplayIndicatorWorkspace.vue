<script setup>
import { computed, shallowRef, watch } from "vue";

import {
  REPLAY_INDICATOR_LIMIT_MESSAGE,
  useReplayIndicators,
} from "../../composables/useReplayIndicators";
import {
  calculateBoll,
  calculateKdj,
  calculateMa,
  calculateMacd,
  calculateRsi,
  evaluateReplayIndicator,
} from "../../utils/replayIndicatorEngine";
import ReplayIndicatorEditor from "./ReplayIndicatorEditor.vue";
import ReplayIndicatorPanel from "./ReplayIndicatorPanel.vue";
import ReplayIndicatorToolbar from "./ReplayIndicatorToolbar.vue";

const props = defineProps({
  bars: {
    type: Array,
    default: () => [],
  },
  visibleRange: {
    type: Object,
    default: null,
  },
  sharedHoverIndex: {
    type: [Number, null],
    default: null,
  },
});

const emit = defineEmits(["main-overlays-change", "hover-index-change"]);

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

const customMainResults = computed(() =>
  customIndicators.value
    .filter((indicator) => indicator.placement === "main")
    .map((indicator) => ({
      indicator,
      result: evaluateReplayIndicator(indicator.expression, props.bars),
    })),
);

const mainOverlays = computed(() => {
  const overlays = [];
  if (defaultVisibility.value.ma) {
    const ma = calculateMa(props.bars);
    for (const [period, color] of [
      [5, "#ef4444"],
      [10, "#f59e0b"],
      [20, "#2563eb"],
      [60, "#7c3aed"],
    ]) {
      overlays.push({
        id: `ma${period}`,
        label: `MA${period}`,
        color,
        values: ma[`ma${period}`] ?? [],
      });
    }
  }
  if (defaultVisibility.value.boll) {
    const boll = calculateBoll(props.bars);
    overlays.push(
      {
        id: "boll-upper",
        label: "BOLL 上轨",
        color: "#0f766e",
        values: boll.upper,
      },
      {
        id: "boll-middle",
        label: "BOLL 中轨",
        color: "#64748b",
        values: boll.middle,
      },
      {
        id: "boll-lower",
        label: "BOLL 下轨",
        color: "#0f766e",
        values: boll.lower,
      },
    );
  }
  overlays.push(
    ...customMainResults.value
      .filter(({ indicator }) =>
        visibleMainIndicatorIds.value.includes(indicator.id),
      )
      .map(({ indicator, result }) => ({
        id: indicator.id,
        label: indicator.name,
        color: indicator.color,
        values: result.values,
      })),
  );
  return overlays;
});

const mainIndicatorErrors = computed(() =>
  customMainResults.value
    .filter(
      ({ indicator, result }) =>
        visibleMainIndicatorIds.value.includes(indicator.id) && result.error,
    )
    .map(({ indicator, result }) => `${indicator.name}：${result.error}`),
);

const macdPanel = computed(() => {
  try {
    const result = calculateMacd(props.bars);
    return {
      id: "macd",
      title: "MACD（12, 26, 9）",
      series: [
        { label: "DIF", color: "#2563eb", values: result.dif },
        { label: "DEA", color: "#f59e0b", values: result.dea },
        {
          label: "MACD",
          color: "#64748b",
          values: result.histogram,
          type: "histogram",
        },
      ],
      error: "",
    };
  } catch (error) {
    return {
      id: "macd",
      title: "MACD（12, 26, 9）",
      series: [],
      error: error?.message ?? "MACD 计算失败",
    };
  }
});

const rsiPanel = computed(() => {
  try {
    return {
      id: "rsi",
      title: "RSI（14）",
      series: [
        {
          label: "RSI",
          color: "#7c3aed",
          values: calculateRsi(props.bars),
        },
      ],
      error: "",
    };
  } catch (error) {
    return {
      id: "rsi",
      title: "RSI（14）",
      series: [],
      error: error?.message ?? "RSI 计算失败",
    };
  }
});

const kdjPanel = computed(() => {
  try {
    const result = calculateKdj(props.bars);
    return {
      id: "kdj",
      title: "KDJ（9, 3, 3）",
      series: [
        { label: "K", color: "#2563eb", values: result.k },
        { label: "D", color: "#f59e0b", values: result.d },
        { label: "J", color: "#7c3aed", values: result.j },
      ],
      error: "",
    };
  } catch (error) {
    return {
      id: "kdj",
      title: "KDJ（9, 3, 3）",
      series: [],
      error: error?.message ?? "KDJ 计算失败",
    };
  }
});

const customPanels = computed(() =>
  customIndicators.value
    .filter(
      (indicator) =>
        indicator.placement !== "main" &&
        visiblePanelIds.value.includes(indicator.id),
    )
    .map((indicator) => {
      const result = evaluateReplayIndicator(indicator.expression, props.bars);
      return {
        ...indicator,
        title: indicator.name,
        series: [
          {
            label: indicator.name,
            color: indicator.color,
            values: result.values,
          },
        ],
        error: result.error ?? "",
      };
    }),
);

const visiblePanels = computed(() => [
  ...(visiblePanelIds.value.includes("macd") ? [macdPanel.value] : []),
  ...(visiblePanelIds.value.includes("rsi") ? [rsiPanel.value] : []),
  ...(visiblePanelIds.value.includes("kdj") ? [kdjPanel.value] : []),
  ...customPanels.value,
]);

watch(
  mainOverlays,
  (value) => emit("main-overlays-change", value),
  { immediate: true },
);

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
      v-for="error in mainIndicatorErrors"
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

    <div class="replay-indicator-workspace__panels">
      <ReplayIndicatorPanel
        v-for="panel in visiblePanels"
        :key="panel.id"
        :title="panel.title"
        :bars="bars"
        :series="panel.series"
        :error="panel.error"
        :visible-range="visibleRange"
        :shared-hover-index="sharedHoverIndex"
        :editable="!['macd', 'rsi', 'kdj'].includes(panel.id)"
        @hover-index-change="emit('hover-index-change', $event)"
        @edit="openEditEditor(panel)"
        @remove="removeCustomIndicator(panel.id)"
      />
      <div
        v-if="visiblePanels.length === 0"
        class="replay-indicator-workspace__empty"
      >
        暂未显示指标，可开启默认指标或新建自定义指标。
      </div>
    </div>
  </section>
</template>

<style scoped>
.replay-indicator-workspace {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--ql-line);
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

.replay-indicator-workspace__panels {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.replay-indicator-workspace__empty {
  padding: 18px;
  border: 1px dashed var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  text-align: center;
  font-size: 11px;
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
