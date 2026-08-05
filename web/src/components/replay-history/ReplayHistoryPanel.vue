<script setup>
import { shallowRef } from "vue";

import ReplayPlaybookPanel from "../replay-playbook/ReplayPlaybookPanel.vue";
import ReplayHistoryRecords from "./ReplayHistoryRecords.vue";

const activeTab = shallowRef("records");
</script>

<template>
  <section class="replay-history-panel">
    <nav class="replay-history-panel__tabs" aria-label="历史演练内容">
      <button
        type="button"
        :class="{ 'replay-history-panel__tab--active': activeTab === 'records' }"
        @click="activeTab = 'records'"
      >
        演练记录
      </button>
      <button
        type="button"
        :class="{ 'replay-history-panel__tab--active': activeTab === 'playbooks' }"
        @click="activeTab = 'playbooks'"
      >
        战法库
      </button>
    </nav>

    <ReplayHistoryRecords v-if="activeTab === 'records'" />
    <ReplayPlaybookPanel v-else />
  </section>
</template>

<style scoped>
.replay-history-panel {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

.replay-history-panel__tabs {
  align-items: center;
  border-bottom: 1px solid rgba(15, 23, 42, 0.1);
  display: flex;
  gap: 1.5rem;
  min-width: 0;
}

.replay-history-panel__tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--ql-color-text-muted);
  background: transparent;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 750;
  padding: 0.75rem 0.125rem;
}

.replay-history-panel__tabs .replay-history-panel__tab--active {
  border-bottom-color: #2563eb;
  color: #1d4ed8;
}
</style>
