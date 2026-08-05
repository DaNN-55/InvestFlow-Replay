<script setup>
import { computed, shallowRef } from "vue";
import { useRouter } from "vue-router";

import { useReplayPlaybooks } from "../../composables/useReplayPlaybooks.js";
import {
  getCandidateSessionId,
} from "../../utils/replayPlaybookPresentation.js";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiModal from "../ui/UiModal.vue";
import ConfirmDialog from "../ConfirmDialog.vue";
import ReplayPlaybookDetail from "./ReplayPlaybookDetail.vue";
import ReplayPlaybookList from "./ReplayPlaybookList.vue";

const router = useRouter();
const {
  playbooks,
  selectedId,
  selectedDetail,
  loadingList,
  loadingDetail,
  activeAction,
  error,
  success,
  loadPlaybooks,
  selectPlaybook,
  createPlaybook,
  createVersion,
  renamePlaybook,
  deletePlaybook,
  acceptCandidate,
  rejectCandidate,
  clearFeedback,
} = useReplayPlaybooks();

const createSuccessToken = shallowRef(0);
const renameTarget = shallowRef(null);
const renameName = shallowRef("");
const deleteTarget = shallowRef(null);
const renameReady = computed(
  () =>
    renameName.value.trim().length >= 1 &&
    renameName.value.trim().length <= 120 &&
    renameName.value.trim() !== renameTarget.value?.name,
);

async function handleCreate(payload) {
  const result = await createPlaybook(payload);
  if (result) {
    createSuccessToken.value += 1;
  }
}

function handleAccept({ candidateId, payload }) {
  return acceptCandidate(candidateId, payload);
}

function handleReject({ candidateId, reason }) {
  return rejectCandidate(candidateId, reason);
}

function openSource(candidate) {
  const sessionId = getCandidateSessionId(candidate);
  if (!sessionId) {
    return;
  }
  window.localStorage.setItem(
    "investflow.replay.active-session-id",
    sessionId,
  );
  router.push("/decision/market-replay");
}

function openRename(item) {
  renameTarget.value = item;
  renameName.value = item.name;
}

function closeRename() {
  if (activeAction.value.startsWith("rename:")) {
    return;
  }
  renameTarget.value = null;
  renameName.value = "";
}

async function submitRename() {
  if (!renameTarget.value || !renameReady.value) {
    return;
  }
  const result = await renamePlaybook(renameTarget.value.id, {
    name: renameName.value.trim(),
  });
  if (result) {
    closeRename();
  }
}

async function confirmDelete() {
  if (!deleteTarget.value) {
    return;
  }
  const result = await deletePlaybook(deleteTarget.value.id);
  if (result !== null) {
    deleteTarget.value = null;
  }
}
</script>

<template>
  <section class="replay-playbook-panel">
    <div
      v-if="error || success"
      class="replay-playbook-panel__feedback"
      :class="{ 'replay-playbook-panel__feedback--error': error }"
      role="status"
    >
      <span>{{ error || success }}</span>
      <div>
        <UiButton
          v-if="error"
          type="button"
          size="sm"
          variant="secondary"
          @click="loadPlaybooks"
        >
          重试
        </UiButton>
        <button type="button" aria-label="关闭提示" @click="clearFeedback">
          ×
        </button>
      </div>
    </div>

    <div class="replay-playbook-panel__layout">
      <ReplayPlaybookList
        :items="playbooks"
        :selected-id="selectedId"
        :loading="loadingList"
        :creating="activeAction === 'create-playbook'"
        :create-success-token="createSuccessToken"
        :active-action="activeAction"
        @select="selectPlaybook"
        @create="handleCreate"
        @rename="openRename"
        @delete="deleteTarget = $event"
      />
      <ReplayPlaybookDetail
        :key="
          `${selectedDetail?.playbook?.id || 'empty'}-${
            selectedDetail?.playbook?.currentVersion?.id || 'none'
          }`
        "
        :detail="selectedDetail"
        :loading="loadingDetail"
        :active-action="activeAction"
        @create-version="createVersion"
        @accept-candidate="handleAccept"
        @reject-candidate="handleReject"
        @open-source="openSource"
      />
    </div>

    <UiModal
      :open="Boolean(renameTarget)"
      title="修改战法名称"
      description="只修改战法名称；规则正文和历史版本不会改变。"
      :busy="activeAction.startsWith('rename:')"
      panel-class="replay-playbook-panel__rename-modal"
      @close="closeRename"
    >
      <form class="replay-playbook-panel__rename-form" @submit.prevent="submitRename">
        <label>
          <span>战法名称</span>
          <UiInput v-model="renameName" maxlength="120" autofocus />
        </label>
        <div>
          <UiButton type="button" variant="secondary" @click="closeRename">
            取消
          </UiButton>
          <UiButton
            type="submit"
            :loading="activeAction.startsWith('rename:')"
            :disabled="!renameReady || activeAction.startsWith('rename:')"
          >
            保存名称
          </UiButton>
        </div>
      </form>
    </UiModal>

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="删除战法"
      :message="`确认从战法库删除“${deleteTarget?.name || ''}”？已经冻结在交易和演练历史中的旧版本仍会保留。`"
      confirm-text="删除战法"
      :busy="activeAction.startsWith('delete:')"
      @cancel="deleteTarget = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.replay-playbook-panel {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

.replay-playbook-panel__feedback {
  align-items: center;
  border: 1px solid #a7f3d0;
  border-radius: 8px;
  color: #047857;
  background: var(--ql-color-success-soft);
  display: flex;
  font-size: 0.8125rem;
  gap: 1rem;
  justify-content: space-between;
  padding: 0.75rem 1rem;
}

.replay-playbook-panel__feedback--error {
  border-color: #fecdd3;
  color: #be123c;
  background: var(--ql-color-danger-soft);
}

.replay-playbook-panel__feedback > div {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.replay-playbook-panel__feedback > div > button:last-child {
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font-size: 1.125rem;
}

.replay-playbook-panel__layout {
  align-items: start;
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(280px, 0.65fr) minmax(520px, 1.35fr);
  min-width: 0;
}

.replay-playbook-panel__rename-form {
  display: grid;
  gap: 1rem;
}

.replay-playbook-panel__rename-form label {
  display: grid;
  gap: 0.375rem;
}

.replay-playbook-panel__rename-form label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 750;
}

.replay-playbook-panel__rename-form > div {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

:deep(.replay-playbook-panel__rename-modal) {
  width: min(480px, calc(100vw - 32px));
}

@media (max-width: 900px) {
  .replay-playbook-panel__layout {
    grid-template-columns: 1fr;
  }
}
</style>
