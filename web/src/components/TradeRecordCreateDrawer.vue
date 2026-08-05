<script setup>
import { reactive, watch } from "vue";

import { buildStandaloneTradeRecordPayload } from "../utils/tradeRecordPresentation.js";
import UiButton from "./ui/UiButton.vue";
import UiDrawer from "./ui/UiDrawer.vue";
import UiInput from "./ui/UiInput.vue";
import UiSelect from "./ui/UiSelect.vue";

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  saving: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["close", "create"]);

const form = reactive(createEmptyForm());

function createEmptyForm() {
  return {
    stockCode: "",
    stockName: "",
    accountType: "simulated",
    tradeType: "system",
    strategyName: "",
    strategyVersion: "",
  };
}

function resetForm() {
  Object.assign(form, createEmptyForm());
}

function submit() {
  if (!form.stockCode.trim()) return;
  emit("create", buildStandaloneTradeRecordPayload({
    stockCode: form.stockCode,
    stockName: form.stockName,
    accountType: form.accountType,
    tradeType: form.tradeType,
    strategyProfile: {
      key: "custom",
      name: form.strategyName,
      version: form.strategyVersion,
    },
  }));
}

watch(
  () => props.open,
  (open) => {
    if (open) resetForm();
  },
);
</script>

<template>
  <UiDrawer
    :open="open"
    title="新建交易追踪"
    description="不依赖市场扫描或个股诊断，先建一笔交易，再按实际发生逐笔记录。"
    panel-class="trade-record-create-drawer"
    @close="emit('close')"
  >
    <form class="trade-record-create" @submit.prevent="submit">
      <section>
        <h3>标的</h3>
        <label>
          <span>股票代码 *</span>
          <UiInput v-model="form.stockCode" type="text" placeholder="如 600519" :disabled="saving" autofocus />
        </label>
        <label>
          <span>股票名称</span>
          <UiInput v-model="form.stockName" type="text" placeholder="可稍后补充" :disabled="saving" />
        </label>
      </section>

      <section>
        <h3>分类</h3>
        <label>
          <span>账户类型</span>
          <UiSelect v-model="form.accountType" :disabled="saving">
            <option value="simulated">模拟</option>
            <option value="live">实盘</option>
          </UiSelect>
        </label>
        <label>
          <span>交易类型</span>
          <UiSelect v-model="form.tradeType" :disabled="saving">
            <option value="system">系统交易</option>
            <option value="subjective">主观交易</option>
            <option value="violation">违规交易</option>
          </UiSelect>
        </label>
      </section>

      <section>
        <h3>战法（可选）</h3>
        <label>
          <span>战法名称</span>
          <UiInput v-model="form.strategyName" type="text" placeholder="没有就先留空" :disabled="saving" />
        </label>
        <label>
          <span>版本</span>
          <UiInput v-model="form.strategyVersion" type="text" placeholder="如 v1" :disabled="saving" />
        </label>
      </section>

      <p v-if="error" class="trade-record-create__error">{{ error }}</p>
      <div class="trade-record-create__actions">
        <UiButton type="button" variant="secondary" :disabled="saving" @click="emit('close')">取消</UiButton>
        <UiButton type="submit" :loading="saving" :disabled="saving || !form.stockCode.trim()">创建追踪单</UiButton>
      </div>
    </form>
  </UiDrawer>
</template>

<style scoped>
:global(.trade-record-create-drawer) {
  width: min(440px, 100vw);
}

.trade-record-create {
  display: grid;
  gap: 18px;
}

.trade-record-create section {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.trade-record-create h3 {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ql-color-text-strong);
  font-size: 13px;
}

.trade-record-create label {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.trade-record-create label > span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.trade-record-create__error {
  margin: 0;
  color: var(--ql-color-danger, #b91c1c);
  font-size: 12px;
}

.trade-record-create__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
}

@media (max-width: 560px) {
  .trade-record-create section {
    grid-template-columns: 1fr;
  }
}
</style>
