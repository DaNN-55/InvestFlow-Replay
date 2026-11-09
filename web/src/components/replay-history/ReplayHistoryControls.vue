<script setup>
import UiButton from "../ui/UiButton.vue";
import UiCard from "../ui/UiCard.vue";

defineProps({ activeView: { type: String, default: "records" } });
const emit = defineEmits(["viewChange"]);
const views = [{ key: "records", label: "记录列表" }, { key: "first", label: "A股首次分析" }, { key: "retrain", label: "A股复练分析" }];
</script>

<template>
  <UiCard class="replay-history-controls" body-class="replay-history-records__controls">
      <div class="replay-history-records__toolbar">
        <div class="replay-history-records__view-switch" role="group" aria-label="演练记录视图">
          <UiButton
            v-for="view in views"
            :key="view.key"
            variant="ghost"
            :aria-pressed="activeView === view.key"
            @click="emit('viewChange', view.key)"
          >
            {{ view.label }}
          </UiButton>
        </div>
      </div>
    <slot />
  </UiCard>
</template>

<style scoped>
:deep(.replay-history-records__controls) { display: grid; gap: 12px; padding: 12px 16px; }
.replay-history-records__toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 20px; }
.replay-history-records__view-switch { display: flex; flex-wrap: wrap; gap: 4px; }
.replay-history-records__view-switch :deep(button[aria-pressed="true"]) { background: var(--ql-color-primary-soft); color: var(--ql-color-primary); }
@media (max-width: 480px) { .replay-history-records__toolbar { gap: 6px; } }
</style>
