<script setup>
import { computed, reactive, watch } from "vue";
import { Check, X } from "lucide-vue-next";

import {
  buildReplayOrderSubmission,
  REPLAY_BUY_REASON_TAG_OPTIONS,
  REPLAY_SELL_REASON_TAG_OPTIONS,
} from "../../utils/replayReviewPresentation.js";
import UiTooltip from "../ui/UiTooltip.vue";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { isReplayBarOrderModel, replayQuantityError } from "../../utils/replayOrderRules.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  side: { type: String, default: "buy" },
  sessionKey: { type: String, default: "" },
  resetToken: { type: Number, default: 0 },
  submitting: { type: Boolean, default: false },
  sessionInterval: { type: String, default: "1d" },
  stepMinutes: { type: Number, default: 1 },
  executionModelVersion: { type: String, default: "legacy-next-open" },
  tradingRules: { type: Object, default: null },
  positionQuantity: { type: Number, default: 0 },
  availableQuantity: { type: Number, default: 0 },
});

const emit = defineEmits(["close", "submit"]);

const form = reactive(createEmptyForm());
const quickRatios = [0.25, 0.5, 0.75, 1];
const isBuy = computed(() => props.side === "buy");
const advancedOrders = computed(() => isReplayBarOrderModel(props.executionModelVersion));
const quantityMessage = computed(() => replayQuantityError({ rules: props.tradingRules, side: props.side,
  quantity: Number(form.quantity), holding: props.positionQuantity, available: props.availableQuantity, orderType: form.orderType }));
const reasonTagOptions = computed(() =>
  isBuy.value ? REPLAY_BUY_REASON_TAG_OPTIONS : REPLAY_SELL_REASON_TAG_OPTIONS,
);
const sizingReady = computed(() =>
  form.orderType === "stop" || form.inputMode === "shares"
    ? form.orderType === "stop" || !quantityMessage.value
    : Number(form.ratio) > 0 && Number(form.ratio) <= 1,
);
const decisionReady = computed(() => {
  const commonReady =
    form.reasonTags.length >= 1 &&
    form.reasonTags.length <= 8 &&
    Number(form.confidence) >= 1 &&
    Number(form.confidence) <= 5 &&
    form.thesis.trim().length >= 5 &&
    form.plan.trim().length >= 5;
  if (!commonReady) return false;
  if (isBuy.value) {
    const invalidationReady =
      form.invalidationEnabled && Number(form.invalidationThreshold) > 0;
    return form.riskPlan.trim().length >= 5 &&
      (Number(form.stopLossPrice) > 0 || invalidationReady);
  }
  return Boolean(form.exitType) && form.remainingPositionPlan.trim().length >= 2;
});
const canSubmit = computed(() =>
  !props.submitting && sizingReady.value && decisionReady.value &&
    (form.orderType !== "limit" || Number(form.limitPrice) > 0) &&
    (form.orderType !== "stop" || Number(form.protectionPrice) > 0),
);

function createEmptyForm() {
  return {
    inputMode: "shares",
    quantity: props.side === "sell" && props.tradingRules && props.positionQuantity < props.tradingRules.minimumSell
      ? props.positionQuantity : props.tradingRules?.minimumBuy ?? 100,
    ratio: 0.25,
    orderType: "market",
    limitPrice: "",
    protectionPrice: "",
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
  emit("submit", buildReplayOrderSubmission({ side: props.side, ...form, orderType: advancedOrders.value ? form.orderType : undefined }));
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
const orderHelp = computed(() => {
  const timing = props.sessionInterval==='hybrid'?`下一${props.stepMinutes}分钟开盘尝试成交。`:props.sessionInterval==='1m'?'下一分钟开盘尝试成交。':'下一交易日开盘尝试成交。';
  const type = !advancedOrders.value ? '' : form.orderType==='stop'?'保护当前持仓，触发后持续退出；受T+1与成交量限制，可撤销。':form.orderType==='limit'?'限价余量当日有效，允许部分成交。':'未成交余量当日继续等待。';
  const quantity = props.tradingRules ? props.tradingRules.board==='star'?'200股起，超出可逐股递增；不足200股的卖出余额须一次性处理。':'买入100股整数倍；卖出零股余额须一次性处理。' : '';
  return `${timing}${type}${quantity} 成交量按K线近似，不模拟盘口排队。`;
});
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
          <span>01</span><div><h3>委托规模<UiTooltip clickable wide label="委托规模说明" :content="orderHelp" /></h3></div>
        </div>
        <div v-if="advancedOrders" class="replay-order-decision__risk-grid">
          <label><span>委托类型</span><UiSelect v-model="form.orderType" aria-label="委托类型">
            <option value="market">下一开盘买卖</option><option value="limit">限价 · 当日有效</option>
            <option v-if="!isBuy" value="stop">持仓止损 · 持续保护</option>
          </UiSelect></label>
          <label v-if="form.orderType === 'limit'"><span>{{ isBuy ? '最高买价' : '最低卖价' }}</span>
            <UiInput v-model="form.limitPrice" aria-label="委托限价" type="number" min="0.01" step="0.01" /></label>
          <label v-if="form.orderType === 'stop'"><span>止损触发价</span>
            <UiInput v-model="form.protectionPrice" aria-label="止损触发价" type="number" min="0.01" step="0.01" /></label>
        </div>
        <div v-if="form.orderType !== 'stop'" class="replay-order-decision__sizing">
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
              :min="isBuy ? tradingRules?.minimumBuy ?? 100 : tradingRules ? 1 : 100"
              :step="isBuy ? tradingRules?.quantityStep ?? 100 : tradingRules ? 1 : 100"
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
          <p v-if="form.inputMode === 'shares' && quantityMessage" role="status" class="replay-order-decision__invalidation-help">{{ quantityMessage }}</p>
        </div>
      </section>

      <section class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>02</span><div><h3>{{ isBuy ? '为什么买' : '为什么卖' }}<UiTooltip clickable label="判断记录说明" content="收起保留草稿；成交后不能覆盖当时判断。" /></h3></div>
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
          <small>{{ form.thesis.trim().length }} / 2000，至少 5 字</small>
        </label>
        <label>
          <span>{{ isBuy ? '开仓与持有计划' : '本次卖出计划' }}</span>
          <UiTextarea v-model="form.plan" maxlength="2000" :placeholder="isBuy ? '计划如何开仓、加仓、持有？' : '计划卖出多少，什么价格条件下执行？'" />
          <small>{{ form.plan.trim().length }} / 2000，至少 5 字</small>
        </label>
      </section>

      <section v-if="isBuy" class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>03</span><div><h3>风险边界<UiTooltip clickable wide label="风险边界说明" :content="advancedOrders?'止损价成交后建立持仓保护，触发后持续退出；收盘失效条件只记录和提醒，不自动卖出。':'收盘失效条件只记录和提醒，不自动卖出。'" /></h3></div>
        </div>
        <label>
          <span>风险计划</span>
          <UiTextarea v-model="form.riskPlan" maxlength="1000" placeholder="什么情况说明判断错误，如何控制损失？" />
          <small>{{ form.riskPlan.trim().length }} / 1000，至少 5 字</small>
        </label>
        <div class="replay-order-decision__risk-grid">
          <label><span>止损价 / 失效条件（至少一项）</span><UiInput v-model="form.stopLossPrice" aria-label="止损价" type="number" min="0" step="0.01" /></label>
          <label class="replay-order-decision__toggle"><input v-model="form.invalidationEnabled" type="checkbox" /><span>记录收盘确认的失效条件</span></label>
        </div>
        <div v-if="form.invalidationEnabled" class="replay-order-decision__invalidation">
          <UiSelect v-model="form.invalidationOperator"><option value="lte">收盘价 ≤</option><option value="gte">收盘价 ≥</option></UiSelect>
          <UiInput v-model="form.invalidationThreshold" type="number" min="0" step="0.01" placeholder="价格" />
          <UiInput v-model="form.invalidationNote" maxlength="300" placeholder="可选说明" />
        </div>
      </section>

      <section v-else class="replay-order-decision__section">
        <div class="replay-order-decision__heading">
          <span>03</span><div><h3>退出处理<UiTooltip clickable label="退出处理说明" content="选择卖出类型，并记录剩余仓位计划。" /></h3></div>
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
.replay-order-decision__heading h3 { display:flex;align-items:center;gap:6px;font-size:14px; }
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
