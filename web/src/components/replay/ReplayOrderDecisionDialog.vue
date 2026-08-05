<script setup>
import { computed, reactive, watch } from "vue";
import { Check, X } from "lucide-vue-next";

import {
  buildReplayOrderSubmission,
  REPLAY_BUY_REASON_TAG_OPTIONS,
  REPLAY_SELL_REASON_TAG_OPTIONS,
} from "../../utils/replayReviewPresentation.js";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextarea from "../ui/UiTextarea.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  side: { type: String, default: "buy" },
  sessionKey: { type: String, default: "" },
  resetToken: { type: Number, default: 0 },
  submitting: { type: Boolean, default: false },
  sessionInterval: { type: String, default: "1d" },
  stepMinutes: { type: Number, default: 1 },
});

const emit = defineEmits(["close", "submit"]);

const form = reactive(createEmptyForm());
const quickRatios = [0.25, 0.5, 0.75, 1];
const isBuy = computed(() => props.side === "buy");
const reasonTagOptions = computed(() =>
  isBuy.value ? REPLAY_BUY_REASON_TAG_OPTIONS : REPLAY_SELL_REASON_TAG_OPTIONS,
);
const sizingReady = computed(() =>
  form.inputMode === "shares"
    ? Number.isSafeInteger(Number(form.quantity)) && Number(form.quantity) >= 100
    : Number(form.ratio) > 0 && Number(form.ratio) <= 1,
);
const decisionReady = computed(() => {
  const commonReady =
    form.reasonTags.length >= 1 &&
    form.reasonTags.length <= 8 &&
    Number(form.confidence) >= 1 &&
    Number(form.confidence) <= 5 &&
    form.thesis.trim().length >= 10 &&
    form.plan.trim().length >= 10;
  if (!commonReady) return false;
  if (isBuy.value) {
    const invalidationReady =
      form.invalidationEnabled && Number(form.invalidationThreshold) > 0;
    return form.riskPlan.trim().length >= 10 &&
      (Number(form.stopLossPrice) > 0 || invalidationReady);
  }
  return Boolean(form.exitType) && form.remainingPositionPlan.trim().length >= 2;
});
const canSubmit = computed(() =>
  !props.submitting && sizingReady.value && decisionReady.value,
);

function createEmptyForm() {
  return {
    inputMode: "shares",
    quantity: 100,
    ratio: 0.25,
    reasonTags: [],
    confidence: 3,
    thesis: "",
    plan: "",
    riskPlan: "",
    stopLossPrice: "",
    invalidationEnabled: false,
    invalidationOperator: "lte",
    invalidationThreshold: "",
    invalidationNote: "",
    exitType: "",
    remainingPositionPlan: "",
  };
}

function selectRatio(value) {
  form.inputMode = "ratio";
  form.ratio = value;
}

function submit() {
  if (!canSubmit.value) return;
  emit("submit", buildReplayOrderSubmission({ side: props.side, ...form }));
}

watch(
  () => [props.sessionKey, props.resetToken, props.side],
  ([sessionKey, resetToken], [previousSessionKey, previousResetToken, previousSide]) => {
    if (
      sessionKey !== previousSessionKey ||
      resetToken !== previousResetToken ||
      props.side !== previousSide
    ) {
      Object.assign(form, createEmptyForm());
    }
  },
);
</script>

<template>
  <Transition name="replay-order-drawer">
      <aside
        v-if="open"
        class="replay-order-dialog"
        role="dialog"
        aria-modal="false"
        :aria-label="isBuy ? '买入决策记录' : '卖出决策记录'"
      >
        <header class="replay-order-dialog__header">
          <div>
            <h2>{{ isBuy ? '买入决策记录' : '卖出决策记录' }}</h2>
            <p>填写时可继续查看左侧行情；关闭后，本次未提交草稿仍会保留。</p>
          </div>
          <button
            type="button"
            aria-label="关闭决策面板"
            :disabled="submitting"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
        </header>
        <div class="replay-order-dialog__body">
          <form class="replay-order-decision" @submit.prevent="submit">
      <section class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>01</span><div><h3>委托规模</h3><p>{{ sessionInterval === "hybrid" ? `当前盘中决策，下一个${stepMinutes}分钟开盘尝试执行。` : sessionInterval === "1m" ? "当前分钟决策，下一分钟开盘尝试执行。" : "收盘后决策，下一交易日开盘尝试执行。" }}</p></div>
        </div>
        <div class="replay-order-decision__sizing">
          <div class="replay-order-decision__mode">
            <button
              type="button"
              :class="{ active: form.inputMode === 'shares' }"
              :aria-pressed="form.inputMode === 'shares'"
              @click="form.inputMode = 'shares'"
            >
              股数
            </button>
            <button
              type="button"
              :class="{ active: form.inputMode === 'ratio' }"
              :aria-pressed="form.inputMode === 'ratio'"
              @click="form.inputMode = 'ratio'"
            >
              比例
            </button>
          </div>
          <div v-if="form.inputMode === 'shares'" class="replay-order-decision__quantity">
            <UiInput
              v-model="form.quantity"
              aria-label="委托股数"
              type="number"
              min="100"
              step="100"
              inputmode="numeric"
            />
            <span aria-hidden="true">股</span>
          </div>
          <div v-else class="replay-order-decision__ratios" aria-label="仓位比例">
            <button
              v-for="value in quickRatios"
              :key="value"
              type="button"
              :class="{ active: form.inputMode === 'ratio' && form.ratio === value }"
              :aria-pressed="form.inputMode === 'ratio' && form.ratio === value"
              @click="selectRatio(value)"
            >
              {{ value * 100 }}%
            </button>
          </div>
        </div>
      </section>

      <section class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>02</span><div><h3>{{ isBuy ? '为什么买' : '为什么卖' }}</h3><p>记录当时依据，不允许成交后覆盖。</p></div>
        </div>
        <div class="replay-order-decision__evidence-heading">
          <span>判断理由（至少 1 项）</span>
          <label class="replay-order-decision__confidence">
            <span>判断信心</span>
            <input v-model.number="form.confidence" type="range" min="1" max="5" step="1" />
            <output>{{ form.confidence }} / 5</output>
          </label>
        </div>
        <fieldset class="replay-order-decision__tags" aria-label="判断理由">
          <label
            v-for="tag in reasonTagOptions"
            :key="tag"
            :class="{ active: form.reasonTags.includes(tag) }"
          >
            <input v-model="form.reasonTags" type="checkbox" :value="tag" />
            <span class="replay-order-decision__tag-check" aria-hidden="true">
              <Check v-if="form.reasonTags.includes(tag)" :size="11" />
            </span>
            <span>{{ tag }}</span>
          </label>
        </fieldset>
        <label>
          <span>核心判断</span>
          <UiTextarea v-model="form.thesis" maxlength="2000" :placeholder="isBuy ? '你看到了什么，为什么现在可以买入？' : '例如：收盘跌破 10.15，触发原定止损条件。'" />
          <small>{{ form.thesis.trim().length }} / 2000，至少 10 字</small>
        </label>
        <label>
          <span>{{ isBuy ? '开仓与持有计划' : '本次卖出计划' }}</span>
          <UiTextarea v-model="form.plan" maxlength="2000" :placeholder="isBuy ? '计划如何开仓、加仓、持有？' : '计划卖出多少，什么价格条件下执行？'" />
          <small>{{ form.plan.trim().length }} / 2000，至少 10 字</small>
        </label>
      </section>

      <section v-if="isBuy" class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>03</span><div><h3>风险边界</h3><p>止损价与判断失效条件至少填写一项。</p></div>
        </div>
        <label>
          <span>风险计划</span>
          <UiTextarea v-model="form.riskPlan" maxlength="1000" placeholder="什么情况说明判断错误，如何控制损失？" />
          <small>{{ form.riskPlan.trim().length }} / 1000，至少 10 字</small>
        </label>
        <div class="replay-order-decision__risk-grid">
          <label><span>止损价</span><UiInput v-model="form.stopLossPrice" type="number" min="0" step="0.01" /></label>
          <label class="replay-order-decision__toggle"><input v-model="form.invalidationEnabled" type="checkbox" /><span>记录收盘确认的失效条件</span></label>
        </div>
        <div v-if="form.invalidationEnabled" class="replay-order-decision__invalidation">
          <UiSelect v-model="form.invalidationOperator"><option value="lte">收盘价 ≤</option><option value="gte">收盘价 ≥</option></UiSelect>
          <UiInput v-model="form.invalidationThreshold" type="number" min="0" step="0.01" placeholder="价格" />
          <UiInput v-model="form.invalidationNote" maxlength="300" placeholder="可选说明" />
        </div>
        <p v-if="form.invalidationEnabled" class="replay-order-decision__invalidation-help">
          例如“收盘价 ≤ 10.15”表示只有当天收盘确认跌破才认定买入逻辑失效；这里只记录并用于复盘，不会自动卖出。
        </p>
      </section>

      <section v-else class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>03</span><div><h3>退出处理</h3><p>区分止盈、止损和主动调整，保留剩余仓位计划。</p></div>
        </div>
        <label class="replay-order-decision__compact">
          <span>卖出类型</span>
          <UiSelect v-model="form.exitType">
            <option value="">请选择</option><option value="take_profit">止盈</option><option value="stop_loss">止损</option>
            <option value="thesis_invalidated">逻辑失效</option><option value="reduce_risk">降低风险 / 减仓</option><option value="manual">主动退出</option>
          </UiSelect>
        </label>
        <label>
          <span>剩余仓位计划</span>
          <UiTextarea v-model="form.remainingPositionPlan" maxlength="1000" placeholder="清仓后如何观察，或剩余仓位如何处理？" />
        </label>
      </section>

      <footer class="replay-order-decision__actions">
        <span>未提交内容会保留到当前演练结束</span>
        <UiButton type="button" variant="secondary" :disabled="submitting" @click="emit('close')">暂时收起</UiButton>
        <UiButton type="submit" :variant="isBuy ? 'danger' : 'primary'" :loading="submitting" :disabled="!canSubmit">
          提交{{ isBuy ? '买入' : '卖出' }}委托
        </UiButton>
      </footer>
          </form>
        </div>
      </aside>
  </Transition>
</template>

<style scoped>
.replay-order-dialog {
  position: sticky;
  top: 16px;
  z-index: 5;
  display: flex;
  width: 100%;
  height: min(820px, calc(100vh - 86px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 14px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: 0 20px 56px rgba(15, 23, 42, 0.2);
}
.replay-order-dialog__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid var(--ql-line); }
.replay-order-dialog__header h2, .replay-order-dialog__header p { margin: 0; }
.replay-order-dialog__header h2 { color: var(--ql-ink); font-size: 17px; }
.replay-order-dialog__header p { margin-top: 4px; color: var(--ql-color-text-muted); font-size: 11px; line-height: 1.5; }
.replay-order-dialog__header button { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border: 1px solid var(--ql-line-strong); border-radius: 8px; color: var(--ql-color-text-muted); background: var(--ql-color-bg-surface-strong); cursor: pointer; }
.replay-order-dialog__header button:disabled { cursor: not-allowed; opacity: 0.5; }
.replay-order-dialog__body { min-height: 0; overflow: auto; padding: 18px; }
.replay-order-drawer-enter-active, .replay-order-drawer-leave-active { transition: opacity 160ms ease, transform 180ms ease; }
.replay-order-drawer-enter-from, .replay-order-drawer-leave-to { opacity: 0; transform: translateX(24px); }
.replay-order-decision { display: grid; gap: 20px; }
.replay-order-decision__section { display: grid; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--ql-line); }
.replay-order-decision__heading { display: flex; align-items: flex-start; gap: 10px; }
.replay-order-decision__heading > span { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 7px; color: var(--ql-accent); background: var(--ql-color-primary-soft); font-size: 10px; font-weight: 800; }
.replay-order-decision__heading h3, .replay-order-decision__heading p { margin: 0; }
.replay-order-decision__heading h3 { font-size: 14px; }
.replay-order-decision__heading p { margin-top: 3px; color: var(--ql-color-text-muted); font-size: 10px; }
.replay-order-decision label { display: grid; gap: 6px; color: var(--ql-color-text-muted); font-size: 11px; font-weight: 700; }
.replay-order-decision label small { font-size: 10px; font-weight: 400; text-align: right; }
.replay-order-decision__sizing { display: grid; grid-template-columns: 132px minmax(0, 1fr); align-items: center; gap: 10px; }
.replay-order-decision__mode, .replay-order-decision__ratios { display: grid; min-height: 44px; padding: 4px; border: 1px solid var(--ql-line); border-radius: 10px; background: var(--ql-paper-soft); }
.replay-order-decision__mode { grid-template-columns: repeat(2, 1fr); }
.replay-order-decision__ratios { grid-template-columns: repeat(4, 1fr); gap: 4px; }
.replay-order-decision__mode button, .replay-order-decision__ratios button { height: 34px; min-height: 34px; border: 1px solid transparent; border-radius: 7px; color: var(--ql-color-text-muted); background: transparent; font-size: 11px; font-weight: 720; cursor: pointer; transition: color 140ms ease, background 140ms ease, border-color 140ms ease, box-shadow 140ms ease; }
.replay-order-decision__mode button:hover, .replay-order-decision__ratios button:hover { color: var(--ql-accent); background: var(--ql-color-bg-glass); }
.replay-order-decision__mode .active { border-color: rgba(37, 99, 235, 0.18); color: var(--ql-accent); background: var(--ql-color-bg-surface-strong); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1); }
.replay-order-decision__ratios .active { border-color: var(--ql-accent); color: #fff; background: var(--ql-accent); box-shadow: 0 2px 6px rgba(37, 99, 235, 0.2); }
.replay-order-decision__quantity { position: relative; min-width: 0; }
.replay-order-decision__quantity :deep(input) { padding-right: 42px; }
.replay-order-decision__quantity > span { position: absolute; top: 50%; right: 14px; color: var(--ql-color-text-muted); font-size: 12px; font-weight: 700; transform: translateY(-50%); pointer-events: none; }
.replay-order-decision__evidence-heading { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 16px; color: var(--ql-color-text-muted); font-size: 11px; font-weight: 700; }
.replay-order-decision__confidence { display: flex !important; grid: none !important; flex: 0 0 auto; align-items: center; gap: 8px !important; }
.replay-order-decision__confidence input { width: 112px; accent-color: var(--ql-accent); cursor: pointer; }
.replay-order-decision__confidence output { min-width: 34px; color: var(--ql-ink); font-variant-numeric: tabular-nums; }
.replay-order-decision__tags { display: flex; flex-wrap: wrap; gap: 7px; margin: 0; padding: 0; border: 0; }
.replay-order-decision__tags label { display: inline-flex; min-height: 32px; grid: none; align-items: center; gap: 6px; padding: 0 11px; border: 1px solid var(--ql-line-strong); border-radius: 999px; color: var(--ql-color-text-muted); background: var(--ql-color-bg-surface-strong); cursor: pointer; transition: color 140ms ease, background 140ms ease, border-color 140ms ease, box-shadow 140ms ease; }
.replay-order-decision__tags label:hover { border-color: rgba(37, 99, 235, 0.35); color: var(--ql-accent); background: var(--ql-color-primary-soft); }
.replay-order-decision__tags label.active { border-color: rgba(37, 99, 235, 0.42); color: var(--ql-accent); background: var(--ql-color-primary-soft); box-shadow: 0 1px 3px rgba(37, 99, 235, 0.1); }
.replay-order-decision__tags input { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }
.replay-order-decision__tag-check { display: inline-grid; width: 14px; height: 14px; place-items: center; border: 1px solid var(--ql-line-strong); border-radius: 50%; background: var(--ql-color-bg-surface-strong); }
.replay-order-decision__tags label.active .replay-order-decision__tag-check { border-color: var(--ql-accent); color: #fff; background: var(--ql-accent); }
.replay-order-decision__compact { max-width: 220px; }
.replay-order-decision__risk-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: end; gap: 12px; }
.replay-order-decision__toggle { display: flex !important; min-height: 40px; grid: none !important; align-items: center; gap: 7px !important; }
.replay-order-decision__invalidation { display: grid; grid-template-columns: 140px 1fr 2fr; gap: 8px; }
.replay-order-decision__invalidation-help { margin: -4px 0 0; color: var(--ql-color-text-muted); font-size: 10px; line-height: 1.6; }
.replay-order-decision__actions { position: sticky; bottom: -18px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 -18px -18px; padding: 12px 18px; border-top: 1px solid var(--ql-line); background: var(--ql-color-bg-glass); }
.replay-order-decision__actions > span { margin-right: auto; color: var(--ql-color-text-muted); font-size: 10px; }
@media (max-width: 640px) {
  .replay-order-dialog { position: fixed; inset: 0; z-index: 90; width: 100vw; height: 100vh; border-radius: 0; }
  .replay-order-decision__sizing, .replay-order-decision__risk-grid, .replay-order-decision__invalidation { grid-template-columns: 1fr; }
  .replay-order-decision__evidence-heading { align-items: flex-start; flex-direction: column; gap: 8px; }
  .replay-order-decision__actions { flex-wrap: wrap; }
  .replay-order-decision__actions > span { width: 100%; }
}
</style>
