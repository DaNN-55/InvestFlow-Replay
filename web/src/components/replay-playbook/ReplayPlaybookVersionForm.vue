<script setup>
import { computed, reactive, watch } from "vue";

import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";

const props = defineProps({
  title: {
    type: String,
    default: "创建新版本",
  },
  submitLabel: {
    type: String,
    default: "创建新版本",
  },
  draft: {
    type: Object,
    required: true,
  },
  loading: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["submit", "cancel"]);

const form = reactive({
  expectedVersionNumber: 0,
  content: "",
  changeSummary: "",
});

const ready = computed(
  () =>
    Number.isSafeInteger(Number(form.expectedVersionNumber)) &&
    Number(form.expectedVersionNumber) >= 1 &&
    form.content.length <= 12000 &&
    form.changeSummary.trim().length >= 1 &&
    form.changeSummary.trim().length <= 500,
);

function syncDraft() {
  Object.assign(form, {
    expectedVersionNumber: Number(props.draft.expectedVersionNumber ?? 0),
    content: String(props.draft.content ?? ""),
    changeSummary: String(props.draft.changeSummary ?? ""),
  });
}

function submit() {
  if (!ready.value || props.loading) {
    return;
  }
  emit("submit", {
    expectedVersionNumber: Number(form.expectedVersionNumber),
    content: form.content.trim(),
    changeSummary: form.changeSummary.trim(),
  });
}

watch(() => props.draft, syncDraft, { immediate: true, deep: true });
</script>

<template>
  <form
    class="replay-playbook-version-form"
    :aria-label="title"
    @submit.prevent="submit"
  >
    <header>
      <div>
        <h4>{{ title }}</h4>
        <p>
          基于 v{{ form.expectedVersionNumber }} 创建；保存后旧版本不可覆盖。
        </p>
      </div>
    </header>

    <label>
      <span>完整新正文</span>
      <textarea
        v-model="form.content"
        maxlength="12000"
        placeholder="填写这个版本的完整战法规则"
      />
      <small>{{ form.content.length }} / 12000</small>
    </label>
    <label>
      <span>变更说明</span>
      <UiInput
        v-model="form.changeSummary"
        maxlength="500"
        placeholder="简要说明这一版改了什么"
      />
    </label>
    <div class="replay-playbook-version-form__actions">
      <UiButton
        type="submit"
        size="sm"
        :loading="loading"
        :disabled="!ready || loading"
      >
        {{ submitLabel }}
      </UiButton>
      <UiButton
        type="button"
        size="sm"
        variant="secondary"
        :disabled="loading"
        @click="emit('cancel')"
      >
        取消
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.replay-playbook-version-form {
  border: 1px solid var(--ql-color-border-strong);
  border-radius: 10px;
  display: grid;
  gap: 0.875rem;
  min-width: 0;
  padding: 1rem;
  background: var(--ql-color-primary-soft);
}

.replay-playbook-version-form h4 {
  color: var(--ql-color-text-strong);
  background: var(--ql-color-bg-surface-strong);
  font-size: 0.875rem;
  font-weight: 800;
  margin: 0;
}

.replay-playbook-version-form header p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}

.replay-playbook-version-form label {
  display: grid;
  gap: 0.375rem;
  min-width: 0;
}

.replay-playbook-version-form label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 750;
}

.replay-playbook-version-form textarea {
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 8px;
  color: var(--ql-color-text-strong);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.65;
  min-height: 180px;
  padding: 0.75rem;
  resize: vertical;
  width: 100%;
}

.replay-playbook-version-form textarea:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  outline: none;
}

.replay-playbook-version-form small {
  color: var(--ql-color-text-subtle);
  font-size: 0.6875rem;
  text-align: right;
}

.replay-playbook-version-form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
