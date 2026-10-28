<script setup>
import { computed, reactive, shallowRef, onActivated, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CryptoHistoryDetail from '../crypto/CryptoHistoryDetail.vue';

import { useReplayHistory } from "../../composables/useReplayHistory.js";
import { api } from "../../services/api.js";
import { createCryptoReplayController, CRYPTO_STORAGE_KEY } from "../../utils/cryptoReplayController.js";
import ConfirmDialog from "../ConfirmDialog.vue";
import ReplayReviewCorrectionForm from "../replay/ReplayReviewCorrectionForm.vue";
import ReplayHistoryControls from "./ReplayHistoryControls.vue";
import UiModal from "../ui/UiModal.vue";
import { getLatestReplayReviewSnapshot } from "../../utils/replayReviewCorrections.js";
import ReplayTrainingAnalytics from "./ReplayTrainingAnalytics.vue";
import ReplayHistoryDetail from "./ReplayHistoryDetail.vue";
import ReplayHistoryFilters from "./ReplayHistoryFilters.vue";
import ReplayHistoryList from "./ReplayHistoryList.vue";

const activeView = shallowRef("records");
const analysisKind = computed(() => activeView.value === "retrain" ? "retrain" : "first");
const router = useRouter();
const route = useRoute();
const {
  items,
  total,
  page,
  state,
  market,
  attemptKind,
  keyword,
  loading,
  error,
  selectedId,
  selectedItem,
  selectedDetailItem,
  detailLoading,
  detailError,
  pageCount,
  applyFilters,
  goToPage,
  selectItem,
  refresh,
} = useReplayHistory({ market: ['all','ashare','crypto-perpetual'].includes(route.query.market) ? route.query.market : 'all', keyword:route.query.session??'', selectedId: route.query.session ?? '' });
onActivated(()=>{if(items.value.length) refresh();});
watch(()=>route.fullPath,()=>{if(route.name==='quant-trade-records'&&route.query.tab==='replay') applyFilters({market:['all','ashare','crypto-perpetual'].includes(route.query.market)?route.query.market:market.value,keyword:route.query.session??'',...(route.query.session?{state:'all',attemptKind:'all'}:{})});});

const candidateStates = reactive({});
const retrainStates = reactive({});
const deleteStates = reactive({});
const pendingDeleteItem = shallowRef(null);
const editingCorrection = shallowRef(null);
const deletingCorrection = shallowRef(null);
const correctionBusy = shallowRef(false);
const correctionError = shallowRef("");
const playbooks = shallowRef([]);
const playbooksLoading = shallowRef(false);
const playbooksError = shallowRef("");
const pendingDeleteIdentity = computed(() => {
  const item = pendingDeleteItem.value;
  if (!item) return "这条演练记录";
  if (item.market === "crypto-perpetual") return `${item.instrumentId} · 演练 ${item.id.slice(0, 8)}`;
  return item.reveal?.name || item.reveal?.tsCode || `演练 ${item.id.slice(0, 8)}`;
});
const pendingDeleteMessage = computed(() => {
  const error = pendingDeleteItem.value ? deleteStateFor(pendingDeleteItem.value.id).error : "";
  return `确认删除“${pendingDeleteIdentity.value}”的演练记录？删除后不会再出现在演练历史中，且无法从页面恢复。${error ? ` 删除失败：${error}` : ""}`;
});
const effectiveBlindReview = computed(() =>
  getLatestReplayReviewSnapshot({
    stage: "blind",
    originalReview: selectedDetailItem.value?.blindReview,
    corrections: selectedDetailItem.value?.corrections,
  }),
);
const playbookFitApplicable = computed(
  () =>
    Boolean(effectiveBlindReview.value?.playbookId) &&
    Boolean(effectiveBlindReview.value?.playbookVersionId),
);

async function openAnalysisRecord(sessionId) {
  activeView.value = "records";
  await applyFilters({ state: "all", attemptKind: "all", keyword: sessionId });
}

function createActionId() {
  return globalThis.crypto?.randomUUID?.() ??
    `replay-review-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadPlaybooks() {
  if (playbooks.value.length || playbooksLoading.value) return;
  playbooksLoading.value = true;
  playbooksError.value = "";
  try {
    const result = await api.listReplayPlaybooks();
    playbooks.value = Array.isArray(result.items) ? result.items : [];
  } catch (error) {
    playbooksError.value = error?.message ?? "战法选项加载失败";
  } finally {
    playbooksLoading.value = false;
  }
}

function editCorrection(correction) {
  editingCorrection.value = correction;
  correctionError.value = "";
  if (correction.stage === "blind") void loadPlaybooks();
}

async function updateCorrection(payload) {
  const correction = editingCorrection.value;
  const session = selectedDetailItem.value;
  if (!correction || !session || correctionBusy.value) return;
  correctionBusy.value = true;
  correctionError.value = "";
  try {
    await api.updateReplayReviewCorrection(
      session.id,
      correction.stage,
      correction.id,
      {
        actionId: createActionId(),
        expectedRevision: session.revision,
        ...payload,
      },
    );
    editingCorrection.value = null;
    await refresh();
  } catch (error) {
    correctionError.value = error?.message ?? "复盘修正记录更新失败";
  } finally {
    correctionBusy.value = false;
  }
}

async function deleteCorrection() {
  const correction = deletingCorrection.value;
  const session = selectedDetailItem.value;
  if (!correction || !session || correctionBusy.value) return;
  correctionBusy.value = true;
  correctionError.value = "";
  try {
    await api.deleteReplayReviewCorrection(
      session.id,
      correction.stage,
      correction.id,
      {
        actionId: createActionId(),
        expectedRevision: session.revision,
      },
    );
    deletingCorrection.value = null;
    await refresh();
  } catch (error) {
    correctionError.value = error?.message ?? "复盘修正记录删除失败";
  } finally {
    correctionBusy.value = false;
  }
}

function openReplay(item) {
  if(item.market === 'crypto-perpetual') { router.push({path:'/decision/crypto-replay',query:{session:item.id}}); return; }
  window.localStorage.setItem(
    "investflow.replay.active-session-id",
    item.id,
  );
  router.push({ path: "/decision/market-replay", query: { session: item.id } });
}

function candidateStateFor(sessionId) {
  return candidateStates[sessionId] ?? {};
}

function retrainStateFor(sessionId) {
  return retrainStates[sessionId] ?? {};
}

function deleteStateFor(sessionId) {
  return deleteStates[sessionId] ?? {};
}

function requestDeleteReplay(item) {
  pendingDeleteItem.value = item;
}

async function deleteReplay() {
  const item = pendingDeleteItem.value;
  if (!item) return;
  const current = deleteStateFor(item.id);
  if (current.loading) {
    return;
  }
  deleteStates[item.id] = { loading: true, error: "" };
  try {
    await api.deleteReplaySession(item.id);
    if (item.market === "crypto-perpetual") {
      try {
        const saved = JSON.parse(window.localStorage.getItem(CRYPTO_STORAGE_KEY) ?? "null");
        if (saved?.sessionId === item.id && !saved.pending) window.localStorage.removeItem(CRYPTO_STORAGE_KEY);
      } catch { /* Keep interrupted or unrelated recovery data intact. */ }
    }
    if (
      window.localStorage.getItem("investflow.replay.active-session-id") ===
      item.id
    ) {
      window.localStorage.removeItem("investflow.replay.active-session-id");
    }
    delete deleteStates[item.id];
    pendingDeleteItem.value = null;
    await refresh();
  } catch (deleteError) {
    deleteStates[item.id] = {
      loading: false,
      error: deleteError?.message ?? "删除演练记录失败",
    };
  }
}

async function retrainReplay(item) {
  const current = retrainStateFor(item.id);
  if (current.loading) {
    return;
  }
  retrainStates[item.id] = { loading: true, error: "" };
  try {
    if (item.market === "crypto-perpetual") {
      const controller = createCryptoReplayController({ api, storage: window.localStorage });
      if (controller.state.pending) throw new Error("有合约动作的结果待确认，请先打开合约演练核对，再创建复练。");
      if (!await controller.select(item.id) || !controller.state.session) throw new Error(controller.state.error || "读取原演练失败");
      if (!await controller.act("retrain") && (controller.state.pending || controller.targetSessionId === item.id)) {
        throw new Error(controller.state.pending ? "复练结果待确认，请打开演练后重试原动作。" : controller.state.error || "创建复练失败");
      }
      await router.push({ path: "/decision/crypto-replay", query: { session: controller.targetSessionId } });
      retrainStates[item.id] = { loading: false, error: "" };
      return;
    }
    const result = await api.retrainReplaySession(item.id);
    const newSessionId = String(result.session?.id ?? "");
    if (!newSessionId) {
      throw new Error("复练会话创建成功，但响应缺少会话编号");
    }
    window.localStorage.setItem(
      "investflow.replay.active-session-id",
      newSessionId,
    );
    await router.push({ path: "/decision/market-replay", query: { session: newSessionId } });
  } catch (retrainError) {
    retrainStates[item.id] = {
      loading: false,
      error: retrainError?.message ?? "创建复练失败",
    };
  }
}

async function addCandidate(item) {
  const current = candidateStateFor(item.id);
  if (current.loading || current.created) {
    return;
  }
  candidateStates[item.id] = { loading: true, error: "", success: "" };
  try {
    await api.createReplayPlaybookCandidate({ sessionId: item.id });
    candidateStates[item.id] = {
      loading: false,
      created: true,
      error: "",
      success: "已在候选库中；若此前已加入，系统不会重复创建。",
    };
  } catch (candidateError) {
    candidateStates[item.id] = {
      loading: false,
      created: false,
      error: candidateError?.message ?? "加入候选改进失败",
      success: "",
    };
  }
}
</script>

<template>
  <div class="replay-history-records crypto-controls">
    <p v-if="route.query.session" class="crypto-muted">当前定位本局练习。<button type="button" class="crypto-text-button" @click="router.replace({query:{...route.query,session:undefined}})">查看全部演练记录</button></p>
    <ReplayHistoryControls v-if="activeView === 'records'" :active-view="activeView" @view-change="activeView = $event">
      <ReplayHistoryFilters
        :market="market"
        :state="state"
        :attempt-kind="attemptKind"
        :keyword="keyword"
        :loading="loading"
        @apply="applyFilters"
      />
    </ReplayHistoryControls>

    <ReplayTrainingAnalytics v-if="activeView !== 'records'" :kind="analysisKind" @view-change="activeView = $event" @open-record="openAnalysisRecord" />
    <div
      v-else-if="error"
      class="replay-history-records__message replay-history-records__message--error"
    >
      <span>{{ error }}</span>
    </div>

    <div v-else class="replay-history-records__layout">
      <ReplayHistoryList
        :items="items"
        :total="total"
        :page="page"
        :page-count="pageCount"
        :selected-id="selectedId"
        :loading="loading"
        @select="selectItem"
        @page="goToPage"
      />
      <CryptoHistoryDetail
        v-if="selectedDetailItem?.market === 'crypto-perpetual'"
        :key="selectedDetailItem.id"
        :item="selectedDetailItem"
        :retrain-state="retrainStateFor(selectedDetailItem.id)"
        :delete-state="deleteStateFor(selectedDetailItem.id)"
        @open="openReplay"
        @retrain="retrainReplay"
        @delete="requestDeleteReplay"
      />
      <ReplayHistoryDetail
        v-else-if="selectedDetailItem"
        :item="selectedDetailItem"
        :candidate-state="candidateStateFor(selectedDetailItem.id)"
        :retrain-state="retrainStateFor(selectedDetailItem.id)"
        :delete-state="deleteStateFor(selectedDetailItem.id)"
        @open="openReplay"
        @add-candidate="addCandidate"
        @retrain="retrainReplay"
        @delete="requestDeleteReplay"
        @edit-correction="editCorrection"
        @delete-correction="deletingCorrection = $event"
      />
      <div
        v-else-if="detailError"
        class="replay-history-records__message replay-history-records__message--error"
      >
        <span>{{ detailError }}</span>
      </div>
      <div
        v-else-if="detailLoading || (selectedItem && !loading)"
        class="replay-history-records__message replay-history-records__message--empty"
      >
        正在加载所选演练详情…
      </div>
      <div
        v-else-if="!loading"
        class="replay-history-records__message replay-history-records__message--empty"
      >
        选择一局演练后，可在这里查看复盘和评分详情。
      </div>
      <div
        v-else
        class="replay-history-records__message replay-history-records__message--empty"
      >
        正在加载历史演练…
      </div>
    </div>
    <ConfirmDialog
      :open="Boolean(pendingDeleteItem)"
      title="删除演练记录"
      :message="pendingDeleteMessage"
      confirm-text="确认删除"
      :busy="pendingDeleteItem ? Boolean(deleteStateFor(pendingDeleteItem.id).loading) : false"
      @cancel="pendingDeleteItem = null"
      @confirm="deleteReplay"
    />
    <UiModal
      :open="Boolean(editingCorrection)"
      :busy="correctionBusy"
      title="修改复盘修正"
      description="修改当前修正快照，不会覆盖原始复盘或重新计算原始评分。"
      variant="drawer"
      @close="editingCorrection = null"
    >
      <p v-if="correctionError" class="replay-history-records__message replay-history-records__message--error">
        {{ correctionError }}
      </p>
      <ReplayReviewCorrectionForm
        v-if="editingCorrection"
        :stage="editingCorrection.stage"
        :snapshot="editingCorrection.fullReviewSnapshot"
        :playbook-fit-applicable="playbookFitApplicable"
        :playbooks="playbooks"
        :playbooks-loading="playbooksLoading"
        :playbooks-error="playbooksError"
        :loading="correctionBusy"
        :initial-change-note="editingCorrection.changeNote"
        editing
        @cancel="editingCorrection = null"
        @submit="updateCorrection"
      />
    </UiModal>
    <ConfirmDialog
      :open="Boolean(deletingCorrection)"
      title="删除复盘修正"
      message="确认删除这条复盘修正？删除后，当前有效内容会回退到上一条同阶段修正或原始复盘。"
      confirm-text="确认删除"
      variant="danger"
      :busy="correctionBusy"
      @cancel="deletingCorrection = null"
      @confirm="deleteCorrection"
    />
  </div>
</template>

<style scoped>


.replay-history-records {
  display: grid;
  gap: 1rem;
}

.replay-history-records__layout {
  align-items: start;
  display: grid;
  gap: 1rem;
  grid-template-columns: 300px minmax(0, 1fr);
}

.replay-history-records__message {
  align-items: center;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  display: flex;
  font-size: 0.8125rem;
  gap: 1rem;
  justify-content: space-between;
  padding: 1rem;
}

.replay-history-records__message--error {
  background: var(--ql-color-danger-soft);
  border-color: #fecdd3;
  color: #be123c;
}

.replay-history-records__message--empty {
  background: var(--ql-color-bg-muted);
  color: var(--ql-color-text-muted);
  justify-content: center;
  min-height: 10rem;
  text-align: center;
}

@media (max-width: 900px) {
  .replay-history-records__layout {
    grid-template-columns: 1fr;
  }
}
</style>
