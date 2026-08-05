<script setup>
import { computed, reactive, shallowRef, watch } from "vue";

import {
  buildCandidateVersionDraft,
  formatPlaybookTime,
  getCandidateSessionId,
  getCandidateStatusPresentation,
  getCandidateSuggestion,
  getPlaybookVersionNumber,
} from "../../utils/replayPlaybookPresentation.js";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import ReplayPlaybookVersionForm from "./ReplayPlaybookVersionForm.vue";

const props = defineProps({
  detail: {
    type: Object,
    default: null,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  activeAction: {
    type: String,
    default: "",
  },
});

const emit = defineEmits([
  "createVersion",
  "acceptCandidate",
  "rejectCandidate",
  "openSource",
]);

const mode = shallowRef("");
const activeCandidate = shallowRef(null);
const rejectReasons = reactive({});

const playbook = computed(() => props.detail?.playbook ?? null);
const versions = computed(() => props.detail?.versions ?? []);
const candidates = computed(() => props.detail?.candidates ?? []);
const manualDraft = computed(() => ({
  expectedVersionNumber: getPlaybookVersionNumber(playbook.value),
  content: playbook.value?.currentVersion?.content ?? "",
  changeSummary: "",
}));
const candidateDraft = computed(() =>
  buildCandidateVersionDraft(playbook.value, activeCandidate.value),
);

function startAccept(candidate) {
  activeCandidate.value = candidate;
  mode.value = "candidate";
}

function cancelVersionForm() {
  mode.value = "";
  activeCandidate.value = null;
}

function submitVersion(payload) {
  if (mode.value === "candidate" && activeCandidate.value) {
    emit("acceptCandidate", {
      candidateId: activeCandidate.value.id,
      payload,
    });
    return;
  }
  emit("createVersion", payload);
}

watch(
  () => props.detail?.playbook?.id,
  () => {
    cancelVersionForm();
    Object.keys(rejectReasons).forEach((key) => delete rejectReasons[key]);
  },
);
</script>

<template>
  <article class="replay-playbook-detail">
    <div v-if="loading && !detail" class="replay-playbook-detail__empty">
      正在加载战法详情…
    </div>
    <div v-else-if="!playbook" class="replay-playbook-detail__empty">
      选择一个战法后，可查看正文、版本历史和候选改进。
    </div>
    <template v-else>
      <header class="replay-playbook-detail__header">
        <div>
          <p>当前生效版本 v{{ getPlaybookVersionNumber(playbook) }}</p>
          <h2>{{ playbook.name }}</h2>
        </div>
        <UiButton
          type="button"
          size="sm"
          :disabled="Boolean(activeAction)"
          @click="mode = 'manual'"
        >
          创建新版本
        </UiButton>
      </header>

      <section class="replay-playbook-detail__section">
        <h3>当前正文</h3>
        <pre>{{ playbook.currentVersion?.content || "本版本暂未填写正文。" }}</pre>
        <p>
          变更说明：{{ playbook.currentVersion?.changeSummary || "—" }}
        </p>
      </section>

      <section v-if="mode" class="replay-playbook-detail__section">
        <ReplayPlaybookVersionForm
          :title="mode === 'candidate' ? '采纳候选并创建新版本' : '手工创建新版本'"
          :submit-label="mode === 'candidate' ? '确认采纳并创建版本' : '创建新版本'"
          :draft="mode === 'candidate' ? candidateDraft : manualDraft"
          :loading="
            activeAction === 'create-version' ||
            activeAction === `accept:${activeCandidate?.id}`
          "
          @submit="submitVersion"
          @cancel="cancelVersionForm"
        />
      </section>

      <section class="replay-playbook-detail__section">
        <header class="replay-playbook-detail__section-heading">
          <h3>版本历史</h3>
          <span>{{ versions.length }} 个不可变版本</span>
        </header>
        <div v-if="versions.length" class="replay-playbook-detail__versions">
          <details
            v-for="version in versions"
            :key="version.id"
            :open="version.id === playbook.currentVersion?.id"
          >
            <summary>
              <strong>v{{ version.versionNumber }}</strong>
              <span>{{ version.changeSummary || "未填写变更说明" }}</span>
              <small>{{ formatPlaybookTime(version.createdAt) }}</small>
            </summary>
            <pre>{{ version.content }}</pre>
          </details>
        </div>
        <p v-else class="replay-playbook-detail__empty">
          暂无版本历史。
        </p>
      </section>

      <section class="replay-playbook-detail__section">
        <header class="replay-playbook-detail__section-heading">
          <h3>候选改进</h3>
          <span>{{ candidates.length }} 条</span>
        </header>
        <div v-if="candidates.length" class="replay-playbook-detail__candidates">
          <article
            v-for="candidate in candidates"
            :key="candidate.id"
            class="replay-playbook-detail__candidate"
          >
            <header>
              <span
                :class="`replay-playbook-detail__status--${
                  getCandidateStatusPresentation(candidate.state).tone
                }`"
              >
                {{ getCandidateStatusPresentation(candidate.state).label }}
              </span>
              <small>{{ formatPlaybookTime(candidate.createdAt) }}</small>
            </header>
            <p>{{ getCandidateSuggestion(candidate) || "未提供调整文本" }}</p>
            <small v-if="candidate.reason">
              拒绝原因：{{ candidate.reason }}
            </small>
            <div class="replay-playbook-detail__candidate-actions">
              <UiButton
                v-if="getCandidateSessionId(candidate)"
                type="button"
                size="sm"
                variant="secondary"
                @click="emit('openSource', candidate)"
              >
                打开源演练
              </UiButton>
              <template v-if="candidate.state === 'pending'">
                <UiButton
                  type="button"
                  size="sm"
                  :disabled="Boolean(activeAction)"
                  @click="startAccept(candidate)"
                >
                  采纳并生成版本
                </UiButton>
                <label>
                  <span>拒绝原因（可选）</span>
                  <UiInput
                    v-model="rejectReasons[candidate.id]"
                    maxlength="500"
                    placeholder="可记录不采纳的原因"
                  />
                </label>
                <UiButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  :loading="activeAction === `reject:${candidate.id}`"
                  :disabled="Boolean(activeAction)"
                  @click="
                    emit('rejectCandidate', {
                      candidateId: candidate.id,
                      reason: rejectReasons[candidate.id] || '',
                    })
                  "
                >
                  拒绝
                </UiButton>
              </template>
            </div>
          </article>
        </div>
        <p v-else class="replay-playbook-detail__empty">
          暂无候选改进。复盘中的调整建议需要人工加入，且不会自动修改战法。
        </p>
      </section>
    </template>
  </article>
</template>

<style scoped>
.replay-playbook-detail {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  background: var(--ql-color-bg-surface-strong);
  min-width: 0;
  overflow: hidden;
}

.replay-playbook-detail__header,
.replay-playbook-detail__section-heading {
  align-items: flex-start;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.replay-playbook-detail__header {
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  padding: 1rem;
}

.replay-playbook-detail__header p {
  color: #2563eb;
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  margin: 0;
}

.replay-playbook-detail__header h2 {
  color: var(--ql-color-text-strong);
  font-size: 1.125rem;
  font-weight: 850;
  margin: 0.25rem 0 0;
}

.replay-playbook-detail__section {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
  padding: 1rem;
}

.replay-playbook-detail__section:first-of-type {
  border-top: 0;
}

.replay-playbook-detail__section h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
  font-weight: 800;
  margin: 0 0 0.75rem;
}

.replay-playbook-detail__section > pre,
.replay-playbook-detail__versions pre {
  color: var(--ql-color-text-body);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.7;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.replay-playbook-detail__section > p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  margin: 0.75rem 0 0;
}

.replay-playbook-detail__section-heading {
  margin-bottom: 0.75rem;
}

.replay-playbook-detail__section-heading h3 {
  margin: 0;
}

.replay-playbook-detail__section-heading span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.replay-playbook-detail__versions,
.replay-playbook-detail__candidates {
  display: grid;
  gap: 0.75rem;
}

.replay-playbook-detail__versions details,
.replay-playbook-detail__candidate {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  min-width: 0;
  padding: 0.75rem;
  background: var(--ql-color-bg-muted);
}

.replay-playbook-detail__versions summary {
  align-items: center;
  cursor: pointer;
  display: grid;
  gap: 0.5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.replay-playbook-detail__versions summary span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.replay-playbook-detail__versions summary small {
  color: var(--ql-color-text-subtle);
  font-size: 0.6875rem;
}

.replay-playbook-detail__versions pre {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
  margin-top: 0.75rem;
  padding-top: 0.75rem;
}

.replay-playbook-detail__candidate > header {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.replay-playbook-detail__candidate header > span {
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 800;
  padding: 0.25rem 0.5rem;
}

.replay-playbook-detail__status--warning {
  color: #b45309;
  background: #fef3c7;
}

.replay-playbook-detail__status--success {
  color: #047857;
  background: #d1fae5;
}

.replay-playbook-detail__status--neutral {
  color: var(--ql-color-text-muted);
  background: #e2e8f0;
}

.replay-playbook-detail__candidate header small,
.replay-playbook-detail__candidate > small {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
}

.replay-playbook-detail__candidate > p {
  color: var(--ql-color-text-body);
  font-size: 0.8125rem;
  line-height: 1.65;
  margin: 0.75rem 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.replay-playbook-detail__candidate-actions {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.replay-playbook-detail__candidate-actions label {
  display: grid;
  flex: 1 1 220px;
  gap: 0.25rem;
}

.replay-playbook-detail__candidate-actions label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  font-weight: 700;
}

.replay-playbook-detail__empty {
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.65;
  margin: 0;
  min-height: 8rem;
  padding: 2rem 1rem;
  text-align: center;
}

@media (max-width: 640px) {
  .replay-playbook-detail__header {
    align-items: stretch;
    flex-direction: column;
  }

  .replay-playbook-detail__versions summary {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .replay-playbook-detail__versions summary small {
    grid-column: 1 / -1;
  }
}
</style>
