<script setup>
import { AlertCircle, RefreshCw, X } from "lucide-vue-next";
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  shallowRef,
} from "vue";

import ReplayAccountSummary from "../components/replay/ReplayAccountSummary.vue";
import ReplayAttemptContext from "../components/replay/ReplayAttemptContext.vue";
import ReplayChartPanel from "../components/replay/ReplayChartPanel.vue";
import ReplayIntradayPanel from "../components/replay/ReplayIntradayPanel.vue";
import ReplayReviewPanel from "../components/replay/ReplayReviewPanel.vue";
import ReplayOrderDecisionDialog from "../components/replay/ReplayOrderDecisionDialog.vue";
import ReplaySetupPanel from "../components/replay/ReplaySetupPanel.vue";
import ReplayTradingPanel from "../components/replay/ReplayTradingPanel.vue";
import ReplayTrainingContext from "../components/replay/ReplayTrainingContext.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiModal from "../components/ui/UiModal.vue";
import { useReplayAutoplay } from "../composables/useReplayAutoplay.js";
import { useReplayReviewDrafts } from "../composables/useReplayReviewDrafts.js";
import { useReplaySession } from "../composables/useReplaySession";
import { api } from "../services/api.js";

const {
  session,
  hasSession,
  isCompleted,
  isBusy,
  isRestoring,
  isCreating,
  isSubmitting,
  isAdvancing,
  isFinishing,
  isRevealing,
  isSavingBlindReview,
  isSavingPostReview,
  isSavingBlindCorrection,
  isSavingPostCorrection,
  errorMessage,
  statusMessage,
  createSession,
  submitOrder,
  advanceSession,
  finishSession,
  skipSessionAndRestart,
  revealSession,
  saveBlindReview,
  savePostReview,
  addBlindReviewCorrection,
  addPostReviewCorrection,
  syncStoredSession,
  startNewSession,
  clearMessages,
} = useReplaySession();

const {
  drafts: reviewDrafts,
  statuses: reviewDraftStatuses,
  queueDraft: queueReviewDraft,
  deleteDraft: deleteReviewDraft,
  prepareFinal: prepareReviewFinal,
  finishFinal: finishReviewFinal,
} = useReplayReviewDrafts({ session });
const currentBlindDraft = computed(() => reviewDrafts.value.blind);

const {
  playing: autoplayPlaying,
  speed: autoplaySpeed,
  message: autoplayMessage,
  pause: pauseAutoplay,
  toggle: toggleAutoplay,
  setSpeed: setAutoplaySpeed,
} = useReplayAutoplay({
  session,
  isBusy,
  errorMessage,
  statusMessage,
  advanceSession,
  blindDraft: currentBlindDraft,
});

const playbooks = shallowRef([]);
const playbooksLoading = shallowRef(false);
const playbooksError = shallowRef("");
let playbookRequestSequence = 0;
const benchmarks = shallowRef([]);
const benchmarksLoading = shallowRef(false);
const benchmarksError = shallowRef("");
const benchmarkInitialization = shallowRef(null);
const orderPanelOpen = shallowRef(false);
const orderPanelSide = shallowRef("buy");
const orderDraftResetToken = shallowRef(0);
const reviewDialogOpen = shallowRef(false);
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
    !hasSession.value ||
    isBusy.value ||
    isCompleted.value ||
    !["Space", "ArrowRight"].includes(event.code)
  ) {
    return;
  }
  event.preventDefault();
  pauseAutoplay();
  advanceSession();
}

function openOrderDialog(side) {
  orderPanelSide.value = side;
  orderPanelOpen.value = true;
}

async function handleSubmitOrder(order) {
  pauseAutoplay();
  const updated = await submitOrder(order);
  if (updated) {
    orderPanelOpen.value = false;
    orderDraftResetToken.value += 1;
  }
}

function handleStartNewSession() {
  orderPanelOpen.value = false;
  orderDraftResetToken.value += 1;
  startNewSession();
}

function handleManualAdvance(mode = "minute") {
  pauseAutoplay();
  advanceSession(mode);
}

function handleFinish() {
  pauseAutoplay();
  finishSession();
}

function handleSkipAndRestart() {
  pauseAutoplay();
  orderPanelOpen.value = false;
  orderDraftResetToken.value += 1;
  skipSessionAndRestart();
}

function handleReviewDraftChange({ stage, draft }) {
  queueReviewDraft(stage, draft);
}

async function handleSaveBlind(review) {
  await prepareReviewFinal("blind");
  const savedSession = await saveBlindReview(review);
  finishReviewFinal("blind", Boolean(savedSession));
}

async function handleSavePost(review) {
  await prepareReviewFinal("post");
  const savedSession = await savePostReview(review);
  finishReviewFinal("post", Boolean(savedSession));
}

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
onActivated(syncStoredSession);
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
    <div v-if="isRestoring" class="market-replay__loading">
      <RefreshCw :size="18" class="market-replay__spinner" />
      正在恢复上次行情演练…
    </div>

    <template v-else>
      <div
        v-if="errorMessage || statusMessage"
        class="market-replay__message"
        :class="{ 'market-replay__message--error': errorMessage }"
        role="status"
      >
        <AlertCircle :size="15" />
        <span>{{ errorMessage || statusMessage }}</span>
        <button type="button" aria-label="关闭提示" @click="clearMessages">
          <X :size="14" />
        </button>
      </div>

      <ReplaySetupPanel
        v-if="!hasSession"
        :loading="isCreating"
        :benchmarks="benchmarks"
        :benchmarks-loading="benchmarksLoading"
        :benchmarks-error="benchmarksError"
        :benchmark-initialization="benchmarkInitialization"
        @create="createSession"
        @retry-benchmarks="retryReplayBenchmarks"
      />

      <template v-else>
        <header class="market-replay__header">
          <div>
            <p class="market-replay__eyebrow">决策台 / 行情演练</p>
            <h1 class="market-replay__title">历史行情盲测</h1>
          </div>
          <UiButton
            variant="secondary"
            size="sm"
            :disabled="isBusy"
            @click="handleStartNewSession"
          >
            新开一局
          </UiButton>
        </header>

        <ReplayAccountSummary :session="session" />
        <ReplayAttemptContext :attempt-info="session.attemptInfo" />
        <ReplayTrainingContext :training-config="session.trainingConfig" />

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
            <ReplayOrderDecisionDialog
              :open="orderPanelOpen"
              :side="orderPanelSide"
              :session-key="session.id"
              :session-interval="session.interval"
              :step-minutes="session.stepMinutes"
              :reset-token="orderDraftResetToken"
              :submitting="isSubmitting"
              @close="orderPanelOpen = false"
              @submit="handleSubmitOrder"
            />
            <ReplayTradingPanel
              v-if="!orderPanelOpen"
              :session="session"
              :submitting="isSubmitting"
              :advancing="isAdvancing"
              :finishing="isFinishing"
              :revealing="isRevealing"
              :autoplay-playing="autoplayPlaying"
              :autoplay-speed="autoplaySpeed"
              :autoplay-message="autoplayMessage"
              @open-order="openOrderDialog"
              @open-review="reviewDialogOpen = true"
              @advance="handleManualAdvance"
              @finish="handleFinish"
              @skip="handleSkipAndRestart"
              @reveal="revealSession"
              @toggle-autoplay="toggleAutoplay"
              @change-autoplay-speed="setAutoplaySpeed"
            />
          </aside>
        </div>
        <UiModal
          :open="reviewDialogOpen"
          :busy="isSavingBlindReview || isSavingPostReview"
          title="两阶段复盘 · 决策记录与评分"
          description="逐笔委托记录回答每次为什么操作；这里负责整局盲评、揭晓后复盘和评分。"
          panel-class="market-replay-review-dialog"
          @close="reviewDialogOpen = false"
        >
          <ReplayReviewPanel
            modal
            :session="session"
            :playbooks="playbooks"
            :playbooks-loading="playbooksLoading"
            :playbooks-error="playbooksError"
            :saving-blind="isSavingBlindReview"
            :saving-post="isSavingPostReview"
            :saving-blind-correction="isSavingBlindCorrection"
            :saving-post-correction="isSavingPostCorrection"
            :review-drafts="reviewDrafts"
            :draft-statuses="reviewDraftStatuses"
            @draft-change="handleReviewDraftChange"
            @delete-draft="deleteReviewDraft"
            @save-blind="handleSaveBlind"
            @save-post="handleSavePost"
            @add-blind-correction="addBlindReviewCorrection"
            @add-post-correction="addPostReviewCorrection"
          />
        </UiModal>
      </template>
    </template>
  </div>
</template>

<style scoped>
.market-replay {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 16px;
  padding: 0;
}

:global(.market-replay-review-dialog) {
  width: min(1040px, calc(100vw - 32px));
}

.market-replay__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
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
  top: 16px;
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
  box-shadow: none !important;
}

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
