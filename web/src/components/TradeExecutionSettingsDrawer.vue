<script setup>
import { reactive, ref, watch } from "vue";

import { api } from "../services/api";
import UiAlert from "./ui/UiAlert.vue";
import UiButton from "./ui/UiButton.vue";
import UiDrawer from "./ui/UiDrawer.vue";
import UiInput from "./ui/UiInput.vue";

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["close", "saved"]);
const loading = ref(false);
const saving = ref(false);
const feedback = ref("");
const feedbackTone = ref("info");
const form = reactive({
  simulatedAccountEquity: "",
  liveAccountEquity: "",
  defaultMinRewardRiskRatio: "2",
  defaultMaxAccountRiskPct: "0.5",
});

function applySettings(settings = {}) {
  form.simulatedAccountEquity = settings.simulatedAccountEquity ?? "";
  form.liveAccountEquity = settings.liveAccountEquity ?? "";
  form.defaultMinRewardRiskRatio = settings.defaultMinRewardRiskRatio ?? 2;
  form.defaultMaxAccountRiskPct = settings.defaultMaxAccountRiskPct ?? 0.5;
}

function optionalNumber(value) {
  return value === "" || value == null ? null : Number(value);
}

async function loadSettings() {
  loading.value = true;
  feedback.value = "";
  try {
    applySettings(await api.getDecisionExecutionSettings());
  } catch (error) {
    feedback.value = error?.message ?? "执行参数加载失败";
    feedbackTone.value = "danger";
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  feedback.value = "";
  try {
    const settings = await api.saveDecisionExecutionSettings({
      simulatedAccountEquity: optionalNumber(form.simulatedAccountEquity),
      liveAccountEquity: optionalNumber(form.liveAccountEquity),
      defaultMinRewardRiskRatio: Number(form.defaultMinRewardRiskRatio),
      defaultMaxAccountRiskPct: Number(form.defaultMaxAccountRiskPct),
    });
    applySettings(settings);
    feedback.value = "执行参数已保存；只影响之后签发的许可证。";
    feedbackTone.value = "success";
    emit("saved", settings);
  } catch (error) {
    feedback.value = error?.message ?? "执行参数保存失败";
    feedbackTone.value = "danger";
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void loadSettings();
    }
  },
);
</script>

<template>
  <UiDrawer
    :open="open"
    title="执行参数设置"
    description="设置账户本金和许可证纪律。历史许可证使用冻结快照，不受后续修改影响。"
    panel-class="trade-execution-settings__panel"
    @close="emit('close')"
  >
    <div class="trade-execution-settings">
      <UiAlert v-if="feedback" :variant="feedbackTone">{{ feedback }}</UiAlert>
      <div class="trade-execution-settings__grid">
        <label>
          <span>模拟账户本金</span>
          <UiInput v-model="form.simulatedAccountEquity" type="number" min="0" step="0.01" :disabled="loading" />
        </label>
        <label>
          <span>实盘账户本金</span>
          <UiInput v-model="form.liveAccountEquity" type="number" min="0" step="0.01" :disabled="loading" />
        </label>
        <label>
          <span>最低盈亏比</span>
          <UiInput v-model="form.defaultMinRewardRiskRatio" type="number" min="0.01" step="0.1" :disabled="loading" />
        </label>
        <label>
          <span>单笔最大账户风险%</span>
          <UiInput v-model="form.defaultMaxAccountRiskPct" type="number" min="0.01" step="0.1" :disabled="loading" />
        </label>
      </div>
      <p>每手固定为 100 股。账户本金未配置时，只能保存草稿。</p>
      <UiButton :loading="saving" :disabled="loading" @click="saveSettings">保存执行参数</UiButton>
    </div>
  </UiDrawer>
</template>

<style scoped>
.trade-execution-settings {
  display: grid;
  gap: 1rem;
}

.trade-execution-settings__grid {
  display: grid;
  gap: 0.875rem;
}

.trade-execution-settings__grid label {
  display: grid;
  gap: 0.375rem;
}

.trade-execution-settings__grid span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.trade-execution-settings p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
