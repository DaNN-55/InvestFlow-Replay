<script setup>
import { reactive, watch } from "vue";

import { toDateInput, toExecutionEventDate } from "../utils/tradeExecutionDateTime.js";
import UiButton from "./ui/UiButton.vue";
import UiInput from "./ui/UiInput.vue";
import UiModal from "./ui/UiModal.vue";
import UiSelect from "./ui/UiSelect.vue";
import UiTextarea from "./ui/UiTextarea.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  event: { type: Object, default: null },
  saving: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["close", "save"]);

const actionOptions = [
  { value: "buy", label: "买入" },
  { value: "add", label: "加仓" },
  { value: "reduce", label: "减仓" },
  { value: "sell", label: "卖出" },
  { value: "hold", label: "持有" },
  { value: "note", label: "备注" },
];

const form = reactive({
  eventAt: "",
  action: "buy",
  price: "",
  quantity: "",
  fee: "",
  planStatus: "unknown",
  source: "",
  note: "",
});

function applyEvent(event = {}) {
  form.eventAt = toDateInput(event.eventAt);
  form.action = event.action ?? "buy";
  form.price = event.price ?? "";
  form.quantity = event.quantity ?? "";
  form.fee = event.fee ?? "";
  form.planStatus = event.planStatus ?? "unknown";
  form.source = event.source ?? "";
  form.note = event.note ?? "";
}

function optionalNumber(value) {
  return value === "" || value == null ? null : Number(value);
}

function submit() {
  if (!form.eventAt || !form.action) return;
  emit("save", {
    eventAt: toExecutionEventDate(form.eventAt),
    action: form.action,
    price: optionalNumber(form.price),
    quantity: optionalNumber(form.quantity),
    fee: optionalNumber(form.fee) ?? 0,
    planStatus: form.planStatus,
    source: form.source.trim(),
    note: form.note.trim(),
  });
}

watch(
  () => [props.open, props.event],
  ([open, event]) => {
    if (open) applyEvent(event);
  },
  { immediate: true },
);
</script>

<template>
  <UiModal
    :open="open"
    title="修改成交或动作记录"
    description="保存后会重新计算持仓、成本、盈亏和交易阶段。"
    :busy="saving"
    panel-class="trade-execution-event-dialog__panel"
    @close="emit('close')"
  >
    <form class="trade-execution-event-dialog" @submit.prevent="submit">
      <div class="trade-execution-event-dialog__grid">
        <label>
          <span>时间</span>
          <UiInput v-model="form.eventAt" type="date" :disabled="saving" />
        </label>
        <label>
          <span>动作</span>
          <UiSelect v-model="form.action" :disabled="saving">
            <option v-for="option in actionOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </UiSelect>
        </label>
        <label>
          <span>价格</span>
          <UiInput v-model="form.price" type="number" min="0" step="0.01" :disabled="saving" />
        </label>
        <label>
          <span>数量</span>
          <UiInput v-model="form.quantity" type="number" min="0" step="100" :disabled="saving" />
        </label>
        <label>
          <span>费用</span>
          <UiInput v-model="form.fee" type="number" min="0" step="0.01" :disabled="saving" />
        </label>
        <label>
          <span>是否按计划</span>
          <UiSelect v-model="form.planStatus" :disabled="saving">
            <option value="unknown">未标记</option>
            <option value="planned">计划内</option>
            <option value="unplanned">计划外</option>
          </UiSelect>
        </label>
        <label class="trade-execution-event-dialog__source">
          <span>来源</span>
          <UiInput v-model="form.source" type="text" :disabled="saving" />
        </label>
        <label class="trade-execution-event-dialog__note">
          <span>备注</span>
          <UiTextarea v-model="form.note" :disabled="saving" />
        </label>
      </div>
      <p v-if="error" class="trade-execution-event-dialog__error" role="alert">{{ error }}</p>
      <div class="trade-execution-event-dialog__actions">
        <UiButton type="button" variant="secondary" :disabled="saving" @click="emit('close')">取消</UiButton>
        <UiButton type="submit" :loading="saving" :disabled="!form.eventAt">保存修改</UiButton>
      </div>
    </form>
  </UiModal>
</template>

<style scoped>
.trade-execution-event-dialog {
  display: grid;
  gap: 16px;
}

.trade-execution-event-dialog__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.trade-execution-event-dialog__grid label {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.trade-execution-event-dialog__grid label > span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.trade-execution-event-dialog__source {
  grid-column: span 2;
}

.trade-execution-event-dialog__note {
  grid-column: 1 / -1;
}

.trade-execution-event-dialog__error {
  margin: 0;
  color: var(--ql-color-danger, #d92d20);
  font-size: 12px;
}

.trade-execution-event-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 640px) {
  .trade-execution-event-dialog__grid {
    grid-template-columns: 1fr;
  }

  .trade-execution-event-dialog__source,
  .trade-execution-event-dialog__note {
    grid-column: auto;
  }
}
</style>
