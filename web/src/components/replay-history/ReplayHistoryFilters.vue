<script setup>
import { onBeforeUnmount, reactive, watch } from "vue";

import UiInput from "../ui/UiInput.vue";
import UiSelect from "../ui/UiSelect.vue";

const props = defineProps({
  market: { type: String, default: 'all' },
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

const emit = defineEmits(["apply"]);
const filters = reactive({
  market: props.market,
  state: props.state,
  attemptKind: props.attemptKind,
  keyword: props.keyword,
});
let keywordTimer;
let composing = false;
let submittedKey = "";

function clearKeywordTimer() {
  window.clearTimeout(keywordTimer);
}

watch(
  () => [props.state, props.attemptKind, props.keyword, props.market],
  ([state, attemptKind, keyword, market]) => {
    clearKeywordTimer();
    filters.market = market;
    filters.state = state;
    filters.attemptKind = attemptKind;
    filters.keyword = keyword;
  },
);

function submit() {
  clearKeywordTimer();
  if (composing) return;
  const next = {
    market: filters.market,
    state: filters.state,
    attemptKind: filters.attemptKind,
    keyword: filters.keyword,
  };
  const key = JSON.stringify(next);
  if (props.loading && key === submittedKey) return;
  submittedKey = key;
  emit("apply", next);
}

function selectFilter(key, value) {
  filters[key] = value;
  submit();
}

function updateKeyword(value) {
  filters.keyword = value;
  clearKeywordTimer();
  if (!composing) keywordTimer = window.setTimeout(submit, 300);
}

function finishComposition() {
  composing = false;
  updateKeyword(filters.keyword);
}

onBeforeUnmount(clearKeywordTimer);
</script>

<template>
  <form class="replay-history-filters" :aria-busy="loading" @submit.prevent="submit">
    <UiSelect :model-value="filters.market" size="sm" aria-label="演练市场筛选" @update:model-value="selectFilter('market', $event)">
      <option value="all">全部市场</option>
      <option value="ashare">A股</option>
      <option value="crypto-perpetual">加密合约</option>
    </UiSelect>
    <UiSelect :model-value="filters.state" size="sm" aria-label="状态筛选" @update:model-value="selectFilter('state', $event)">
      <option value="all">全部状态</option>
      <option value="active">演练中</option>
      <option value="awaiting_blind">待盲评</option>
      <option value="skipped">主动空仓</option>
      <option value="awaiting_reveal">待揭晓</option>
      <option value="awaiting_post">待事后复盘</option>
      <option value="reviewed">已完成复盘</option>
    </UiSelect>
    <UiSelect :model-value="filters.attemptKind" size="sm" aria-label="演练次数" @update:model-value="selectFilter('attemptKind', $event)">
      <option value="all">全部次数</option>
      <option value="first">首次盲测</option>
      <option value="retrain">已知复练</option>
    </UiSelect>
    <UiInput
      :model-value="filters.keyword"
      class="replay-history-filters__keyword"
      size="sm"
      type="search"
      aria-label="关键词"
      placeholder="搜索演练、复盘或已揭晓标的"
      @update:model-value="updateKeyword"
      @compositionstart="composing = true; clearKeywordTimer()"
      @compositionend="finishComposition"
    />
  </form>
</template>

<style scoped>
.replay-history-filters {
  align-items: center;
  display: grid;
  gap: 0.75rem;
  grid-template-columns:
    minmax(130px, 0.38fr)
    minmax(130px, 0.38fr)
    minmax(130px, 0.38fr)
    minmax(220px, 1fr);
}

@media (max-width: 720px) {
  .replay-history-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .replay-history-filters__keyword { grid-column: 1 / -1; }
  .replay-history-filters > :nth-child(3) { grid-column: 1 / -1; }
}
@media (max-width: 359px) {
  .replay-history-filters { grid-template-columns: 1fr;
  }
}
</style>
