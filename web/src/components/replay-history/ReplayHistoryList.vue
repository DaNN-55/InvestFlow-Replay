<script setup>
import {
  formatReplayHistoryIdentity,
  getReplayAttemptPresentation,
  getReplayHistoryStatePresentation,
} from "../../utils/replayHistoryPresentation.js";
import { formatDisplayDate } from "../../utils/datePresentation.js";
import UiButton from "../ui/UiButton.vue";

defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  total: {
    type: Number,
    default: 0,
  },
  page: {
    type: Number,
    default: 1,
  },
  pageCount: {
    type: Number,
    default: 1,
  },
  selectedId: {
    type: String,
    default: "",
  },
  loading: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["select", "page"]);

function formatUpdatedAt(value) {
  if (!value) {
    return "更新时间未知";
  }
  return formatDisplayDate(value);
}

function formatScore(value) {
  return Number(value ?? 0)
    .toFixed(2)
    .replace(/\.00$/u, "");
}

</script>

<template>
  <section class="replay-history-list" aria-label="历史演练列表">
    <header>
      <div>
        <h2>演练记录</h2>
        <p>共 {{ total }} 局</p>
      </div>
      <span v-if="loading" class="replay-history-list__loading">加载中…</span>
    </header>

    <div v-if="items.length" class="replay-history-list__items">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        :class="[
          'replay-history-list__item',
          { 'replay-history-list__item--selected': item.id === selectedId },
        ]"
        @click="emit('select', item)"
      >
        <span class="replay-history-list__item-heading">
          <strong>{{ formatReplayHistoryIdentity(item) }}</strong>
          <span
            :class="[
              'replay-history-list__state',
              `replay-history-list__state--${getReplayHistoryStatePresentation(item.reviewState).tone}`,
            ]"
          >
            {{ getReplayHistoryStatePresentation(item.reviewState).label }}
          </span>
        </span>
        <span class="replay-history-list__meta">
          {{ item.interval === "1m" ? "1 分钟" : item.interval === "hybrid" ? `日内模拟 · ${item.stepMinutes ?? 1}分钟` : "日线" }}
          {{ item.gameLength }} {{ item.interval === "1m" ? "分钟" : "日" }} · 已推进
          {{ item.progress?.current ?? 0 }} / {{ item.progress?.total ?? item.gameLength }}
        </span>
        <span
          class="replay-history-list__attempt"
          :class="`replay-history-list__attempt--${getReplayAttemptPresentation(item.attemptInfo).kind}`"
        >
          {{ getReplayAttemptPresentation(item.attemptInfo).shortLabel }}
        </span>
        <span class="replay-history-list__footer">
          <small>{{ formatUpdatedAt(item.updatedAt) }}</small>
          <span v-if="item.scoreCard" class="replay-history-list__score">
            <strong>{{ formatScore(item.scoreCard.total) }} 分</strong>
            <small
              v-if="getReplayAttemptPresentation(item.attemptInfo).kind === 'retrain'"
            >
              复练成绩，不计入首次盲测统计
            </small>
          </span>
        </span>
      </button>
    </div>
    <div v-else-if="!loading" class="replay-history-list__empty">
      当前筛选条件下暂无演练记录。
    </div>

    <footer class="replay-history-list__pagination">
      <UiButton
        type="button"
        size="sm"
        variant="secondary"
        :disabled="loading || page <= 1"
        @click="emit('page', page - 1)"
      >
        上一页
      </UiButton>
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <UiButton
        type="button"
        size="sm"
        variant="secondary"
        :disabled="loading || page >= pageCount"
        @click="emit('page', page + 1)"
      >
        下一页
      </UiButton>
    </footer>
  </section>
</template>

<style scoped>
.replay-history-list {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  background: var(--ql-color-bg-surface-strong);
  min-width: 0;
  overflow: hidden;
}

.replay-history-list > header {
  align-items: center;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  display: flex;
  justify-content: space-between;
  padding: 0.875rem 1rem;
}

.replay-history-list h2 {
  color: var(--ql-color-text-strong);
  font-size: 0.9375rem;
  font-weight: 800;
}

.replay-history-list header p,
.replay-history-list__loading {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  margin-top: 0.2rem;
}

.replay-history-list__items {
  display: grid;
}

.replay-history-list__item {
  border: 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  background: var(--ql-color-bg-surface-strong);
  color: inherit;
  cursor: pointer;
  display: grid;
  font: inherit;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  text-align: left;
}

.replay-history-list__item:hover {
  background: var(--ql-color-bg-muted);
}

.replay-history-list__item--selected {
  background: var(--ql-color-primary-soft);
  box-shadow: inset 3px 0 #2563eb;
}

.replay-history-list__item-heading,
.replay-history-list__footer {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.replay-history-list__item-heading > strong {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-history-list__state {
  border-radius: 999px;
  flex: 0 0 auto;
  font-size: 0.6875rem;
  font-weight: 800;
  padding: 0.2rem 0.5rem;
}

.replay-history-list__state--active {
  background: #dbeafe;
  color: #1d4ed8;
}

.replay-history-list__state--warning {
  background: #ffedd5;
  color: #9a3412;
}

.replay-history-list__state--success {
  background: #dcfce7;
  color: #166534;
}

.replay-history-list__state--neutral {
  background: var(--ql-color-bg-muted-strong);
  color: var(--ql-color-text-muted);
}

.replay-history-list__meta,
.replay-history-list__footer small {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.replay-history-list__training {
  overflow: hidden;
  color: #1d4ed8;
  font-size: 0.75rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-history-list__attempt {
  width: fit-content;
  max-width: 100%;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  color: #166534;
  background: #dcfce7;
  font-size: 0.6875rem;
  font-weight: 800;
}

.replay-history-list__attempt--retrain {
  color: #9a3412;
  background: #ffedd5;
}

.replay-history-list__score {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
  text-align: right;
}

.replay-history-list__score small {
  white-space: normal;
}

.replay-history-list__footer strong {
  color: #1d4ed8;
  font-size: 0.75rem;
}

.replay-history-list__empty {
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
  padding: 2rem 1rem;
  text-align: center;
}

.replay-history-list__pagination {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  padding: 0.75rem 1rem;
}

.replay-history-list__pagination span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}
</style>
