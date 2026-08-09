<script setup>
import { reactive, watch } from "vue";

import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiSelect from "../ui/UiSelect.vue";

const props = defineProps({
  state: {
    type: String,
    default: "all",
  },
  keyword: {
    type: String,
    default: "",
  },
  attemptKind: {
    type: String,
    default: "all",
  },
  loading: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["apply", "refresh"]);
const filters = reactive({
  state: props.state,
  attemptKind: props.attemptKind,
  keyword: props.keyword,
});

watch(
  () => [props.state, props.attemptKind, props.keyword],
  ([state, attemptKind, keyword]) => {
    filters.state = state;
    filters.attemptKind = attemptKind;
    filters.keyword = keyword;
  },
);

function submit() {
  emit("apply", {
    state: filters.state,
    attemptKind: filters.attemptKind,
    keyword: filters.keyword,
  });
}
</script>

<template>
  <form class="replay-history-filters" @submit.prevent="submit">
    <label>
      <span>状态筛选</span>
      <UiSelect v-model="filters.state" size="sm">
        <option value="all">全部状态</option>
        <option value="active">演练中</option>
        <option value="awaiting_blind">待盲评</option>
        <option value="skipped">主动空仓</option>
        <option value="awaiting_reveal">待揭晓</option>
        <option value="awaiting_post">待事后复盘</option>
        <option value="reviewed">已评分</option>
      </UiSelect>
    </label>
    <label>
      <span>演练次数</span>
      <UiSelect v-model="filters.attemptKind" size="sm">
        <option value="all">全部次数</option>
        <option value="first">首次盲测</option>
        <option value="retrain">已知复练</option>
      </UiSelect>
    </label>
    <label class="replay-history-filters__keyword">
      <span>关键词</span>
      <UiInput
        v-model="filters.keyword"
        size="sm"
        type="search"
        placeholder="会话编号、复盘内容或已揭晓标的"
      />
    </label>
    <div class="replay-history-filters__actions">
      <UiButton type="submit" size="sm" :loading="loading">
        查询
      </UiButton>
      <UiButton
        type="button"
        size="sm"
        variant="secondary"
        :disabled="loading"
        @click="emit('refresh')"
      >
        刷新
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.replay-history-filters {
  align-items: end;
  display: grid;
  gap: 0.75rem;
  grid-template-columns:
    minmax(130px, 0.38fr)
    minmax(130px, 0.38fr)
    minmax(220px, 1fr)
    auto;
}

.replay-history-filters label {
  display: grid;
  gap: 0.375rem;
}

.replay-history-filters label > span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.replay-history-filters__actions {
  display: flex;
  gap: 0.5rem;
}

@media (max-width: 720px) {
  .replay-history-filters {
    grid-template-columns: 1fr;
  }

  .replay-history-filters__actions :deep(button) {
    flex: 1;
  }
}
</style>
