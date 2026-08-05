<script setup>
import { computed } from "vue";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-vue-next";

const MAIN_INDICATORS = [
  { key: "ma", label: "MA" },
  { key: "boll", label: "BOLL" },
];
const SUB_INDICATORS = [
  { key: "macd", label: "MACD" },
  { key: "rsi", label: "RSI" },
  { key: "kdj", label: "KDJ" },
];

const props = defineProps({
  defaultVisibility: {
    type: Object,
    required: true,
  },
  customIndicators: {
    type: Array,
    default: () => [],
  },
  visiblePanelIds: {
    type: Array,
    default: () => [],
  },
  visibleMainIndicatorIds: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits([
  "toggle-default",
  "toggle-custom",
  "edit-custom",
  "remove-custom",
  "create",
]);

function selectedLabels(indicators) {
  return indicators
    .filter((indicator) => props.defaultVisibility[indicator.key])
    .map((indicator) => indicator.label);
}

const mainCustomIndicators = computed(() =>
  props.customIndicators.filter((indicator) => indicator.placement === "main"),
);
const subCustomIndicators = computed(() =>
  props.customIndicators.filter((indicator) => indicator.placement !== "main"),
);
const mainSummary = computed(() => {
  const labels = selectedLabels(MAIN_INDICATORS);
  labels.push(
    ...mainCustomIndicators.value
      .filter((indicator) =>
        props.visibleMainIndicatorIds.includes(indicator.id),
      )
      .map((indicator) => indicator.name),
  );
  return labels.join("、") || "未开启";
});
const subSummary = computed(() => {
  const labels = selectedLabels(SUB_INDICATORS);
  labels.push(
    ...subCustomIndicators.value
      .filter((indicator) => props.visiblePanelIds.includes(indicator.id))
      .map((indicator) => indicator.name),
  );
  return labels.join("、") || "未开启";
});
</script>

<template>
  <div class="replay-indicator-toolbar">
    <div class="replay-indicator-toolbar__groups">
      <details class="replay-indicator-toolbar__selector">
        <summary aria-label="选择主图指标">
          <span class="replay-indicator-toolbar__selector-label">主图</span>
          <span class="replay-indicator-toolbar__selector-summary">{{ mainSummary }}</span>
          <ChevronDown :size="14" aria-hidden="true" />
        </summary>
        <div class="replay-indicator-toolbar__menu" role="group" aria-label="主图指标">
          <label v-for="indicator in MAIN_INDICATORS" :key="indicator.key">
            <input
              type="checkbox"
              :checked="defaultVisibility[indicator.key]"
              @change="emit('toggle-default', indicator.key)"
            />
            <span>{{ indicator.label }}</span>
          </label>
          <div
            v-for="indicator in mainCustomIndicators"
            :key="indicator.id"
            class="replay-indicator-toolbar__custom-row"
          >
            <label>
              <input
                type="checkbox"
                :checked="visibleMainIndicatorIds.includes(indicator.id)"
                @change="emit('toggle-custom', indicator.id)"
              />
              <span>{{ indicator.name }}</span>
            </label>
            <button
              type="button"
              :aria-label="`编辑指标：${indicator.name}`"
              @click="emit('edit-custom', indicator)"
            >
              <Pencil :size="12" aria-hidden="true" />
            </button>
            <button
              type="button"
              :aria-label="`删除指标：${indicator.name}`"
              @click="emit('remove-custom', indicator.id)"
            >
              <Trash2 :size="12" aria-hidden="true" />
            </button>
          </div>
        </div>
      </details>

      <details class="replay-indicator-toolbar__selector">
        <summary aria-label="选择副图指标">
          <span class="replay-indicator-toolbar__selector-label">副图</span>
          <span class="replay-indicator-toolbar__selector-summary">{{ subSummary }}</span>
          <ChevronDown :size="14" aria-hidden="true" />
        </summary>
        <div class="replay-indicator-toolbar__menu" role="group" aria-label="副图指标">
          <label v-for="indicator in SUB_INDICATORS" :key="indicator.key">
            <input
              type="checkbox"
              :checked="defaultVisibility[indicator.key]"
              @change="emit('toggle-default', indicator.key)"
            />
            <span>{{ indicator.label }}</span>
          </label>
          <div
            v-for="indicator in subCustomIndicators"
            :key="indicator.id"
            class="replay-indicator-toolbar__custom-row"
          >
            <label>
              <input
                type="checkbox"
                :checked="visiblePanelIds.includes(indicator.id)"
                @change="emit('toggle-custom', indicator.id)"
              />
              <span>{{ indicator.name }}</span>
            </label>
            <button
              type="button"
              :aria-label="`编辑指标：${indicator.name}`"
              @click="emit('edit-custom', indicator)"
            >
              <Pencil :size="12" aria-hidden="true" />
            </button>
            <button
              type="button"
              :aria-label="`删除指标：${indicator.name}`"
              @click="emit('remove-custom', indicator.id)"
            >
              <Trash2 :size="12" aria-hidden="true" />
            </button>
          </div>
        </div>
      </details>
    </div>

    <button
      type="button"
      class="replay-indicator-toolbar__create"
      @click="emit('create')"
    >
      <Plus :size="14" />
      自定义指标
    </button>
  </div>
</template>

<style scoped>
.replay-indicator-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.replay-indicator-toolbar__groups {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.replay-indicator-toolbar__selector {
  position: relative;
}

.replay-indicator-toolbar__selector summary,
.replay-indicator-toolbar__create {
  min-height: 30px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 7px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
}

.replay-indicator-toolbar__selector summary {
  display: inline-flex;
  max-width: 180px;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  list-style: none;
}

.replay-indicator-toolbar__selector summary::-webkit-details-marker {
  display: none;
}

.replay-indicator-toolbar__selector[open] summary {
  border-color: rgba(37, 99, 235, 0.32);
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-indicator-toolbar__selector-label {
  flex: 0 0 auto;
}

.replay-indicator-toolbar__selector-summary {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-indicator-toolbar__selector summary svg {
  flex: 0 0 auto;
  transition: transform 160ms ease;
}

.replay-indicator-toolbar__selector[open] summary svg {
  transform: rotate(180deg);
}

.replay-indicator-toolbar__menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  display: grid;
  min-width: 150px;
  max-width: 220px;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-md);
}

.replay-indicator-toolbar__selector:nth-child(2) .replay-indicator-toolbar__menu {
  right: 0;
  left: auto;
}

.replay-indicator-toolbar__menu label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--ql-ink);
  font-size: 11px;
  cursor: pointer;
}

.replay-indicator-toolbar__menu label:hover {
  background: var(--ql-paper-soft);
}

.replay-indicator-toolbar__custom-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px 26px;
  align-items: center;
}

.replay-indicator-toolbar__custom-row label {
  min-width: 0;
}

.replay-indicator-toolbar__custom-row label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-indicator-toolbar__custom-row > button {
  display: inline-flex;
  width: 26px;
  height: 28px;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  color: var(--ql-color-text-muted);
  background: transparent;
  cursor: pointer;
}

.replay-indicator-toolbar__custom-row > button:hover {
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-indicator-toolbar__create {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  color: var(--ql-accent);
}

@media (max-width: 480px) {
  .replay-indicator-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .replay-indicator-toolbar__groups {
    width: 100%;
  }

  .replay-indicator-toolbar__selector {
    min-width: 0;
    flex: 1 1 0;
  }

  .replay-indicator-toolbar__selector summary {
    display: flex;
    max-width: none;
  }

  .replay-indicator-toolbar__create {
    align-self: flex-start;
  }
}
</style>
