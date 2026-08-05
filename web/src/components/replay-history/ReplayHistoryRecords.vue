<script setup>
import { reactive } from "vue";
import { useRouter } from "vue-router";

import { useReplayHistory } from "../../composables/useReplayHistory.js";
import { api } from "../../services/api.js";
import UiButton from "../ui/UiButton.vue";
import UiCard from "../ui/UiCard.vue";
import ReplayHistoryDetail from "./ReplayHistoryDetail.vue";
import ReplayHistoryFilters from "./ReplayHistoryFilters.vue";
import ReplayHistoryList from "./ReplayHistoryList.vue";

const router = useRouter();
const {
  items,
  total,
  page,
  state,
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
  loadSelectedDetail,
  refresh,
} = useReplayHistory();

const candidateStates = reactive({});
const retrainStates = reactive({});
const deleteStates = reactive({});

function openReplay(item) {
  window.localStorage.setItem(
    "investflow.replay.active-session-id",
    item.id,
  );
  router.push("/decision/market-replay");
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

async function deleteReplay(item) {
  const current = deleteStateFor(item.id);
  if (current.loading) {
    return;
  }
  const identity = item.reveal?.name || item.reveal?.tsCode || `演练 ${item.id.slice(0, 8)}`;
  if (
    !window.confirm(
      `删除“${identity}”的演练记录？\n\n删除后不会再出现在演练历史中，且无法从页面恢复。`,
    )
  ) {
    return;
  }
  deleteStates[item.id] = { loading: true, error: "" };
  try {
    await api.deleteReplaySession(item.id);
    if (
      window.localStorage.getItem("investflow.replay.active-session-id") ===
      item.id
    ) {
      window.localStorage.removeItem("investflow.replay.active-session-id");
    }
    delete deleteStates[item.id];
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
    const result = await api.retrainReplaySession(item.id);
    const newSessionId = String(result.session?.id ?? "");
    if (!newSessionId) {
      throw new Error("复练会话创建成功，但响应缺少会话编号");
    }
    window.localStorage.setItem(
      "investflow.replay.active-session-id",
      newSessionId,
    );
    await router.push("/decision/market-replay");
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
  <div class="replay-history-records">
    <UiCard>
      <template #header>
        <div>
          <h2 class="ql-text-base ql-font-semibold ql-text-slate-900">
            历史演练
          </h2>
          <p class="ql-mt-1 ql-text-xs ql-text-slate-500">
            统一查看未完成演练、两阶段复盘和评分结果；未揭晓记录保持匿名。
          </p>
        </div>
      </template>
      <ReplayHistoryFilters
        :state="state"
        :attempt-kind="attemptKind"
        :keyword="keyword"
        :loading="loading"
        @apply="applyFilters"
        @refresh="refresh"
      />
    </UiCard>

    <div
      v-if="error"
      class="replay-history-records__message replay-history-records__message--error"
    >
      <span>{{ error }}</span>
      <UiButton type="button" size="sm" variant="secondary" @click="refresh">
        重试
      </UiButton>
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
      <ReplayHistoryDetail
        v-if="selectedDetailItem"
        :item="selectedDetailItem"
        :candidate-state="candidateStateFor(selectedDetailItem.id)"
        :retrain-state="retrainStateFor(selectedDetailItem.id)"
        :delete-state="deleteStateFor(selectedDetailItem.id)"
        @open="openReplay"
        @add-candidate="addCandidate"
        @retrain="retrainReplay"
        @delete="deleteReplay"
      />
      <div
        v-else-if="detailError"
        class="replay-history-records__message replay-history-records__message--error"
      >
        <span>{{ detailError }}</span>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          @click="loadSelectedDetail(selectedId)"
        >
          重试详情
        </UiButton>
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
