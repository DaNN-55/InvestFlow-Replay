<script setup>
import { computed, reactive, watch } from "vue";

import { buildReplayReviewCorrectionPayload } from "../../utils/replayReviewCorrections.js";
import { REPLAY_REASON_TAG_OPTIONS } from "../../utils/replayReviewPresentation.js";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";

const props = defineProps({
  stage: {
    type: String,
    required: true,
    validator: (value) => ["blind", "post"].includes(value),
  },
  snapshot: {
    type: Object,
    required: true,
  },
  playbookFitApplicable: {
    type: Boolean,
    default: false,
  },
  playbooks: { type: Array, default: () => [] },
  playbooksLoading: { type: Boolean, default: false },
  playbooksError: { type: String, default: "" },
  loading: {
    type: Boolean,
    default: false,
  },
  editing: {
    type: Boolean,
    default: false,
  },
  initialChangeNote: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["cancel", "submit"]);

const form = reactive({
  playbookId: "",
  playbookVersionId: "",
  strategyName: "",
  thesis: "",
  tradePlan: "",
  riskPlan: "",
  confidence: 3,
  reasonTags: [],
  outcome: "partial",
  executionReview: "",
  mistakes: "",
  lessons: "",
  disciplineScore: 3,
  riskControlScore: 3,
  playbookFitScore: 3,
  strategyAdjustment: "",
  changeNote: "",
});

const isBlind = computed(() => props.stage === "blind");
const ready = computed(() => {
  const changeNoteReady =
    form.changeNote.trim().length >= 1 &&
    form.changeNote.trim().length <= 500;
  if (!changeNoteReady) {
    return false;
  }
  if (isBlind.value) {
    return (
      form.reasonTags.length >= 1 &&
      form.reasonTags.length <= 8 &&
      form.strategyName.trim().length <= 120 &&
      form.thesis.trim().length >= 10 &&
      form.thesis.trim().length <= 2000 &&
      form.tradePlan.trim().length >= 10 &&
      form.tradePlan.trim().length <= 2000 &&
      form.riskPlan.trim().length >= 10 &&
      form.riskPlan.trim().length <= 1000 &&
      Number.isSafeInteger(Number(form.confidence)) &&
      Number(form.confidence) >= 1 &&
      Number(form.confidence) <= 5
    );
  }
  return (
    ["correct", "partial", "wrong"].includes(form.outcome) &&
    form.executionReview.trim().length >= 10 &&
    form.executionReview.trim().length <= 2000 &&
    form.mistakes.trim().length >= 1 &&
    form.mistakes.trim().length <= 2000 &&
    form.lessons.trim().length >= 10 &&
    form.lessons.trim().length <= 2000 &&
    Number.isSafeInteger(Number(form.disciplineScore)) &&
    Number(form.disciplineScore) >= 1 &&
    Number(form.disciplineScore) <= 5 &&
    Number.isSafeInteger(Number(form.riskControlScore)) &&
    Number(form.riskControlScore) >= 1 &&
    Number(form.riskControlScore) <= 5 &&
    (!props.playbookFitApplicable ||
      (Number.isSafeInteger(Number(form.playbookFitScore)) &&
        Number(form.playbookFitScore) >= 1 &&
        Number(form.playbookFitScore) <= 5)) &&
    form.strategyAdjustment.trim().length <= 2000
  );
});

function syncForm() {
  Object.assign(form, {
    playbookId: props.snapshot.playbookId ?? "",
    playbookVersionId: props.snapshot.playbookVersionId ?? "",
    strategyName: props.snapshot.strategyName ?? "",
    thesis: props.snapshot.thesis ?? "",
    tradePlan: props.snapshot.tradePlan ?? "",
    riskPlan: props.snapshot.riskPlan ?? "",
    confidence: props.snapshot.confidence ?? 3,
    reasonTags: Array.isArray(props.snapshot.reasonTags)
      ? [...props.snapshot.reasonTags]
      : [],
    outcome: props.snapshot.outcome ?? "partial",
    executionReview: props.snapshot.executionReview ?? "",
    mistakes: props.snapshot.mistakes ?? "",
    lessons: props.snapshot.lessons ?? "",
    disciplineScore: props.snapshot.disciplineScore ?? 3,
    riskControlScore: props.snapshot.riskControlScore ?? 3,
    playbookFitScore: props.snapshot.playbookFitScore ?? 3,
    strategyAdjustment: props.snapshot.strategyAdjustment ?? "",
    changeNote: props.initialChangeNote,
  });
}

function changePlaybook() {
  const playbook = props.playbooks.find((item) => item.id === form.playbookId);
  form.playbookVersionId = playbook?.currentVersion?.id ?? "";
  if (playbook) form.strategyName = playbook.name ?? "";
  if (!form.playbookId) form.strategyName = "";
}

function submit() {
  if (!ready.value || props.loading) {
    return;
  }
  const payload = buildReplayReviewCorrectionPayload({
    stage: props.stage,
    snapshot: props.snapshot,
    form,
    playbookFitApplicable: props.playbookFitApplicable,
  });
  emit("submit", payload);
}

watch(
  () => [props.stage, props.snapshot],
  syncForm,
  { immediate: true },
);
</script>

<template>
  <form class="replay-correction" @submit.prevent="submit">
    <header>
      <div>
        <h3>{{ editing ? "修改" : "追加" }}{{ isBlind ? "盲评" : "事后复盘" }}修正</h3>
        <p v-if="editing">保存后会更新这条修正记录，原始盲评与原始评分不变。</p>
        <p v-else>已按原记录或最新修正预填。提交后会新增快照，不覆盖原始记录。</p>
      </div>
    </header>

    <template v-if="isBlind">
      <label class="replay-correction__field">
        <span>参考战法（可选）</span>
        <select v-model="form.playbookId" :disabled="playbooksLoading" @change="changePlaybook">
          <option value="">不关联战法</option>
          <option v-for="playbook in playbooks" :key="playbook.id" :value="playbook.id">
            {{ playbook.name }} · v{{ playbook.currentVersion?.versionNumber ?? "—" }}
          </option>
        </select>
        <small v-if="playbooksError">{{ playbooksError }}</small>
      </label>
      <label class="replay-correction__field">
        <span>战法名称（可选）</span>
        <UiInput v-model="form.strategyName" maxlength="120" />
      </label>
      <label class="replay-correction__field">
        <span>核心判断</span>
        <textarea v-model="form.thesis" minlength="10" maxlength="2000" />
      </label>
      <fieldset class="replay-correction__tags">
        <legend>判断理由</legend>
        <label v-for="tag in REPLAY_REASON_TAG_OPTIONS" :key="tag">
          <input v-model="form.reasonTags" type="checkbox" :value="tag" />
          <span>{{ tag }}</span>
        </label>
      </fieldset>
      <label class="replay-correction__field replay-correction__field--compact">
        <span>判断信心</span>
        <select v-model.number="form.confidence">
          <option v-for="value in 5" :key="value" :value="value">
            {{ value }} / 5
          </option>
        </select>
      </label>
      <label class="replay-correction__field">
        <span>交易计划</span>
        <textarea v-model="form.tradePlan" minlength="10" maxlength="2000" />
      </label>
      <section class="replay-correction__field replay-correction__risk-plan">
        <span>风险计划</span>
        <textarea v-model="form.riskPlan" minlength="10" maxlength="1000" />
      </section>
    </template>

    <template v-else>
      <label class="replay-correction__field replay-correction__field--compact">
        <span>判断结果</span>
        <select v-model="form.outcome">
          <option value="correct">正确</option>
          <option value="partial">部分正确</option>
          <option value="wrong">错误</option>
        </select>
      </label>
      <label class="replay-correction__field">
        <span>执行复盘</span>
        <textarea
          v-model="form.executionReview"
          minlength="10"
          maxlength="2000"
        />
      </label>
      <label class="replay-correction__field">
        <span>错误与不足</span>
        <textarea v-model="form.mistakes" minlength="1" maxlength="2000" />
      </label>
      <label class="replay-correction__field">
        <span>经验总结</span>
        <textarea v-model="form.lessons" minlength="10" maxlength="2000" />
      </label>
      <label class="replay-correction__field replay-correction__field--compact">
        <span>执行纪律</span>
        <select v-model.number="form.disciplineScore">
          <option v-for="value in 5" :key="value" :value="value">
            {{ value }} / 5
          </option>
        </select>
      </label>
      <label class="replay-correction__field replay-correction__field--compact">
        <span>风险控制</span>
        <select v-model.number="form.riskControlScore">
          <option v-for="value in 5" :key="value" :value="value">
            {{ value }} / 5
          </option>
        </select>
      </label>
      <label
        v-if="playbookFitApplicable"
        class="replay-correction__field replay-correction__field--compact"
      >
        <span>战法复核</span>
        <select v-model.number="form.playbookFitScore">
          <option v-for="value in 5" :key="value" :value="value">
            {{ value }} / 5
          </option>
        </select>
      </label>
      <label v-if="playbookFitApplicable" class="replay-correction__field">
        <span>战法调整建议（可选）</span>
        <textarea v-model="form.strategyAdjustment" maxlength="2000" />
      </label>
    </template>

    <label class="replay-correction__field">
      <span>修正说明（必填）</span>
      <textarea
        v-model="form.changeNote"
        minlength="1"
        maxlength="500"
        placeholder="说明为什么需要修正，以及这次改了什么"
      />
      <small>{{ form.changeNote.trim().length }} / 500</small>
    </label>

    <footer>
      <UiButton type="button" variant="secondary" @click="emit('cancel')">
        取消
      </UiButton>
      <UiButton type="submit" :loading="loading" :disabled="!ready">
        保存为新修正
      </UiButton>
    </footer>
  </form>
</template>

<style scoped>
.replay-correction {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid rgba(37, 99, 235, 0.18);
  border-radius: 10px;
  background: var(--ql-color-primary-soft);
}

.replay-correction header h3,
.replay-correction header p {
  margin: 0;
}

.replay-correction header h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
}

.replay-correction header p {
  margin-top: 0.25rem;
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  line-height: 1.5;
}

.replay-correction__field {
  display: grid;
  gap: 0.35rem;
}

.replay-correction__field > span {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  font-weight: 700;
}

.replay-correction__field textarea,
.replay-correction__field select {
  width: 100%;
  border: 1px solid rgba(15, 23, 42, 0.15);
  border-radius: 7px;
  color: var(--ql-color-text-strong);
  background: var(--ql-color-bg-surface-strong);
  font: inherit;
}

.replay-correction__field textarea {
  min-height: 78px;
  padding: 0.6rem;
  resize: vertical;
  font-size: 0.75rem;
  line-height: 1.55;
}

.replay-correction__field select {
  min-height: 36px;
  padding: 0 0.55rem;
  font-size: 0.75rem;
}

.replay-correction__field small {
  color: var(--ql-color-text-muted);
  font-size: 0.625rem;
  text-align: right;
}

.replay-correction__field--compact {
  max-width: 260px;
}

.replay-correction__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  border: 0;
}

.replay-correction__tags legend {
  width: 100%;
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  font-weight: 700;
}

.replay-correction__tags label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 34px;
  padding: 0.4rem 0.55rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 7px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 0.6875rem;
}

.replay-correction__na {
  padding: 0.6rem;
  border: 1px dashed rgba(15, 23, 42, 0.15);
  border-radius: 7px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  font-size: 0.75rem;
}

.replay-correction footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

@media (max-width: 640px) {
  .replay-correction__field--compact {
    max-width: none;
  }

}
</style>
