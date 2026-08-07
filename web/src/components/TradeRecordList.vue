<script setup>
defineProps({
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
});

const emit = defineEmits(["select"]);
</script>

<template>
  <div class="trade-record-list" aria-label="交易追踪列表">
    <div v-if="loading" class="trade-record-list__state">正在加载...</div>
    <div v-else-if="!items.length" class="trade-record-list__state">暂无交易追踪单</div>
    <template v-else>
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="trade-record-list__item"
        :class="{ 'trade-record-list__item--selected': item.id === selectedId }"
        @click="emit('select', item.id)"
      >
        <span class="trade-record-list__main">
          <strong>{{ item.title }}</strong>
          <span class="trade-record-list__status">{{ item.status }}</span>
        </span>
        <span class="trade-record-list__detail">
          <span>{{ item.meta }}</span>
          <span class="trade-record-list__tail">
            <em v-if="item.profit" :class="`trade-record-list__profit--${item.profitTone}`">{{ item.profit }}</em>
            <time v-if="item.updatedAt">{{ item.updatedAt }}</time>
          </span>
        </span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.trade-record-list {
  display: grid;
  gap: 0.5rem;
}

.trade-record-list__state {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 0.625rem;
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
  padding: 1rem;
  text-align: center;
}

.trade-record-list__item {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 0.625rem;
  background: var(--ql-color-bg-surface-strong);
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 0.375rem;
  padding: 0.75rem;
  text-align: left;
  width: 100%;
}

.trade-record-list__item:hover {
  border-color: #bfdbfe;
  background: var(--ql-color-primary-soft);
}

.trade-record-list__item--selected {
  border-color: #60a5fa;
  box-shadow: inset 3px 0 0 #2563eb;
  background: var(--ql-color-primary-soft);
}

.trade-record-list__main,
.trade-record-list__detail,
.trade-record-list__tail {
  align-items: center;
  display: flex;
}

.trade-record-list__main,
.trade-record-list__detail {
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
}

.trade-record-list__main strong {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.trade-record-list__status {
  border-radius: 999px;
  background: var(--ql-color-bg-muted-strong);
  color: var(--ql-color-text-body);
  flex: 0 0 auto;
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 0.1875rem 0.5rem;
}

.trade-record-list__detail {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
}

.trade-record-list__detail > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trade-record-list__tail {
  flex: 0 0 auto;
  gap: 0.5rem;
}

.trade-record-list__tail em {
  font-style: normal;
  font-weight: 800;
}

.trade-record-list__profit--positive {
  color: #047857;
}

.trade-record-list__profit--negative {
  color: #be123c;
}
</style>
