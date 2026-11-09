<script setup>
import { X } from "lucide-vue-next";
import { useTemplateRef } from "vue";
import UiInput from "./UiInput.vue";

defineProps({
  from: { type: String, default: "" },
  to: { type: String, default: "" },
  label: { type: String, default: "日期范围" },
  fromLabel: { type: String, default: "开始日期" },
  toLabel: { type: String, default: "结束日期" },
});

const emit = defineEmits(["update:from", "update:to"]);
const rangeRoot = useTemplateRef("rangeRoot");

function clear() {
  emit("update:from", "");
  emit("update:to", "");
  rangeRoot.value.querySelector("input").focus();
}
</script>

<template>
  <fieldset ref="rangeRoot" class="ql-ui-date-range" :aria-label="label">
    <div class="ql-ui-control ql-ui-date-range__control">
      <UiInput
        class="ql-ui-date-range__input"
        type="date"
        :model-value="from"
        :aria-label="fromLabel"
        @update:model-value="emit('update:from', $event)"
      />
      <span class="ql-ui-date-range__separator" aria-hidden="true">至</span>
      <UiInput
        class="ql-ui-date-range__input"
        type="date"
        :model-value="to"
        :aria-label="toLabel"
        @update:model-value="emit('update:to', $event)"
      />
      <button
        v-if="from || to"
        class="ql-ui-date-range__clear"
        type="button"
        :aria-label="`清空${label}`"
        @click="clear"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </div>
  </fieldset>
</template>

<style scoped>
.ql-ui-date-range {
  border: 0;
  margin: 0;
  min-width: 0;
  padding: 0;
}

.ql-ui-date-range__control {
  align-items: center;
  display: flex;
  padding: 0 6px;
}

.ql-ui-date-range__control:focus-within {
  border-color: var(--ql-color-primary);
  box-shadow: 0 0 0 4px var(--ql-color-primary-ring);
}

.ql-ui-date-range__input {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  flex: 1 1 0;
  min-height: calc(var(--ql-control-height-lg) - 2px);
  min-width: 0;
  padding: 0 6px;
}

.ql-ui-date-range__input:focus {
  box-shadow: none;
}

.ql-ui-date-range__separator {
  color: var(--ql-color-text-muted);
  flex: none;
  font-size: 12px;
}

.ql-ui-date-range__clear {
  align-items: center;
  border-radius: var(--ql-radius-field);
  color: var(--ql-color-text-muted);
  display: inline-flex;
  flex: none;
  justify-content: center;
  min-height: 28px;
  width: 28px;
}

.ql-ui-date-range__clear:hover {
  background: var(--ql-paper-soft);
  color: var(--ql-ink);
}

.ql-ui-date-range__clear:focus-visible {
  outline: 2px solid var(--ql-color-primary);
  outline-offset: -2px;
}
</style>
