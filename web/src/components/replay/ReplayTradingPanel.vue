<script setup>
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Eye,
  Flag,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
} from "lucide-vue-next";
import { computed, shallowRef, watch } from "vue";

import UiButton from "../ui/UiButton.vue";
import { REPLAY_AUTOPLAY_SPEEDS } from "../../utils/replayAutoplay.js";
import { getReplayReviewEntryState } from "../../utils/replayReviewPresentation.js";
import ReplayOrderDecisionSnapshot from "./ReplayOrderDecisionSnapshot.vue";

const props = defineProps({
  session: {
    type: Object,
    required: true,
  },
  submitting: {
    type: Boolean,
    default: false,
  },
  advancing: {
    type: Boolean,
    default: false,
  },
  finishing: {
    type: Boolean,
    default: false,
  },
  revealing: {
    type: Boolean,
    default: false,
  },
  autoplayPlaying: {
    type: Boolean,
    default: false,
  },
  autoplaySpeed: {
    type: String,
    default: "normal",
  },
  autoplayMessage: {
    type: String,
    default: "",
  },
});

const emit = defineEmits([
  "openOrder",
  "openReview",
  "advance",
  "finish",
  "skip",
  "reveal",
  "toggleAutoplay",
  "changeAutoplaySpeed",
]);

const finishConfirming = shallowRef(false);
const skipConfirming = shallowRef(false);

const completed = computed(() => props.session.status === "completed");
const busy = computed(
  () =>
    props.submitting ||
    props.advancing ||
    props.finishing ||
    props.revealing,
);
const pendingOrders = computed(() => props.session.pendingOrders ?? []);
const canReveal = computed(
  () => completed.value && Boolean(props.session.review?.blindSaved),
);
const recentExecutions = computed(() =>
  [...(props.session.executions ?? [])].reverse().slice(0, 5),
);
const hasPosition = computed(
  () => Number(props.session.account?.positionQuantity ?? 0) > 0,
);
const canSkip = computed(
  () =>
    !hasPosition.value &&
    pendingOrders.value.length === 0 &&
    (props.session.executions ?? []).length === 0,
);
const reviewEntry = computed(() => getReplayReviewEntryState(props.session));
const isMinuteReplay = computed(() => props.session.interval === "1m");
const isHybridReplay = computed(() => props.session.interval === "hybrid");
const stepMinutes = computed(() => Number(props.session.stepMinutes ?? 1));
const stepLabel = computed(() => `${stepMinutes.value}分钟`);
const hybridAdvanceLabel = computed(() =>
  stepMinutes.value === 5 ? "推进 5 分钟" : `推进 ${stepMinutes.value} 分钟`,
);
const sequenceUnit = computed(() =>
  isHybridReplay.value ? stepLabel.value : isMinuteReplay.value ? "分钟" : "日",
);

const advanceLabel = computed(() => {
  if (completed.value) {
    return "本局演练已完成";
  }
  if (pendingOrders.value.length) {
    return `执行 ${pendingOrders.value.length} 笔委托并推进`;
  }
  if (isMinuteReplay.value) {
    return hasPosition.value ? "持仓不动，推进一分钟" : "空仓观望，推进一分钟";
  }
  return hasPosition.value ? "持仓不动，推进一天" : "空仓观望，推进一天";
});


function requestFinish() {
  if (busy.value || completed.value) {
    return;
  }
  finishConfirming.value = true;
}

function confirmFinish() {
  if (busy.value || completed.value) {
    return;
  }
  finishConfirming.value = false;
  emit("finish");
}

function requestSkip() {
  if (busy.value || completed.value || !canSkip.value) {
    return;
  }
  skipConfirming.value = true;
}

function confirmSkip() {
  if (busy.value || completed.value || !canSkip.value) {
    return;
  }
  skipConfirming.value = false;
  emit("skip");
}

function reveal() {
  if (busy.value || !canReveal.value || props.session.revealed) {
    return;
  }
  emit("reveal");
}

function formatMoney(value) {
  return Number(value ?? 0).toFixed(2);
}

watch(completed, () => {
  finishConfirming.value = false;
  skipConfirming.value = false;
});

watch(
  () => props.session.id,
  () => {
    finishConfirming.value = false;
    skipConfirming.value = false;
  },
);
</script>

<template>
  <aside class="replay-trading">
    <header class="replay-trading__header">
      <div>
        <h2 class="replay-trading__title">交易台</h2>
        <p class="replay-trading__subtitle">
          {{ isHybridReplay ? `盘中决策 · 下一个${stepLabel}开盘执行` : isMinuteReplay ? "盘中决策 · 下一分钟开盘执行" : "收盘后决策 · 下一开盘执行" }}
        </p>
      </div>
      <span class="replay-trading__revision">REV {{ session.revision }}</span>
    </header>

    <div class="replay-trading__body">
      <div class="replay-trading__sides">
        <button
          type="button"
          class="replay-trading__side replay-trading__side--buy"
          :disabled="busy || completed"
          @click="emit('openOrder', 'buy')"
        >
          <Plus :size="15" />
          买入
        </button>
        <button
          type="button"
          class="replay-trading__side replay-trading__side--sell"
          :disabled="busy || completed || !hasPosition"
          @click="emit('openOrder', 'sell')"
        >
          <Minus :size="15" />
          卖出
        </button>
      </div>
      <p class="replay-trading__decision-hint">每次买入或卖出都会先填写独立决策记录，再提交下一开盘委托。</p>

      <section v-if="pendingOrders.length" class="replay-trading__pending">
        <div class="replay-trading__section-title">
          <Clock3 :size="14" />
          待处理委托
        </div>
        <div
          v-for="order in pendingOrders"
          :key="order.orderId"
          class="replay-trading__pending-row"
        >
          <span :class="`replay-trading__tag--${order.side}`">
            {{ order.side === "buy" ? "买" : "卖" }}
          </span>
          <strong>
            {{
              order.quantityType === "shares"
                ? `${order.requestedQuantity} 股`
                : `${Number(order.ratio) * 100}%`
            }}
          </strong>
          <span>第 {{ order.scheduledSequence }} {{ sequenceUnit }}开盘</span>
          <ReplayOrderDecisionSnapshot :decision="order.decision" :side="order.side" />
        </div>
      </section>

      <section class="replay-trading__advance">
        <div v-if="isHybridReplay" class="replay-trading__advance-actions">
          <UiButton
            variant="secondary"
            :loading="advancing"
            :disabled="busy || completed || autoplayPlaying"
            @click="emit('advance', 'minute')"
          >
            {{ hybridAdvanceLabel }}
          </UiButton>
          <UiButton
            variant="secondary"
            :loading="advancing"
            :disabled="busy || completed || autoplayPlaying"
            @click="emit('advance', 'day')"
          >
            推进 1 天
          </UiButton>
        </div>
        <UiButton
          v-else
          block
          variant="secondary"
          :loading="advancing"
          :disabled="busy || completed || autoplayPlaying"
          @click="emit('advance', isMinuteReplay ? 'minute' : 'day')"
        >
          <template #prefix>
            <ArrowRight v-if="!completed" :size="16" />
            <RotateCcw v-else :size="16" />
          </template>
          {{ advanceLabel }}
        </UiButton>
        <div class="replay-trading__autoplay">
          <div
            class="replay-trading__speed"
            aria-label="自动播放速度"
          >
            <button
              v-for="option in REPLAY_AUTOPLAY_SPEEDS"
              :key="option.value"
              type="button"
              :class="{
                'replay-trading__speed--active':
                  autoplaySpeed === option.value,
              }"
              :disabled="busy || completed"
              @click="emit('changeAutoplaySpeed', option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <UiButton
            type="button"
            size="sm"
            :variant="autoplayPlaying ? 'secondary' : 'primary'"
            :disabled="busy || completed"
            @click="emit('toggleAutoplay')"
          >
            <template #prefix>
              <Pause v-if="autoplayPlaying" :size="14" />
              <Play v-else :size="14" />
            </template>
            {{ autoplayPlaying ? "暂停" : "自动播放" }}
          </UiButton>
        </div>
        <p
          v-if="autoplayMessage"
          class="replay-trading__autoplay-message"
          :class="{
            'replay-trading__autoplay-message--playing': autoplayPlaying,
          }"
          role="status"
        >
          {{ autoplayMessage }}
        </p>
        <p>快捷键：空格或 →</p>
      </section>

      <section class="replay-trading__completion">
        <template v-if="!completed">
          <UiButton
            v-if="canSkip"
            block
            variant="secondary"
            :disabled="busy"
            @click="requestSkip"
          >
            <template #prefix>
              <RotateCcw :size="15" />
            </template>
            本局无交易机会，结束并换一局
          </UiButton>
          <div
            v-if="skipConfirming"
            class="replay-trading__skip-confirm"
            role="alert"
          >
            <strong>确认主动空仓并换一局？</strong>
            <p>本局会永久记录为“无交易机会”，随后按当前配置重新抽取行情。</p>
            <div>
              <UiButton
                size="sm"
                variant="secondary"
                :disabled="finishing"
                @click="skipConfirming = false"
              >
                继续观察
              </UiButton>
              <UiButton
                size="sm"
                :loading="finishing"
                @click="confirmSkip"
              >
                确认换一局
              </UiButton>
            </div>
          </div>
          <UiButton
            block
            variant="ghost"
            :disabled="busy"
            @click="requestFinish"
          >
            <template #prefix>
              <Flag :size="15" />
            </template>
            提前交卷
          </UiButton>
          <div
            v-if="finishConfirming"
            class="replay-trading__finish-confirm"
            role="alert"
          >
            <strong>确认提前交卷？</strong>
            <p>
              将保留当前持仓，并取消
              {{ pendingOrders.length }} 笔未执行委托。交卷后不能继续交易。
            </p>
            <div>
              <UiButton
                size="sm"
                variant="secondary"
                :disabled="finishing"
                @click="finishConfirming = false"
              >
                继续演练
              </UiButton>
              <UiButton
                size="sm"
                variant="danger"
                :loading="finishing"
                @click="confirmFinish"
              >
                确认交卷
              </UiButton>
            </div>
          </div>
        </template>
        <template v-else-if="!session.revealed">
          <p>
            {{
              canReveal
                ? "盲评已保存，可以揭晓真实行情。"
                : session.completionReason === "no_opportunity"
                  ? "本局已记录为无交易机会。"
                  : session.completionReason === "early"
                    ? "本局已提前交卷，答案仍保持隐藏。"
                    : "本局已自然完成，答案仍保持隐藏。"
            }}
          </p>
          <p v-if="!canReveal">请先保存盲评，再揭晓答案。</p>
          <UiButton v-if="!canReveal" block variant="secondary" @click="emit('openReview')">
            填写揭晓前盲评
          </UiButton>
          <UiButton
            block
            :loading="revealing"
            :disabled="busy || !canReveal"
            @click="reveal"
          >
            <template #prefix>
              <Eye :size="16" />
            </template>
            揭晓答案
          </UiButton>
        </template>
        <template v-else>
          <div class="replay-trading__revealed">
            <CheckCircle2 :size="16" />
            答案已揭晓，可查看完整行情
          </div>
          <UiButton
            v-if="reviewEntry.available"
            block
            variant="secondary"
            @click="emit('openReview')"
          >
            <template #prefix>
              <ClipboardCheck :size="15" />
            </template>
            {{ reviewEntry.label }}
          </UiButton>
        </template>
      </section>

      <section class="replay-trading__history">
        <div class="replay-trading__section-title">最近执行</div>
        <div v-if="!recentExecutions.length" class="replay-trading__empty">
          暂无成交或拒绝记录
        </div>
        <div
          v-for="execution in recentExecutions"
          :key="execution.orderId"
          class="replay-trading__execution"
        >
          <div>
            <span :class="`replay-trading__tag--${execution.side}`">
              {{ execution.side === "buy" ? "买" : "卖" }}
            </span>
            <strong>第 {{ execution.sequence }} {{ sequenceUnit }}</strong>
          </div>
          <template v-if="execution.status === 'filled'">
            <span>
              {{ execution.quantity }} 股 · ¥{{ formatMoney(execution.price) }}
            </span>
            <small>费用 ¥{{ formatMoney(execution.totalFee) }}</small>
          </template>
          <template v-else>
            <span class="replay-trading__rejected">
              {{ execution.status === "cancelled" ? "已取消" : "未成交" }}
            </span>
            <small>{{ execution.reasonMessage }}</small>
          </template>
          <ReplayOrderDecisionSnapshot :decision="execution.decision" :side="execution.side" />
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.replay-trading {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 12px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-xs);
}

.replay-trading__header {
  display: flex;
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ql-line);
}

.replay-trading__title {
  margin: 0;
  font-size: 15px;
}

.replay-trading__subtitle {
  margin: 3px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 11px;
}

.replay-trading__revision {
  color: var(--ql-color-text-subtle);
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
}

.replay-trading__body {
  display: grid;
  gap: 16px;
  padding: 16px;
}

.replay-trading__sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.replay-trading__side {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  background: var(--ql-paper-soft);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.replay-trading__side--buy {
  border-color: rgba(239, 68, 68, 0.35);
  color: #dc2626;
  background: rgba(239, 68, 68, 0.08);
}

.replay-trading__side--sell {
  border-color: rgba(16, 185, 129, 0.35);
  color: #047857;
  background: rgba(16, 185, 129, 0.08);
}

.replay-trading__side:disabled {
  cursor: not-allowed;
  filter: grayscale(0.7);
  opacity: 0.45;
}

.replay-trading__decision-hint {
  margin: -6px 0 0;
  color: var(--ql-color-text-subtle);
  font-size: 10px;
  line-height: 1.6;
}

.replay-trading__pending-row :deep(.replay-order-snapshot),
.replay-trading__execution :deep(.replay-order-snapshot) {
  grid-column: 1 / -1;
  width: 100%;
}

.replay-trading__form {
  display: grid;
  gap: 10px;
}

.replay-trading__mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.replay-trading__label,
.replay-trading__section-title {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.replay-trading__mode-switch {
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--ql-paper-soft);
}

.replay-trading__mode-switch button {
  min-width: 42px;
  min-height: 28px;
  border: 0;
  border-radius: 5px;
  color: var(--ql-color-text-muted);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}

.replay-trading__mode-switch .replay-trading__mode--active {
  color: var(--ql-ink);
  background: var(--ql-color-bg-surface-strong);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

.replay-trading__field {
  position: relative;
}

.replay-trading__field span {
  position: absolute;
  top: 50%;
  right: 13px;
  color: var(--ql-color-text-muted);
  font-size: 12px;
  transform: translateY(-50%);
}

.replay-trading__field :deep(input) {
  padding-right: 42px;
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-weight: 700;
}

.replay-trading__ratios {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.replay-trading__ratios button {
  min-height: 32px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 6px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}

.replay-trading__ratios .replay-trading__ratio--active {
  border-color: var(--ql-accent);
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
}

.replay-trading__hint,
.replay-trading__advance p {
  margin: 0;
  color: var(--ql-color-text-subtle);
  font-size: 10px;
  line-height: 1.55;
}

.replay-trading__submit--sell {
  border-color: #059669;
  background: #059669;
}

.replay-trading__submit--sell:hover,
.replay-trading__submit--sell:focus-visible {
  border-color: #047857;
  background: #047857;
}

.replay-trading__pending,
.replay-trading__history {
  display: grid;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--ql-line);
}

.replay-trading__section-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.replay-trading__pending-row,
.replay-trading__execution {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--ql-paper-soft);
  font-size: 11px;
}

.replay-trading__pending-row > span:last-child {
  overflow: hidden;
  color: var(--ql-color-text-muted);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-trading__tag--buy,
.replay-trading__tag--sell {
  display: inline-grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 800;
}

.replay-trading__tag--buy {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.1);
}

.replay-trading__tag--sell {
  color: #047857;
  background: rgba(16, 185, 129, 0.1);
}

.replay-trading__advance {
  display: grid;
  gap: 6px;
}

.replay-trading__advance-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.replay-trading__autoplay {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.replay-trading__speed {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 3px;
  border: 1px solid var(--ql-line);
  border-radius: 8px;
  background: var(--ql-paper-soft);
}

.replay-trading__speed button {
  min-width: 0;
  min-height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  color: var(--ql-color-text-muted);
  background: transparent;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.replay-trading__speed button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.replay-trading__speed .replay-trading__speed--active {
  color: var(--ql-accent);
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-xs);
}

.replay-trading__autoplay-message {
  padding: 7px 8px;
  border-radius: 6px;
  color: #b45309 !important;
  background: var(--ql-color-warning-soft);
  overflow-wrap: anywhere;
  text-align: left !important;
}

.replay-trading__autoplay-message--playing {
  color: #047857 !important;
  background: var(--ql-color-success-soft);
}

.replay-trading__completion {
  display: grid;
  gap: 9px;
  padding-top: 14px;
  border-top: 1px solid var(--ql-line);
}

.replay-trading__completion > p,
.replay-trading__finish-confirm p,
.replay-trading__skip-confirm p {
  margin: 0;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.replay-trading__finish-confirm {
  display: grid;
  gap: 8px;
  padding: 11px;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  background: var(--ql-color-danger-soft);
  font-size: 12px;
}

.replay-trading__skip-confirm {
  display: grid;
  gap: 8px;
  padding: 11px;
  border: 1px solid rgba(37, 99, 235, 0.2);
  border-radius: 8px;
  background: var(--ql-color-primary-soft);
  font-size: 12px;
}

.replay-trading__finish-confirm > div,
.replay-trading__skip-confirm > div {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.replay-trading__revealed {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 11px;
  border-radius: 8px;
  color: #047857;
  background: var(--ql-color-success-soft);
  font-size: 11px;
  font-weight: 700;
}

.replay-trading__advance p {
  text-align: center;
}

.replay-trading__empty {
  padding: 12px;
  color: var(--ql-color-text-subtle);
  background: var(--ql-paper-soft);
  font-size: 11px;
  text-align: center;
}

.replay-trading__execution {
  grid-template-columns: 1fr auto;
}

.replay-trading__execution > div {
  display: flex;
  align-items: center;
  gap: 7px;
}

.replay-trading__execution > span {
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
}

.replay-trading__execution small {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--ql-color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-trading__rejected {
  color: var(--ql-color-warning);
  font-weight: 700;
}
</style>
