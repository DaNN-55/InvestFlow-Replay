<script setup>
import { AlertCircle, RefreshCw, Settings2, X } from "lucide-vue-next";
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  shallowRef,
} from "vue";

import { useRouter } from "vue-router";

import ReplayAccountSummary from "../components/replay/ReplayAccountSummary.vue";
import ReplayAttemptContext from "../components/replay/ReplayAttemptContext.vue";
import ReplayChartPanel from "../components/replay/ReplayChartPanel.vue";
import ReplayIntradayPanel from "../components/replay/ReplayIntradayPanel.vue";
import ReplayReviewPanel from "../components/replay/ReplayReviewPanel.vue";
import ReplayOrderDecisionDialog from "../components/replay/ReplayOrderDecisionDialog.vue";
import ReplaySetupPanel from "../components/replay/ReplaySetupPanel.vue";
import ReplayPlaybackControls from "../components/replay/ReplayPlaybackControls.vue";
import { REPLAY_AUTOPLAY_SPEEDS } from "../utils/replayAutoplay.js";
import { isReplayBarOrderModel } from "../utils/replayOrderRules.js";
import ReplayTradingPanel from "../components/replay/ReplayTradingPanel.vue";
import UiButton from "../components/ui/UiButton.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import UiDrawer from "../components/ui/UiDrawer.vue";
import { useReplayAttempt } from "../composables/useReplayAttempt.js";
import { api } from "../services/api.js";
import { moneyAmount } from "../utils/cryptoMoneyPresentation.js";

const {
  session,
  state: attemptState,
  messages,
  review,
  autoplay,
  commands,
} = useReplayAttempt();

const playbackSteps = computed(() => {
  const s = session.value;
  if (!s) return [];
  if (s.interval === 'hybrid') return [{value:'minute',label:`推进 ${s.stepMinutes ?? 1} 分钟`},{value:'day',label:'推进 1 天'}];
  const pending = s.pendingOrders?.length ?? 0;
  const label = s.status === 'completed' ? '本局演练已完成' : pending ? `${isReplayBarOrderModel(s.executionModelVersion)?'检查':'执行'} ${pending} 笔委托并推进` : `${s.account.positionQuantity>0?'持仓不动':'空仓观望'}，推进${s.interval==='1m'?'一分钟':'一天'}`;
  return [{value:s.interval==='1m'?'minute':'day',label}];
});
const router = useRouter();
const resumable = shallowRef(null);
const historyError = shallowRef("");
let historyRequestSequence = 0;
async function loadUnfinishedPractice() {
  const sequence = ++historyRequestSequence;
  historyError.value = "";
  try {
    const result = await api.listReplaySessions({ market: "ashare", state: "active", page: 1, pageSize: 1 });
    if (sequence !== historyRequestSequence) return;
    resumable.value = result.items?.find(item => item.status === "active" && item.market !== "crypto-perpetual") ?? null;
  } catch {
    if (sequence !== historyRequestSequence) return;
    resumable.value = null;
    historyError.value = "未完成练习暂未读取成功";
  }
}
function openPracticeRecords() {
  router.push({ path: "/decision/trade-records", query: { tab: "replay", market: "ashare" } });
}

const playbooks = shallowRef([]);
const playbooksLoading = shallowRef(false);
const playbooksError = shallowRef("");
let playbookRequestSequence = 0;
const benchmarks = shallowRef([]);
const benchmarksLoading = shallowRef(false);
const benchmarksError = shallowRef("");
const benchmarkInitialization = shallowRef(null);
const marketProvider = shallowRef("tdx");
const orderPanelOpen = shallowRef(false);
const orderPanelSide = shallowRef("buy");
const orderDraftResetToken = shallowRef(0);
const reviewDialogOpen = shallowRef(false);
const cancelRetrainOpen = shallowRef(false);
const finishConfirmOpen = shallowRef(false);
const settingsOpen = shallowRef(false);
const frozenCosts = computed(() => {
  const s = session.value, c = s?.costConfig ?? {};
  const percent = value => value == null ? '—' : `${(Number(value)*100).toLocaleString('en-US',{maximumFractionDigits:6})}%`;
  return [
    ['起始资金 · 元',moneyAmount(s?.account?.initialCapital),s?.account?.initialCapital],
    ['佣金率',percent(c.commissionRate),c.commissionRate],
    ['最低佣金 · 元',moneyAmount(c.minCommission),c.minCommission],
    ['卖出印花税率',percent(c.stampTaxRate),c.stampTaxRate],
    ['双向过户费率',percent(c.transferFeeRate),c.transferFeeRate],
    ['滑点 · bps',c.slippageBps ?? '—',c.slippageBps],
  ];
});
let benchmarkRequestSequence = 0;
let benchmarkPollTimer = null;

const intradayPreviousClose = computed(() => {
  if (session.value?.interval !== "hybrid") return 0;

  const dailyBars = Array.isArray(session.value?.bars) ? session.value.bars : [];
  const previousBar = session.value?.minuteBars?.length
    ? dailyBars.at(-2)
    : dailyBars.at(-1);
  return Number(previousBar?.close ?? 0);
});

async function loadReplayPlaybooks() {
  const sequence = ++playbookRequestSequence;
  playbooksLoading.value = true;
  playbooksError.value = "";
  try {
    const result = await api.listReplayPlaybooks();
    if (sequence !== playbookRequestSequence) {
      return;
    }
    playbooks.value = Array.isArray(result.items) ? result.items : [];
  } catch (error) {
    if (sequence !== playbookRequestSequence) {
      return;
    }
    playbooks.value = [];
    playbooksError.value = error?.message ?? "战法选项加载失败";
  } finally {
    if (sequence === playbookRequestSequence) {
      playbooksLoading.value = false;
    }
  }
}

async function loadReplayBenchmarks({ retry = false } = {}) {
  if (benchmarkPollTimer) {
    window.clearTimeout(benchmarkPollTimer);
    benchmarkPollTimer = null;
  }
  const sequence = ++benchmarkRequestSequence;
  benchmarksLoading.value = true;
  benchmarksError.value = "";
  try {
    const result = await api.listReplayBenchmarks({ retry });
    if (sequence !== benchmarkRequestSequence) {
      return;
    }
    benchmarks.value = Array.isArray(result.items) ? result.items : [];
    benchmarkInitialization.value = result.initialization ?? null;
    marketProvider.value =
      result.provider ?? result.initialization?.provider ?? "tdx";
    if (result.initialization?.state === "failed") {
      benchmarksError.value =
        result.initialization.error || "通达信行情缓存初始化失败";
      return;
    }
    if (result.initialization?.state === "running") {
      benchmarksLoading.value = benchmarks.value.length === 0;
      benchmarkPollTimer = window.setTimeout(loadReplayBenchmarks, 1000);
    }
  } catch (error) {
    if (sequence !== benchmarkRequestSequence) {
      return;
    }
    benchmarks.value = [];
    benchmarkInitialization.value = null;
    benchmarksError.value = error?.message ?? "指数基准加载失败";
  } finally {
    if (
      sequence === benchmarkRequestSequence &&
      benchmarkInitialization.value?.state !== "running"
    ) {
      benchmarksLoading.value = false;
    }
  }
}

function retryReplayBenchmarks() {
  return loadReplayBenchmarks({ retry: true });
}

function stopBenchmarkPolling() {
  if (benchmarkPollTimer) {
    window.clearTimeout(benchmarkPollTimer);
    benchmarkPollTimer = null;
  }
}

function shouldIgnoreShortcut(event) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
  );
}

function handleShortcut(event) {
  if (
    shouldIgnoreShortcut(event) ||
    finishConfirmOpen.value ||
    !attemptState.value.hasSession ||
    attemptState.value.isBusy ||
    attemptState.value.isCompleted ||
    !["Space", "ArrowRight"].includes(event.code)
  ) {
    return;
  }
  event.preventDefault();
  commands.advance();
}

function openOrderDialog(side) {
  orderPanelSide.value = side;
  orderPanelOpen.value = true;
}

async function handleSubmitOrder(order) {
  const updated = await commands.submitOrder(order);
  if (updated) {
    orderPanelOpen.value = false;
    orderDraftResetToken.value += 1;
  }
}

function handleStartNewSession() {
  orderPanelOpen.value = false;
  orderDraftResetToken.value += 1;
  commands.startNew();
  loadUnfinishedPractice();
}

function handleManualAdvance(mode = "minute") {
  commands.advance(mode);
}

function requestFinish() {
  if (attemptState.value.isBusy || session.value?.status === 'completed') return;
  if (autoplay.value.playing) commands.toggleAutoplay();
  finishConfirmOpen.value = true;
}
async function handleFinish() {
  const finished = await commands.finish();
  if (finished) finishConfirmOpen.value = false;
}

async function cancelRetrain() {
  const restored = await commands.cancelRetrain();
  if (restored) {
    cancelRetrainOpen.value = false;
  }
}

function handleReviewDraftChange({ stage, draft }) {
  commands.queueReviewDraft(stage, draft);
}

const handleSaveBlind = commands.saveBlindReview;
const handleSavePost = commands.savePostReview;

function attachShortcut() {
  window.removeEventListener("keydown", handleShortcut);
  window.addEventListener("keydown", handleShortcut);
}

function detachShortcut() {
  window.removeEventListener("keydown", handleShortcut);
}

onMounted(attachShortcut);
onActivated(attachShortcut);
onActivated(loadReplayPlaybooks);
onActivated(loadReplayBenchmarks);
onActivated(commands.sync);
onActivated(loadUnfinishedPractice);
onDeactivated(() => {
  detachShortcut();
  stopBenchmarkPolling();
});
onBeforeUnmount(() => {
  detachShortcut();
  stopBenchmarkPolling();
});
</script>

<template>
  <div class="market-replay">
    <div v-if="attemptState.activity === 'restoring'" class="market-replay__loading">
      <RefreshCw :size="18" class="market-replay__spinner" />
      正在恢复上次行情演练…
    </div>

    <template v-else>
      <div
        v-if="messages.primary"
        class="market-replay__message"
        :class="{ 'market-replay__message--error': messages.error }"
        role="status"
      >
        <AlertCircle :size="15" />
        <span>{{ messages.primary }}</span>
        <button type="button" aria-label="关闭提示" @click="commands.clearMessages">
          <X :size="14" />
        </button>
      </div>

      <ReplaySetupPanel
        v-if="!attemptState.hasSession"
        :loading="attemptState.activity === 'creating'"
        :benchmarks="benchmarks"
        :benchmarks-loading="benchmarksLoading"
        :benchmarks-error="benchmarksError"
        :benchmark-initialization="benchmarkInitialization"
        :market-provider="marketProvider"
        :resumable="resumable"
        :history-error="historyError"
        @create="commands.create"
        @retry-benchmarks="retryReplayBenchmarks"
        @resume="commands.resume"
        @records="openPracticeRecords"
        @retry-history="loadUnfinishedPractice"
      />

      <template v-else>
        <header class="market-replay__header">
          <div>
            <p class="market-replay__eyebrow">决策台 / 行情演练</p>
            <h1 class="market-replay__title">历史行情盲测</h1>
          </div>
          <UiButton class="market-replay__settings" variant="secondary" size="sm" icon-only aria-label="本局配置" title="本局配置" @click="settingsOpen=true"><Settings2 :size="17" /></UiButton>
        </header>

        <ReplayAccountSummary :session="session" />
        <ReplayAttemptContext
          :attempt-info="session.attemptInfo"
          :session-key="session.id"
        />

        <div
          class="market-replay__workspace"
          :class="{ 'market-replay__workspace--order-open': orderPanelOpen }"
        >
          <div class="market-replay__charts">
            <ReplayChartPanel
              :bars="session.bars"
              :executions="session.executions"
              :reveal="session.reveal"
              :session-interval="session.interval"
              :observation-bars="session.observationBars"
              :step-minutes="session.stepMinutes"
              :account="session.account"
            />
          </div>
          <aside
            class="market-replay__side"
            :class="{ 'market-replay__side--hybrid': session.interval === 'hybrid' }"
          >
            <ReplayIntradayPanel
              v-if="session.interval === 'hybrid'"
              :bars="session.minuteBars"
              :intraday="session.intraday"
              :previous-close="intradayPreviousClose"
              :step-minutes="session.stepMinutes"
            />
            <ReplayPlaybackControls
              :label="`已推进 ${session.revealedFutureBars} / ${session.gameLength} ${session.interval==='1m'?'分钟':'交易日'}`"
              :detail="session.status==='completed'?'本局已结束':session.interval==='hybrid'?`${session.stepMinutes ?? 1}分钟步进`:'历史盲测'"
              :playing="autoplay.playing" :speed="autoplay.speed" :speeds="REPLAY_AUTOPLAY_SPEEDS" :steps="playbackSteps"
              :progress="Math.min(100,session.revealedFutureBars / Math.max(1,session.gameLength)*100)"
              :play-disabled="attemptState.isBusy || session.status==='completed' || orderPanelOpen || finishConfirmOpen"
              :steps-disabled="attemptState.isBusy || session.status==='completed' || autoplay.playing || orderPanelOpen || finishConfirmOpen"
              :speed-disabled="attemptState.isBusy || session.status==='completed'" :message="autoplay.message"
              @toggle="commands.toggleAutoplay" @step="handleManualAdvance" @speed="commands.setAutoplaySpeed"
            >
              <template #actions>
                <UiButton variant="secondary" class="market-replay__finish" :disabled="attemptState.isBusy || session.status==='completed' || orderPanelOpen || finishConfirmOpen" @click="requestFinish">结束本局</UiButton>
                <UiButton variant="secondary" :disabled="attemptState.isBusy || finishConfirmOpen" @click="handleStartNewSession">新开一局</UiButton>
              </template>
            </ReplayPlaybackControls>
            <ReplayOrderDecisionDialog
              :open="orderPanelOpen"
              :side="orderPanelSide"
              :session-key="session.id"
              :execution-model-version="session.executionModelVersion"
              :trading-rules="session.tradingRules"
              :position-quantity="session.account.positionQuantity"
              :available-quantity="session.account.availableQuantity"
              :session-interval="session.interval"
              :step-minutes="session.stepMinutes"
              :reset-token="orderDraftResetToken"
              :submitting="attemptState.activity === 'submitting'"
              @close="orderPanelOpen = false"
              @submit="handleSubmitOrder"
            />
            <ReplayTradingPanel
              v-if="!orderPanelOpen"
              :session="session"
              :submitting="attemptState.activity === 'submitting'"
              :advancing="attemptState.activity === 'advancing'"
              :finishing="attemptState.activity === 'finishing'"
              :revealing="attemptState.activity === 'revealing'"
              @open-order="openOrderDialog"
              @cancel-order="commands.cancelOrder"
              @open-review="reviewDialogOpen = true"
              @reveal="commands.reveal"
            />
          </aside>
        </div>
        <UiDrawer
          :open="reviewDialogOpen"
          overlay-tone="transparent"
          title="两阶段复盘 · 决策记录与评分"
          description="逐笔委托记录回答每次为什么操作；这里负责整局盲评、揭晓后复盘和评分。"
          panel-class="market-replay-review-drawer"
          @close="reviewDialogOpen = false"
        >
          <ReplayReviewPanel
            modal
            :session="session"
            :playbooks="playbooks"
            :playbooks-loading="playbooksLoading"
            :playbooks-error="playbooksError"
            :saving-blind="attemptState.activity === 'savingBlindReview'"
            :saving-post="attemptState.activity === 'savingPostReview'"
            :saving-blind-correction="attemptState.activity === 'savingBlindCorrection'"
            :saving-post-correction="attemptState.activity === 'savingPostCorrection'"
            :review-drafts="review.drafts"
            :draft-statuses="review.statuses"
            @draft-change="handleReviewDraftChange"
            @delete-draft="commands.deleteReviewDraft"
            @save-blind="handleSaveBlind"
            @save-post="handleSavePost"
            @add-blind-correction="commands.addBlindCorrection"
            @add-post-correction="commands.addPostCorrection"
            @update-correction="commands.updateCorrection"
            @delete-correction="commands.deleteCorrection"
          />
        </UiDrawer>
      </template>
    </template>
    <UiDrawer :open="settingsOpen" title="本局配置" description="开局后冻结；修改需新开一局。" panel-class="market-replay-settings-drawer" @close="settingsOpen=false">
      <dl class="market-replay__costs"><div v-for="[label,value,raw] in frozenCosts" :key="label"><dt>{{ label }}</dt><dd :title="raw == null ? undefined : String(raw)">{{ value }}</dd></div></dl>
      <UiButton v-if="session?.attemptInfo?.kind==='retrain' && session.attemptInfo.sourceSessionId" variant="secondary" :disabled="attemptState.isBusy" @click="settingsOpen=false;cancelRetrainOpen=true">取消复练并返回首次结果</UiButton>
    </UiDrawer>
    <ConfirmDialog
      :open="finishConfirmOpen" title="结束本局？"
      :message="`将保留当前持仓，取消 ${session?.pendingOrders?.length ?? 0} 笔未执行委托。结束后不能继续交易，可到演练记录复盘。`"
      confirm-text="确认结束" cancel-text="继续演练" :busy="attemptState.activity==='finishing'"
      @cancel="finishConfirmOpen=false" @confirm="handleFinish"
    />
    <ConfirmDialog
      :open="cancelRetrainOpen"
      title="取消本次复练？"
      message="这次复练记录会被删除，并返回对应的首次演练结果；首次成绩和复盘不会改变。"
      confirm-text="取消复练并返回"
      variant="danger"
      :busy="attemptState.activity === 'cancellingRetrain'"
      @cancel="cancelRetrainOpen = false"
      @confirm="cancelRetrain"
    />
  </div>
</template>

<style scoped>
.market-replay__settings { width:32px;height:32px;min-height:32px;border-radius:7px;padding:0; }
.market-replay__costs { margin:0;font-size:12px; }.market-replay__costs>div { display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--ql-line); }.market-replay__costs dt { color:var(--ql-color-text-muted); }.market-replay__costs dd { margin:0;font-variant-numeric:tabular-nums; }
:global(.market-replay-settings-drawer) { width:min(380px,100vw); }
.market-replay__finish { color:var(--ql-color-danger); }

.market-replay {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 16px;
  padding: 0;
}

:global(.market-replay-review-drawer) {
  width: min(430px, calc(100vw - 32px));
}

:global(.market-replay-review-drawer .ql-ui-drawer__body) {
  padding-block: 4px;
}

.market-replay__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-top: 10px;
}

.market-replay__eyebrow {
  margin: 0 0 4px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 650;
}

.market-replay__title {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.035em;
}

.market-replay__workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
  gap: 16px;
  align-items: start;
}

.market-replay__charts {
  display: grid;
  min-width: 0;
  gap: 16px;
}

.market-replay__side {
  display: grid;
  min-width: 0;
  gap: 16px;
  align-items: start;
}

.market-replay__side--hybrid {
  position: sticky;
  top: 60px;
}

.market-replay__side--hybrid :deep(.replay-order-dialog) {
  position: relative;
  top: auto;
  height: min(560px, calc(100vh - 390px));
  min-height: 390px;
}

.market-replay__workspace--order-open {
  grid-template-columns: minmax(0, 1fr) minmax(460px, 520px);
}

.market-replay__loading {
  display: flex;
  min-height: 52vh;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--ql-color-text-muted);
  font-size: 13px;
}

.market-replay__spinner {
  animation: replay-spin 0.9s linear infinite;
}

.market-replay__message {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 12px;
  border: 1px solid rgba(14, 165, 233, 0.18);
  border-radius: var(--ql-radius-sm);
  color: #0369a1;
  background: var(--ql-color-info-soft);
  font-size: 12px;
}

.market-replay__message--error {
  border-color: rgba(239, 68, 68, 0.2);
  color: #b91c1c;
  background: var(--ql-color-danger-soft);
}

.market-replay__message span {
  flex: 1;
}

.market-replay__message button {
  display: grid;
  width: 28px;
  min-height: 28px;
  place-items: center;
  border: 0;
  border-radius: var(--ql-radius-xs);
  color: inherit;
  background: transparent;
  cursor: pointer;
}

/* 行情演练原先有一套独立的圆角和阴影，这里统一接入工作台 minimal 主题。 */
.market-replay :deep([class*="replay-"]) {
  border-radius: var(--ql-radius-sm) !important;
  box-shadow: none !important;
}

.market-replay :deep(.replay-account),
.market-replay :deep(.replay-chart-panel),
.market-replay :deep(.replay-trading),
.market-replay :deep(.replay-review),
.market-replay :deep(.replay-training-context) {
  border-radius: var(--ql-radius-card) !important;
  background: var(--ql-color-bg-surface-strong) !important;
}

.market-replay :deep(.replay-setup__card) {
  border-radius: 12px !important;
  box-shadow: none !important;
}

.market-replay :deep(.replay-resume) { border-radius:0 !important; }

@keyframes replay-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1280px) {
  .market-replay {
    padding-right: 0;
    padding-left: 0;
  }

  .market-replay__workspace {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 310px);
  }

  .market-replay__workspace--order-open {
    grid-template-columns: minmax(0, 1fr) minmax(440px, 480px);
  }
}

@media (max-width: 980px) {
  .market-replay__workspace {
    grid-template-columns: 1fr;
  }

  .market-replay__side--hybrid {
    position: static;
  }
}

@media (max-width: 640px) {
  .market-replay {
    padding: 0;
  }

  .market-replay__side--hybrid :deep(.replay-order-dialog) {
    position: fixed;
    top: 0;
    height: 100dvh;
    min-height: 0;
  }
}
</style>
