<script setup>
import { ChevronDown, ChevronUp, ClipboardCheck, LockKeyhole } from "lucide-vue-next";
import { computed, reactive, shallowRef, watch } from "vue";

import {
  buildReplayScoreDimensions,
  buildReplayScoreMetrics,
  buildReplayScoreWeightSnapshot,
  formatReplayScoreMetric,
} from "../../utils/replayScorePresentation.js";
import { getLatestReplayReviewSnapshot } from "../../utils/replayReviewCorrections.js";
import {
  buildReplayBlindReviewPayload,
  buildReplayBlindReviewPrefill,
  formatReplayInvalidationRule,
  formatReplayReasonTags,
  REPLAY_REASON_TAG_OPTIONS,
} from "../../utils/replayReviewPresentation.js";
import ReplayReviewCorrectionForm from "./ReplayReviewCorrectionForm.vue";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";

const props = defineProps({
  session: {
    type: Object,
    required: true,
  },
  savingBlind: {
    type: Boolean,
    default: false,
  },
  savingPost: {
    type: Boolean,
    default: false,
  },
  savingBlindCorrection: {
    type: Boolean,
    default: false,
  },
  savingPostCorrection: {
    type: Boolean,
    default: false,
  },
  playbooks: {
    type: Array,
    default: () => [],
  },
  playbooksLoading: {
    type: Boolean,
    default: false,
  },
  playbooksError: {
    type: String,
    default: "",
  },
  reviewDrafts: {
    type: Object,
    default: () => ({ blind: null, post: null }),
  },
  draftStatuses: {
    type: Object,
    default: () => ({ blind: "unsaved", post: "unsaved" }),
  },
  modal: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "saveBlind",
  "savePost",
  "addBlindCorrection",
  "addPostCorrection",
  "draftChange",
  "deleteDraft",
]);

const blindForm = reactive({
  playbookId: "",
  strategyName: "",
  thesis: "",
  tradePlan: "",
  riskPlan: "",
  confidence: 3,
  reasonTags: [],
  stopLossPrice: null,
  invalidationRule: null,
});
const postForm = reactive({
  outcome: "partial",
  executionReview: "",
  mistakes: "",
  lessons: "",
  disciplineScore: 3,
  riskControlScore: 3,
  playbookFitScore: 3,
  strategyAdjustment: "",
});
const correctionStage = shallowRef("");
const contentCollapsed = shallowRef(false);
let lastBlindDraftSignature = "";
let lastPostDraftSignature = "";

const draftStatusLabels = {
  unsaved: "未保存",
  saving: "保存中",
  saved: "已自动保存",
  failed: "保存失败",
};

const completed = computed(() => props.session.status === "completed");
const revealed = computed(() => Boolean(props.session.revealed));
const review = computed(() => props.session.review ?? {});
const blindReview = computed(() => review.value.blindReview ?? null);
const blindDecisionPrefill = computed(() =>
  buildReplayBlindReviewPrefill(props.session),
);
const postReview = computed(() => review.value.postReview ?? null);
const corrections = computed(() =>
  Array.isArray(props.session.corrections) ? props.session.corrections : [],
);
const latestBlindCorrection = computed(() =>
  corrections.value.filter((item) => item.stage === "blind").at(-1) ?? null,
);
const latestPostCorrection = computed(() =>
  corrections.value.filter((item) => item.stage === "post").at(-1) ?? null,
);
const effectiveBlindReview = computed(() =>
  getLatestReplayReviewSnapshot({
    stage: "blind",
    originalReview: blindReview.value,
    corrections: corrections.value,
  }),
);
const displayedBlindReview = computed(() => {
  if (!effectiveBlindReview.value) return null;
  return {
    ...effectiveBlindReview.value,
    stopLossPrice:
      effectiveBlindReview.value.stopLossPrice ??
      blindDecisionPrefill.value?.stopLossPrice ??
      null,
    invalidationRule:
      effectiveBlindReview.value.invalidationRule ??
      blindDecisionPrefill.value?.invalidationRule ??
      null,
  };
});
const effectivePostReview = computed(() =>
  getLatestReplayReviewSnapshot({
    stage: "post",
    originalReview: postReview.value,
    corrections: corrections.value,
  }),
);
const playbookFitApplicable = computed(
  () =>
    Boolean(effectiveBlindReview.value?.playbookId) &&
    Boolean(effectiveBlindReview.value?.playbookVersionId),
);
const selectedPlaybook = computed(
  () =>
    props.playbooks.find((playbook) => playbook.id === blindForm.playbookId) ??
    null,
);
const linkedVersionReady = computed(
  () =>
    !blindForm.playbookId || Boolean(selectedPlaybook.value?.currentVersion?.id),
);
const scoreCard = computed(() => props.session.scoreCard ?? null);
const blindReady = computed(
  () =>
    linkedVersionReady.value &&
    blindForm.reasonTags.length >= 1 &&
    blindForm.reasonTags.length <= 8 &&
    blindForm.strategyName.trim().length <= 120 &&
    blindForm.thesis.trim().length >= 10 &&
    blindForm.thesis.trim().length <= 2000 &&
    blindForm.tradePlan.trim().length >= 10 &&
    blindForm.tradePlan.trim().length <= 2000 &&
    blindForm.riskPlan.trim().length >= 10 &&
    blindForm.riskPlan.trim().length <= 1000 &&
    Number.isSafeInteger(Number(blindForm.confidence)) &&
    Number(blindForm.confidence) >= 1 &&
    Number(blindForm.confidence) <= 5,
);
const hasBlindDraft = computed(() => Boolean(props.reviewDrafts.blind));
const hasPostDraft = computed(() => Boolean(props.reviewDrafts.post));
const postReady = computed(
  () =>
    ["correct", "partial", "wrong"].includes(postForm.outcome) &&
    postForm.executionReview.trim().length >= 10 &&
    postForm.executionReview.trim().length <= 2000 &&
    postForm.mistakes.trim().length >= 1 &&
    postForm.mistakes.trim().length <= 2000 &&
    postForm.lessons.trim().length >= 10 &&
    postForm.lessons.trim().length <= 2000 &&
    Number.isSafeInteger(Number(postForm.disciplineScore)) &&
    Number(postForm.disciplineScore) >= 1 &&
    Number(postForm.disciplineScore) <= 5 &&
    Number.isSafeInteger(Number(postForm.riskControlScore)) &&
    Number(postForm.riskControlScore) >= 1 &&
    Number(postForm.riskControlScore) <= 5 &&
    (!playbookFitApplicable.value ||
      (Number.isSafeInteger(Number(postForm.playbookFitScore)) &&
        Number(postForm.playbookFitScore) >= 1 &&
        Number(postForm.playbookFitScore) <= 5)) &&
    postForm.strategyAdjustment.trim().length <= 2000,
);

const scoreDimensions = computed(() =>
  buildReplayScoreDimensions(scoreCard.value),
);
const scoreMetrics = computed(() => buildReplayScoreMetrics(scoreCard.value, {
  benchmarkCode: props.session?.benchmarkCode,
}));
const scoreWeightSnapshot = computed(() =>
  buildReplayScoreWeightSnapshot(scoreCard.value),
);
const scoreAlgorithmLabel = computed(
  () => scoreCard.value?.algorithmVersion ?? "旧版评分",
);
const latestCorrectionSnapshot = computed(() => {
  if (!correctionStage.value) {
    return null;
  }
  const snapshot = getLatestReplayReviewSnapshot({
    stage: correctionStage.value,
    originalReview:
      correctionStage.value === "blind"
        ? blindReview.value
        : postReview.value,
    corrections: corrections.value,
  });
  return correctionStage.value === "blind"
    ? displayedBlindReview.value ?? snapshot
    : snapshot;
});

function syncBlindForm() {
  const serverBlindDraft =
    props.session.reviewDrafts?.blind?.data ??
    props.session.reviewDrafts?.blind ??
    null;
  const sourceBlind =
    blindReview.value ??
    props.reviewDrafts.blind ??
    serverBlindDraft ??
    blindDecisionPrefill.value;
  Object.assign(blindForm, {
    playbookId: sourceBlind?.playbookId ?? "",
    strategyName: sourceBlind?.strategyName ?? "",
    thesis: sourceBlind?.thesis ?? "",
    tradePlan: sourceBlind?.tradePlan ?? "",
    riskPlan: sourceBlind?.riskPlan ?? "",
    confidence: sourceBlind?.confidence ?? 3,
    reasonTags: Array.isArray(sourceBlind?.reasonTags)
      ? [...sourceBlind.reasonTags]
      : [],
    stopLossPrice: sourceBlind?.stopLossPrice ?? null,
    invalidationRule: sourceBlind?.invalidationRule ?? null,
  });
  lastBlindDraftSignature = JSON.stringify(buildBlindPayload());
}

function syncPostForm() {
  const serverPostDraft =
    props.session.reviewDrafts?.post?.data ??
    props.session.reviewDrafts?.post ??
    null;
  const postReview =
    review.value.postReview ?? props.reviewDrafts.post ?? serverPostDraft;
  Object.assign(postForm, {
    outcome: postReview?.outcome ?? "partial",
    executionReview: postReview?.executionReview ?? "",
    mistakes: postReview?.mistakes ?? "",
    lessons: postReview?.lessons ?? "",
    disciplineScore: postReview?.disciplineScore ?? 3,
    riskControlScore: postReview?.riskControlScore ?? 3,
    playbookFitScore: postReview?.playbookFitScore ?? 3,
    strategyAdjustment: postReview?.strategyAdjustment ?? "",
  });
  lastPostDraftSignature = JSON.stringify(buildPostPayload());
}

function syncForms() {
  syncBlindForm();
  syncPostForm();
}

function buildBlindPayload() {
  const payload = buildReplayBlindReviewPayload({
    strategyName:
      selectedPlaybook.value?.name ?? blindForm.strategyName.trim(),
    thesis: blindForm.thesis.trim(),
    tradePlan: blindForm.tradePlan.trim(),
    riskPlan: blindForm.riskPlan.trim(),
    confidence: Number(blindForm.confidence),
    reasonTags: [...blindForm.reasonTags].slice(0, 8),
    stopLossPrice: blindForm.stopLossPrice,
    invalidationRule: blindForm.invalidationRule,
  });
  if (selectedPlaybook.value?.currentVersion?.id) {
    payload.playbookId = selectedPlaybook.value.id;
    payload.playbookVersionId = selectedPlaybook.value.currentVersion.id;
  }
  return payload;
}

function buildPostPayload() {
  const payload = {
    outcome: postForm.outcome,
    executionReview: postForm.executionReview.trim(),
    mistakes: postForm.mistakes.trim(),
    lessons: postForm.lessons.trim(),
    disciplineScore: Number(postForm.disciplineScore),
    riskControlScore: Number(postForm.riskControlScore),
  };
  if (playbookFitApplicable.value) {
    payload.playbookFitScore = Number(postForm.playbookFitScore);
    payload.strategyAdjustment = postForm.strategyAdjustment.trim();
  }
  return payload;
}

function submitBlind() {
  if (!completed.value || !blindReady.value || props.savingBlind) {
    return;
  }
  const payload = buildBlindPayload();
  emit("saveBlind", payload);
}

function submitPost() {
  if (!postReady.value || props.savingPost) {
    return;
  }
  emit("savePost", buildPostPayload());
}

function clearDraft(stage) {
  if (stage === "blind") {
    Object.assign(blindForm, {
      playbookId: "",
      strategyName: "",
      thesis: "",
      tradePlan: "",
      riskPlan: "",
      confidence: 3,
      reasonTags: [],
      stopLossPrice: null,
      invalidationRule: null,
    });
    lastBlindDraftSignature = JSON.stringify(buildBlindPayload());
  } else {
    Object.assign(postForm, {
      outcome: "partial",
      executionReview: "",
      mistakes: "",
      lessons: "",
      disciplineScore: 3,
      riskControlScore: 3,
      playbookFitScore: 3,
      strategyAdjustment: "",
    });
    lastPostDraftSignature = JSON.stringify(buildPostPayload());
  }
  emit("deleteDraft", stage);
}

function openCorrection(stage) {
  correctionStage.value = stage;
}

function closeCorrection() {
  correctionStage.value = "";
}

function submitCorrection(payload) {
  if (correctionStage.value === "blind") {
    emit("addBlindCorrection", payload);
    return;
  }
  if (correctionStage.value === "post") {
    emit("addPostCorrection", payload);
  }
}

function formatScore(value) {
  return Number(value ?? 0).toFixed(2).replace(/\.00$/u, "");
}

watch(
  () => props.session.id,
  () => {
    syncForms();
    closeCorrection();
  },
  { immediate: true },
);

watch(
  blindDecisionPrefill,
  (prefill) => {
    const alreadyHasBlindContent =
      blindForm.thesis.trim() ||
      blindForm.tradePlan.trim() ||
      blindForm.riskPlan.trim() ||
      blindForm.reasonTags.length > 0;
    if (
      !prefill ||
      revealed.value ||
      review.value.blindSaved ||
      props.reviewDrafts.blind ||
      props.session.reviewDrafts?.blind ||
      alreadyHasBlindContent
    ) {
      return;
    }
    Object.assign(blindForm, {
      thesis: prefill.thesis,
      tradePlan: prefill.tradePlan,
      riskPlan: prefill.riskPlan,
      confidence: prefill.confidence,
      reasonTags: [...prefill.reasonTags],
    });
  },
  { deep: true },
);

watch(
  () => props.session.reviewDrafts?.blind?.updatedAt ?? "",
  () => {
    if (props.draftStatuses.blind === "saved") {
      syncBlindForm();
    }
  },
);

watch(
  () => props.session.reviewDrafts?.post?.updatedAt ?? "",
  () => {
    if (props.draftStatuses.post === "saved") {
      syncPostForm();
    }
  },
);

watch(
  blindForm,
  () => {
    if (revealed.value || review.value.blindSaved) {
      return;
    }
    const draft = buildBlindPayload();
    const signature = JSON.stringify(draft);
    if (signature === lastBlindDraftSignature) {
      return;
    }
    lastBlindDraftSignature = signature;
    emit("draftChange", { stage: "blind", draft });
  },
  { deep: true },
);

watch(
  postForm,
  () => {
    if (!revealed.value || review.value.postSaved) {
      return;
    }
    const draft = buildPostPayload();
    const signature = JSON.stringify(draft);
    if (signature === lastPostDraftSignature) {
      return;
    }
    lastPostDraftSignature = signature;
    emit("draftChange", { stage: "post", draft });
  },
  { deep: true },
);

watch(
  () => blindForm.playbookId,
  () => {
    if (selectedPlaybook.value) {
      blindForm.strategyName = selectedPlaybook.value.name;
    }
  },
);
</script>

<template>
  <section class="replay-review" :class="{ 'replay-review--modal': modal }" aria-label="行情演练复盘">
    <header v-if="!modal" class="replay-review__header">
      <div>
        <p class="replay-review__eyebrow">两阶段复盘</p>
        <h2 class="replay-review__title">决策记录与评分</h2>
      </div>
      <div class="replay-review__header-actions">
        <ClipboardCheck :size="20" />
        <UiButton
          type="button"
          variant="secondary"
          size="sm"
          class="replay-review__collapse"
          :aria-expanded="!contentCollapsed"
          aria-controls="replay-review-content"
          :aria-label="contentCollapsed ? '展开决策记录与评分' : '折叠决策记录与评分'"
          @click="contentCollapsed = !contentCollapsed"
        >
          <ChevronDown v-if="contentCollapsed" :size="16" />
          <ChevronUp v-else :size="16" />
          <span>{{ contentCollapsed ? "展开" : "折叠" }}</span>
        </UiButton>
      </div>
    </header>

    <div
      v-if="modal || !contentCollapsed"
      id="replay-review-content"
      class="replay-review__content"
    >
      <form
        v-if="!revealed && !review.blindSaved"
        class="replay-review__form"
        @submit.prevent="submitBlind"
      >
      <div class="replay-review__stage-heading">
        <div>
          <span>阶段一</span>
          <h3>揭晓前整局确认</h3>
        </div>
        <span
          class="replay-review__draft-status"
          :class="`replay-review__draft-status--${draftStatuses.blind}`"
          role="status"
        >
          {{ draftStatusLabels[draftStatuses.blind] || "未保存" }}
        </span>
      </div>
      <p class="replay-review__intro">
        演练中即可持续记录。买卖时的判断已经逐笔保存，这里只确认整局结论；如需按某套战法复核，可选择一个参考版本。约 600ms 后自动保存草稿，只有完成演练后才能提交冻结。
      </p>

      <div
        v-if="blindDecisionPrefill && !hasBlindDraft"
        class="replay-review__decision-prefill"
      >
        已自动带入最近一次买入判断，你只需检查并补充整局层面的变化，不必重新抄写。
      </div>

      <label class="replay-review__field">
        <span>参考战法（可选）</span>
        <select v-model="blindForm.playbookId" :disabled="playbooksLoading">
          <option value="">不参考战法 / 自由填写</option>
          <option
            v-for="playbook in playbooks"
            :key="playbook.id"
            :value="playbook.id"
          >
            {{ playbook.name }} · 当前 v{{ playbook.currentVersion?.versionNumber }}
          </option>
        </select>
        <small v-if="playbooksLoading">正在加载战法选项…</small>
        <small v-else-if="playbooksError">
          {{ playbooksError }}
          <template v-if="blindForm.playbookId">
            ；为避免丢失关联，暂不能保存盲评。
          </template>
        </small>
        <small v-else-if="selectedPlaybook">
          本次参考 v{{ selectedPlaybook.currentVersion?.versionNumber }}，保存后冻结
        </small>
        <small v-else-if="blindForm.playbookId">
          参考战法版本无法解析，暂不能保存盲评，避免静默丢失关联。
        </small>
      </label>
      <fieldset class="replay-review__reason-tags">
        <legend>判断理由（至少 1 项，最多 8 项）</legend>
        <label
          v-for="tag in REPLAY_REASON_TAG_OPTIONS"
          :key="tag"
          class="replay-review__reason-tag"
        >
          <input v-model="blindForm.reasonTags" type="checkbox" :value="tag" />
          <span>{{ tag }}</span>
        </label>
      </fieldset>
      <label class="replay-review__field replay-review__field--compact">
        <span>判断信心</span>
        <select v-model.number="blindForm.confidence">
          <option v-for="value in 5" :key="value" :value="value">
            {{ value }} / 5
          </option>
        </select>
      </label>
      <label
        v-if="!selectedPlaybook"
        class="replay-review__field"
      >
        <span>自由填写战法名称（可选）</span>
        <UiInput
          v-model="blindForm.strategyName"
          maxlength="120"
          placeholder="例如：龙头战法"
        />
      </label>
      <label class="replay-review__field">
        <span>整局核心判断</span>
        <textarea
          v-model="blindForm.thesis"
          minlength="10"
          maxlength="2000"
          placeholder="你看到了什么，为什么做出这个判断？"
        />
        <small>{{ blindForm.thesis.trim().length }} / 2000，至少 10 字</small>
      </label>
      <label class="replay-review__field">
        <span>整局交易计划</span>
        <textarea
          v-model="blindForm.tradePlan"
          minlength="10"
          maxlength="2000"
          placeholder="计划如何开仓、持有、减仓或空仓？"
        />
        <small>{{ blindForm.tradePlan.trim().length }} / 2000，至少 10 字</small>
      </label>
      <section class="replay-review__field replay-review__risk-plan">
        <span>整局风险计划</span>
        <textarea
          v-model="blindForm.riskPlan"
          minlength="10"
          maxlength="1000"
          placeholder="什么情况说明判断错误，如何控制损失？"
        />
        <small>{{ blindForm.riskPlan.trim().length }} / 1000，至少 10 字</small>
      </section>
      <div class="replay-review__form-actions">
        <UiButton
          v-if="hasBlindDraft"
          type="button"
          variant="secondary"
          @click="clearDraft('blind')"
        >
          清空盲评草稿
        </UiButton>
        <UiButton
          v-if="completed"
          type="submit"
          :loading="savingBlind"
          :disabled="!blindReady"
        >
          保存并冻结整局盲评
        </UiButton>
        <small v-else>演练进行中：草稿可编辑，完成后才能提交冻结。</small>
      </div>
    </form>

    <div v-else-if="!revealed" class="replay-review__locked-stage">
      <div class="replay-review__stage-heading">
        <div>
          <span>阶段一</span>
          <h3>原始盲评已锁定</h3>
        </div>
        <span class="replay-review__locked">
          <LockKeyhole :size="13" />
          不可覆盖
        </span>
      </div>
      <p class="replay-review__intro">
        原始记录已永久保留。需要补充或纠错时，请追加一条带说明的完整修正快照。
      </p>
      <UiButton
        v-if="correctionStage !== 'blind'"
        type="button"
        variant="secondary"
        size="sm"
        @click="openCorrection('blind')"
      >
        追加修正
      </UiButton>
      <ReplayReviewCorrectionForm
        v-else-if="latestCorrectionSnapshot"
        stage="blind"
        :snapshot="latestCorrectionSnapshot"
        :loading="savingBlindCorrection"
        :editing="false"
        initial-change-note=""
        :playbooks="playbooks"
        :playbooks-loading="playbooksLoading"
        :playbooks-error="playbooksError"
        @cancel="closeCorrection"
        @submit="submitCorrection"
      />
    </div>

    <div v-else class="replay-review__revealed">
      <section class="replay-review__frozen">
        <div class="replay-review__stage-heading">
          <div>
            <span>阶段一</span>
            <h3>揭晓前盲评</h3>
          </div>
          <span class="replay-review__locked">
            <LockKeyhole :size="13" />
            盲评已冻结
          </span>
        </div>
        <p v-if="latestBlindCorrection" class="replay-review__effective-version">
          当前有效版本 · 已修正至第 {{ latestBlindCorrection.revisionNumber }} 版
        </p>
        <dl v-if="displayedBlindReview" class="replay-review__frozen-grid">
          <div>
            <dt>战法名称</dt>
            <dd>{{ displayedBlindReview.strategyName || "未指定" }}</dd>
            <small
              v-if="
                displayedBlindReview.playbookId &&
                displayedBlindReview.playbookVersionNumber
              "
            >
              参考战法 · v{{ displayedBlindReview.playbookVersionNumber }}，已冻结
            </small>
          </div>
          <div>
            <dt>判断信心</dt>
            <dd>{{ displayedBlindReview.confidence }} / 5</dd>
          </div>
          <div>
            <dt>判断理由</dt>
            <dd>{{ formatReplayReasonTags(displayedBlindReview.reasonTags) }}</dd>
          </div>
          <div>
            <dt>止损价</dt>
            <dd>{{ displayedBlindReview.stopLossPrice ?? "未记录" }}</dd>
          </div>
          <div>
            <dt>判断失效条件</dt>
            <dd>
              {{ formatReplayInvalidationRule(displayedBlindReview.invalidationRule) }}
            </dd>
          </div>
          <div>
            <dt>核心判断</dt>
            <dd>{{ displayedBlindReview.thesis }}</dd>
          </div>
          <div>
            <dt>交易计划</dt>
            <dd>{{ displayedBlindReview.tradePlan }}</dd>
          </div>
          <div>
            <dt>风险计划</dt>
            <dd>{{ displayedBlindReview.riskPlan }}</dd>
          </div>
        </dl>
        <div v-else class="replay-review__legacy">
          这是旧版已揭晓会话，当时没有保存盲评；系统不会补写或伪造记录。
        </div>
        <UiButton
          v-if="blindReview && correctionStage !== 'blind'"
          class="replay-review__correction-trigger"
          type="button"
          variant="secondary"
          size="sm"
          @click="openCorrection('blind')"
        >
          追加盲评修正
        </UiButton>
        <ReplayReviewCorrectionForm
          v-else-if="
            correctionStage === 'blind' && latestCorrectionSnapshot
          "
          stage="blind"
          :snapshot="latestCorrectionSnapshot"
          :loading="savingBlindCorrection"
          :editing="false"
          initial-change-note=""
          :playbooks="playbooks"
          :playbooks-loading="playbooksLoading"
          :playbooks-error="playbooksError"
          @cancel="closeCorrection"
          @submit="submitCorrection"
        />
      </section>

      <form
        v-if="!review.postSaved"
        class="replay-review__form"
        @submit.prevent="submitPost"
      >
        <div class="replay-review__stage-heading">
          <div>
            <span>阶段二</span>
            <h3>揭晓后复盘</h3>
          </div>
          <span
            class="replay-review__draft-status"
            :class="`replay-review__draft-status--${draftStatuses.post}`"
            role="status"
          >
            {{ draftStatusLabels[draftStatuses.post] || "未保存" }}
          </span>
        </div>
        <label class="replay-review__field replay-review__field--compact">
          <span>判断结果</span>
          <select v-model="postForm.outcome">
            <option value="correct">正确</option>
            <option value="partial">部分正确</option>
            <option value="wrong">错误</option>
          </select>
        </label>
        <label class="replay-review__field">
          <span>执行复盘</span>
          <textarea
            v-model="postForm.executionReview"
            minlength="10"
            maxlength="2000"
            placeholder="实际执行和原计划有哪些一致或偏离？"
          />
          <small>
            {{ postForm.executionReview.trim().length }} / 2000，至少 10 字
          </small>
        </label>
        <label class="replay-review__field">
          <span>错误与不足</span>
          <textarea
            v-model="postForm.mistakes"
            minlength="1"
            maxlength="2000"
            placeholder="没有明显错误时可填写“无”"
          />
          <small>{{ postForm.mistakes.trim().length }} / 2000</small>
        </label>
        <label class="replay-review__field">
          <span>经验总结</span>
          <textarea
            v-model="postForm.lessons"
            minlength="10"
            maxlength="2000"
            placeholder="下一次遇到类似行情，你会保留或改变什么？"
          />
          <small>{{ postForm.lessons.trim().length }} / 2000，至少 10 字</small>
        </label>
        <div class="replay-review__score-row">
          <label class="replay-review__field replay-review__field--compact">
            <span>执行纪律</span>
            <select v-model.number="postForm.disciplineScore">
              <option v-for="value in 5" :key="value" :value="value">
                {{ value }} / 5
              </option>
            </select>
          </label>
          <label class="replay-review__field replay-review__field--compact">
            <span>风险控制</span>
            <select v-model.number="postForm.riskControlScore">
              <option v-for="value in 5" :key="value" :value="value">
                {{ value }} / 5
              </option>
            </select>
          </label>
        </div>
        <label
          v-if="playbookFitApplicable"
          class="replay-review__field replay-review__field--compact"
        >
          <span>战法复核</span>
          <select v-model.number="postForm.playbookFitScore">
            <option v-for="value in 5" :key="value" :value="value">
              {{ value }} / 5
            </option>
          </select>
        </label>
        <label v-if="playbookFitApplicable" class="replay-review__field">
          <span>战法调整建议（可选）</span>
          <textarea
            v-model="postForm.strategyAdjustment"
            maxlength="2000"
            placeholder="记录你想补充的条件、规则或反例"
          />
          <small>
            候选改进，不会直接修改原战法 ·
            {{ postForm.strategyAdjustment.trim().length }} / 2000
          </small>
        </label>
        <div class="replay-review__form-actions">
          <UiButton
            v-if="hasPostDraft"
            type="button"
            variant="secondary"
            @click="clearDraft('post')"
          >
            清空复盘草稿
          </UiButton>
          <UiButton
            type="submit"
            :loading="savingPost"
            :disabled="!postReady"
          >
            保存原始复盘并评分
          </UiButton>
        </div>
      </form>
      <section v-else class="replay-review__frozen">
        <div class="replay-review__stage-heading">
          <div>
            <span>阶段二</span>
            <h3>原始事后复盘已锁定</h3>
          </div>
          <span class="replay-review__locked">
            <LockKeyhole :size="13" />
            不可覆盖
          </span>
        </div>
        <p class="replay-review__intro">
          原始评分不会改变。后续反思请追加修正，不会重算或覆盖首次评分。
        </p>
        <p v-if="latestPostCorrection" class="replay-review__effective-version">
          当前有效版本 · 已修正至第 {{ latestPostCorrection.revisionNumber }} 版
        </p>
        <dl v-if="effectivePostReview" class="replay-review__frozen-grid">
          <div>
            <dt>判断结果</dt>
            <dd>
              {{
                {
                  correct: "正确",
                  partial: "部分正确",
                  wrong: "错误",
                }[effectivePostReview.outcome] || effectivePostReview.outcome
              }}
            </dd>
          </div>
          <div>
            <dt>执行纪律 / 风险控制</dt>
            <dd>
              {{ effectivePostReview.disciplineScore }} / 5 ·
              {{ effectivePostReview.riskControlScore ?? "旧记录未保存" }} / 5
            </dd>
          </div>
          <div v-if="playbookFitApplicable">
            <dt>战法复核</dt>
            <dd>
              {{
                effectivePostReview.playbookFitScore == null
                  ? "旧记录未保存"
                  : `${effectivePostReview.playbookFitScore} / 5`
              }}
            </dd>
          </div>
          <div>
            <dt>执行复盘</dt>
            <dd>{{ effectivePostReview.executionReview }}</dd>
          </div>
          <div>
            <dt>错误与不足</dt>
            <dd>{{ effectivePostReview.mistakes }}</dd>
          </div>
          <div>
            <dt>经验总结</dt>
            <dd>{{ effectivePostReview.lessons }}</dd>
          </div>
          <div v-if="playbookFitApplicable">
            <dt>战法调整建议</dt>
            <dd>{{ effectivePostReview.strategyAdjustment || "未填写" }}</dd>
          </div>
        </dl>
        <UiButton
          v-if="correctionStage !== 'post'"
          class="replay-review__correction-trigger"
          type="button"
          variant="secondary"
          size="sm"
          @click="openCorrection('post')"
        >
          追加事后复盘修正
        </UiButton>
        <ReplayReviewCorrectionForm
          v-else-if="latestCorrectionSnapshot"
          stage="post"
          :snapshot="latestCorrectionSnapshot"
          :playbook-fit-applicable="playbookFitApplicable"
          :loading="savingPostCorrection"
          :editing="false"
          initial-change-note=""
          @cancel="closeCorrection"
          @submit="submitCorrection"
        />
      </section>

      <section v-if="scoreCard" class="replay-review__score">
        <div class="replay-review__score-total">
          <div>
            <span>本局评分</span>
            <small>算法 {{ scoreAlgorithmLabel }}</small>
          </div>
          <strong>{{ formatScore(scoreCard.total) }}</strong>
          <small>/ 100</small>
        </div>
        <div class="replay-review__score-meta">
          <span>
            权重快照：
            {{
              scoreWeightSnapshot
                .map(
                  (item) =>
                    `${item.label} ${item.weight}${
                      item.applicable ? "" : "（不适用）"
                    }`,
                )
                .join(" · ")
            }}
          </span>
          <span v-if="scoreCard.appliedWeightTotal != null">
            本局适用权重 {{ formatScore(scoreCard.appliedWeightTotal) }} / 100
            <template v-if="scoreCard.rawTotal != null">
              · 原始得分 {{ formatScore(scoreCard.rawTotal) }}
            </template>
          </span>
        </div>
        <div class="replay-review__dimensions">
          <div
            v-for="dimension in scoreDimensions"
            :key="dimension.key"
            class="replay-review__dimension"
          >
            <span>{{ dimension.label }}</span>
            <strong v-if="dimension.applicable">
              {{ formatScore(dimension.value) }}
              <small>/ {{ dimension.maximum }}</small>
            </strong>
            <strong v-else class="replay-review__dimension-na">
              不适用
            </strong>
            <small v-if="!dimension.applicable && dimension.reason">
              {{ dimension.reason }}
            </small>
          </div>
        </div>
        <div class="replay-review__metrics">
          <div v-for="metric in scoreMetrics" :key="metric.key">
            <span>{{ metric.label }}</span>
            <strong>{{ formatReplayScoreMetric(metric) }}</strong>
          </div>
        </div>
      </section>
    </div>
    </div>
  </section>
</template>

<style scoped>
.replay-review {
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--ql-line-strong);
  border-radius: 12px;
  background: var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-xs);
}

.replay-review--modal {
  overflow: visible;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.replay-review__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ql-line);
}

.replay-review__header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.replay-review__header-actions > svg {
  color: var(--ql-accent);
}

.replay-review__collapse {
  min-height: 28px;
}

.replay-review__eyebrow,
.replay-review__title {
  margin: 0;
}

.replay-review__eyebrow {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.replay-review__title {
  margin-top: 1px;
  font-size: 16px;
  font-weight: 750;
  letter-spacing: -0.02em;
}

.replay-review__waiting,
.replay-review__legacy,
.replay-review__locked-stage {
  padding: 20px;
  color: var(--ql-color-text-muted);
  background: var(--ql-paper-soft);
}

.replay-review__locked-stage {
  display: grid;
  gap: 10px;
  padding: 14px;
}

.replay-review__waiting p {
  max-width: 720px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
}

.replay-review__form,
.replay-review__frozen,
.replay-review__score {
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 14px;
}

.replay-review__frozen {
  display: flex;
  flex-direction: column;
}

.replay-review__revealed {
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
}

.replay-review__revealed > * {
  min-width: 0;
}

.replay-review__revealed > :nth-child(2) {
  border-top: 1px solid var(--ql-line);
}

.replay-review__correction-trigger {
  align-self: end;
  width: 100%;
  min-height: 42px;
  margin-top: auto;
}

.replay-review__stage-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.replay-review__stage-heading span {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.replay-review__stage-heading h3 {
  margin: 2px 0 0;
  font-size: 14px;
}

.replay-review__saved,
.replay-review__locked {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 999px;
}

.replay-review__saved {
  color: #047857;
  background: var(--ql-color-success-soft);
}

.replay-review__draft-status {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--ql-color-text-muted);
  background: var(--ql-paper-soft);
  font-size: 10px;
  font-weight: 700;
}

.replay-review__draft-status--saving {
  color: #0369a1;
  background: var(--ql-color-info-soft);
}

.replay-review__draft-status--saved {
  color: #047857;
  background: var(--ql-color-success-soft);
}

.replay-review__draft-status--failed {
  color: #b91c1c;
  background: var(--ql-color-danger-soft);
}

.replay-review__locked {
  color: var(--ql-color-text-muted);
  background: var(--ql-paper-soft);
}

.replay-review__intro {
  margin: -5px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.replay-review__effective-version {
  margin: 0;
  color: var(--ql-accent);
  font-size: 10px;
  font-weight: 700;
}

.replay-review__decision-prefill {
  padding: 9px 11px;
  border: 1px solid rgba(16, 185, 129, 0.22);
  border-radius: 8px;
  color: #047857;
  background: var(--ql-color-success-soft);
  font-size: 11px;
  line-height: 1.55;
}

.replay-review__training-lock {
  display: grid;
  gap: 5px;
  padding: 11px 12px;
  border: 1px solid rgba(15, 82, 186, 0.15);
  border-radius: 8px;
  background: var(--ql-color-primary-soft);
}

.replay-review__training-lock span,
.replay-review__training-lock small {
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

.replay-review__training-lock strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.replay-review__not-applicable {
  min-height: 38px;
  padding: 10px;
  border: 1px dashed var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  background: var(--ql-paper-soft);
  font-size: 11px;
}

.replay-review__field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.replay-review__field > span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.replay-review__field textarea,
.replay-review__field select {
  width: 100%;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-ink);
  background: var(--ql-color-bg-surface-strong);
  font: inherit;
  outline: none;
}

.replay-review__field textarea {
  min-height: 72px;
  resize: vertical;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
}

.replay-review__field select {
  min-height: 34px;
  padding: 0 10px;
  font-size: 12px;
}

.replay-review__field textarea:focus,
.replay-review__field select:focus {
  border-color: var(--ql-accent);
  box-shadow: 0 0 0 3px var(--ql-color-primary-soft);
}

.replay-review__field small {
  color: var(--ql-color-text-subtle);
  font-size: 10px;
  text-align: right;
}

.replay-review__field--compact {
  max-width: 260px;
}

.replay-review__score-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.replay-review__score-row .replay-review__field--compact {
  max-width: none;
}

.replay-review__reason-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  padding: 0;
  border: 0;
}

.replay-review__reason-tags legend {
  width: 100%;
  margin-bottom: 1px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
}

.replay-review__reason-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--ql-line);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 11px;
}

.replay-review__form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
}

.replay-review__form-actions small {
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

.replay-review__frozen-grid {
  display: grid;
  gap: 12px;
  margin: 0;
}

.replay-review__frozen-grid > div {
  padding: 11px 12px;
  border-radius: 8px;
  background: var(--ql-paper-soft);
}

.replay-review__frozen-grid dt {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.replay-review__frozen-grid dd {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.replay-review__frozen-grid small {
  color: var(--ql-color-text-muted);
  display: block;
  font-size: 10px;
  font-weight: 700;
  margin-top: 6px;
}

.replay-review__legacy {
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.7;
}

.replay-review__score {
  order: -1;
  grid-column: 1 / -1;
  border-bottom: 1px solid var(--ql-line);
  background: var(--ql-color-bg-surface-strong);
}

.replay-review__score-total {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.replay-review__score-total > div {
  margin-right: auto;
}

.replay-review__score-total span,
.replay-review__score-total > div small {
  display: block;
  color: var(--ql-color-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.replay-review__score-total > div small {
  margin-top: 3px;
  font-size: 9px;
  font-weight: 500;
}

.replay-review__score-total strong {
  color: var(--ql-accent);
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 34px;
}

.replay-review__score-total small {
  color: var(--ql-color-text-muted);
  font-size: 12px;
}

.replay-review__score-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 16px;
  color: var(--ql-color-text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.replay-review__dimensions,
.replay-review__metrics {
  display: grid;
  gap: 8px;
}

.replay-review__dimensions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.replay-review__metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.replay-review__dimension,
.replay-review__metrics > div {
  display: grid;
  gap: 6px;
  padding: 11px;
  border: 1px solid var(--ql-line);
  border-radius: 8px;
  background: var(--ql-color-bg-glass);
}

.replay-review__dimension span,
.replay-review__metrics span {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.replay-review__dimension strong,
.replay-review__metrics strong {
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 14px;
}

.replay-review__dimension small {
  color: var(--ql-color-text-subtle);
  font-size: 9px;
}

.replay-review__dimension-na {
  color: var(--ql-color-text-muted);
}

@media (max-width: 980px) {
  .replay-review__revealed {
    grid-template-columns: 1fr;
  }

  .replay-review__revealed > :nth-child(2) {
    border-top: 1px solid var(--ql-line);
    border-left: 0;
  }

}

@media (max-width: 760px) {
  .replay-review__form,
  .replay-review__frozen,
  .replay-review__score {
    padding: 14px;
  }

  .replay-review__field--compact {
    max-width: none;
  }

  .replay-review__score-row {
    grid-template-columns: 1fr;
  }

  .replay-review__form-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .replay-review__dimensions,
  .replay-review__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
