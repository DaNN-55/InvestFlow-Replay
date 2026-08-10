<script setup>
import {
  computed,
  reactive,
  shallowRef,
  watch,
} from "vue";
import { Ellipsis, Pencil, Trash2 } from "lucide-vue-next";

import { getPlaybookVersionNumber } from "../../utils/replayPlaybookPresentation.js";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  selectedId: {
    type: String,
    default: "",
  },
  loading: {
    type: Boolean,
    default: false,
  },
  creating: {
    type: Boolean,
    default: false,
  },
  createSuccessToken: {
    type: Number,
    default: 0,
  },
  activeAction: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["select", "create", "rename", "delete"]);

const showCreateForm = shallowRef(false);
const form = reactive({
  name: "",
  content: "",
  changeSummary: "",
});
const ready = computed(
  () =>
    form.name.trim().length >= 1 &&
    form.name.trim().length <= 120 &&
    form.content.length <= 12000 &&
    form.changeSummary.trim().length >= 1 &&
    form.changeSummary.trim().length <= 500,
);

function submit() {
  if (!ready.value || props.creating) {
    return;
  }
  emit("create", {
    name: form.name.trim(),
    content: form.content.trim(),
    changeSummary: form.changeSummary.trim(),
  });
}

function resetForm() {
  Object.assign(form, { name: "", content: "", changeSummary: "" });
  showCreateForm.value = false;
}

function chooseAction(action, item) {
  emit(action, item);
}

watch(
  () => props.createSuccessToken,
  (current, previous) => {
    if (current !== previous) {
      resetForm();
    }
  },
);
</script>

<template>
  <aside class="replay-playbook-list">
    <header>
      <div>
        <h2>战法库</h2>
        <p>每次调整都创建新版本，历史内容不会被覆盖。</p>
      </div>
      <UiButton
        type="button"
        size="sm"
        variant="secondary"
        @click="showCreateForm = !showCreateForm"
      >
        {{ showCreateForm ? "收起" : "新建战法" }}
      </UiButton>
    </header>

    <form
      v-if="showCreateForm"
      class="replay-playbook-list__create"
      @submit.prevent="submit"
    >
      <label>
        <span>战法名称</span>
        <UiInput
          v-model="form.name"
          maxlength="120"
          placeholder="例如：趋势回踩战法"
        />
      </label>
      <label>
        <span>首版正文</span>
        <textarea
          v-model="form.content"
          maxlength="12000"
          placeholder="记录适用条件、入场、退出与风控规则"
        />
      </label>
      <label>
        <span>变更说明</span>
        <UiInput
          v-model="form.changeSummary"
          maxlength="500"
          placeholder="例如：建立首版规则"
        />
      </label>
      <div>
        <UiButton
          type="submit"
          size="sm"
          :loading="creating"
          :disabled="!ready || creating"
        >
          创建
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          :disabled="creating"
          @click="resetForm"
        >
          取消
        </UiButton>
      </div>
    </form>

    <p v-if="loading && !items.length" class="replay-playbook-list__empty">
      正在加载战法库…
    </p>
    <div v-else-if="items.length" class="replay-playbook-list__items">
      <div
        v-for="item in items"
        :key="item.id"
        class="replay-playbook-list__item"
        :class="{ 'replay-playbook-list__item--active': item.id === selectedId }"
      >
        <button
          type="button"
          class="replay-playbook-list__select"
          @click="emit('select', item)"
        >
          <strong>{{ item.name }}</strong>
          <small>当前 v{{ getPlaybookVersionNumber(item) }}</small>
        </button>
        <div class="replay-playbook-list__tail">
          <em v-if="Number(item.pendingCandidateCount ?? 0) > 0">
            {{ Number(item.pendingCandidateCount ?? 0) }} 条候选改进
          </em>
          <UiActionMenu
            class="replay-playbook-list__menu"
            label="战法操作"
            :disabled="Boolean(activeAction)"
            :min-width="128"
            :trigger-size="28"
          >
            <template #trigger><Ellipsis :size="16" /></template>
            <button class="ui-action-menu__item" type="button" @click="chooseAction('rename', item)">
              <Pencil :size="14" />修改名称
            </button>
            <button class="ui-action-menu__item ui-action-menu__item--danger" type="button" @click="chooseAction('delete', item)">
              <Trash2 :size="14" />删除战法
            </button>
          </UiActionMenu>
        </div>
      </div>
    </div>
    <p v-else class="replay-playbook-list__empty">
      暂无战法。可从上方新建首个战法。
    </p>
  </aside>
</template>

<style scoped>
.replay-playbook-list {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  background: var(--ql-color-bg-surface-strong);
  min-width: 0;
  overflow: visible;
}

.replay-playbook-list > header {
  align-items: flex-start;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  padding: 1rem;
}

.replay-playbook-list h2 {
  color: var(--ql-color-text-strong);
  font-size: 0.9375rem;
  font-weight: 800;
  margin: 0;
}

.replay-playbook-list header p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  margin: 0.25rem 0 0;
}

.replay-playbook-list__create {
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--ql-color-bg-muted);
}

.replay-playbook-list__create label {
  display: grid;
  gap: 0.375rem;
}

.replay-playbook-list__create label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 750;
}

.replay-playbook-list__create textarea {
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 8px;
  color: var(--ql-color-text-strong);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.6;
  min-height: 120px;
  padding: 0.75rem;
  resize: vertical;
  width: 100%;
}

.replay-playbook-list__create > div {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.replay-playbook-list__items {
  display: grid;
  padding: 0.5rem;
}

.replay-playbook-list__item {
  align-items: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--ql-color-text-body);
  background: transparent;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  min-width: 0;
  padding: 0.75rem;
  text-align: left;
}

.replay-playbook-list__item:hover {
  background: var(--ql-color-bg-muted);
}

.replay-playbook-list__item--active {
  border-color: #bfdbfe;
  background: var(--ql-color-primary-soft);
}

.replay-playbook-list__select {
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  display: grid;
  flex: 1 1 auto;
  gap: 0.25rem;
  min-width: 0;
  padding: 0;
  text-align: left;
}

.replay-playbook-list__item strong {
  overflow-wrap: anywhere;
}

.replay-playbook-list__item small {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
}

.replay-playbook-list__tail {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 0.25rem;
}

.replay-playbook-list__tail em {
  border-radius: 999px;
  color: #b45309;
  background: var(--ql-color-warning-soft);
  flex: 0 0 auto;
  font-size: 0.6875rem;
  font-style: normal;
  font-weight: 750;
  padding: 0.25rem 0.5rem;
}


.replay-playbook-list__empty {
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
  margin: 0;
  padding: 2rem 1rem;
  text-align: center;
}
</style>
