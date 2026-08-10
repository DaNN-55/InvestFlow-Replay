<script setup>
import { computed } from "vue";
import { ChevronDown, Ellipsis, Pencil, Trash2 } from "lucide-vue-next";

import { buildReplayReviewTimeline } from "../../utils/replayReviewCorrections.js";
import UiActionMenu from "../ui/UiActionMenu.vue";

const props = defineProps({
  blindReview: {
    type: Object,
    default: null,
  },
  postReview: {
    type: Object,
    default: null,
  },
  corrections: {
    type: Array,
    default: () => [],
  },
  revealed: {
    type: Boolean,
    default: false,
  },
  showOriginal: {
    type: Boolean,
    default: true,
  },
  editable: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["editCorrection", "deleteCorrection"]);

const stages = computed(() =>
  buildReplayReviewTimeline({
    blindReview: props.blindReview,
    postReview: props.postReview,
    corrections: props.corrections,
    revealed: props.revealed,
    includeOriginal: props.showOriginal,
  }),
);
</script>

<template>
  <details
    v-if="stages.length"
    class="replay-review-timeline"
    aria-label="复盘修正时间线"
  >
    <summary class="replay-review-timeline__header">
      <div>
        <h3>{{ showOriginal ? "复盘记录时间线" : "复盘修正记录" }}</h3>
        <p v-if="showOriginal">原始记录永久保留；追加修正不会覆盖原始内容。</p>
        <p v-else>这里只展示追加修正；原始内容请查看上方记录。</p>
      </div>
      <span class="replay-review-timeline__summary-tail">
        <strong>原始评分不会改变</strong>
        <ChevronDown class="replay-review-timeline__chevron" :size="16" aria-hidden="true" />
      </span>
    </summary>

    <div class="replay-review-timeline__body">
    <section
      v-for="stage in stages"
      :key="stage.stage"
      class="replay-review-timeline__stage"
    >
      <h4>{{ stage.title }}</h4>
      <div class="replay-review-timeline__entries">
        <article
          v-for="entry in stage.entries"
          :key="entry.id"
          class="replay-review-timeline__entry"
        >
          <header>
            <strong>{{ entry.title }}</strong>
            <div class="replay-review-timeline__entry-meta">
              <span>{{ entry.time }}</span>
              <UiActionMenu
                v-if="editable && entry.correction"
                class="replay-review-timeline__entry-menu"
                label="修正记录操作"
                :min-width="96"
                :trigger-size="24"
              >
                <template #trigger><Ellipsis :size="15" /></template>
                <button class="ui-action-menu__item" type="button" @click="emit('editCorrection', entry.correction)"><Pencil :size="13" />修改</button>
                <button class="ui-action-menu__item ui-action-menu__item--danger" type="button" @click="emit('deleteCorrection', entry.correction)"><Trash2 :size="13" />删除</button>
              </UiActionMenu>
            </div>
          </header>
          <p v-if="entry.changeNote" class="replay-review-timeline__note">
            修正说明：{{ entry.changeNote }}
          </p>
          <dl>
            <div v-for="field in entry.fields" :key="field.label">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
    </div>
  </details>
</template>

<style scoped>
.replay-review-timeline {
  padding: 1rem;
  border-top: 1px solid var(--ql-line, rgba(15, 23, 42, 0.08));
  background: var(--ql-color-bg-surface-strong);
}

.replay-review-timeline__header { cursor: pointer; }
.replay-review-timeline__body { display: grid; gap: 1rem; padding-top: 1rem; }

.replay-review-timeline__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.replay-review-timeline__header h3,
.replay-review-timeline__header p,
.replay-review-timeline__stage h4 {
  margin: 0;
}

.replay-review-timeline__header h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
}

.replay-review-timeline__header p {
  margin-top: 0.25rem;
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.replay-review-timeline__summary-tail { align-items: center; display: flex; flex: 0 0 auto; gap: 0.5rem; }

.replay-review-timeline__summary-tail > strong {
  flex: 0 0 auto;
  padding: 0.3rem 0.55rem;
  border-radius: 999px;
  color: var(--ql-color-success);
  background: var(--ql-color-success-soft);
  font-size: 0.6875rem;
}

.replay-review-timeline__chevron { color: var(--ql-color-text-muted); transition: transform 160ms ease; }
.replay-review-timeline[open] .replay-review-timeline__chevron { transform: rotate(180deg); }

.replay-review-timeline__stage {
  display: grid;
  gap: 0.6rem;
}

.replay-review-timeline__stage h4 {
  color: var(--ql-color-text-body);
  font-size: 0.8125rem;
}

.replay-review-timeline__entries {
  display: grid;
  gap: 0.75rem;
}

.replay-review-timeline__entry {
  padding: 0.8rem;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-left: 3px solid #93c5fd;
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
}

.replay-review-timeline__entry > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.replay-review-timeline__entry > header strong {
  color: var(--ql-color-text-strong);
  font-size: 0.8125rem;
}

.replay-review-timeline__entry > header span {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
}

.replay-review-timeline__entry-meta { align-items: center; display: flex; gap: 0.35rem; }

.replay-review-timeline__note {
  margin: 0.6rem 0 0;
  padding: 0.5rem 0.6rem;
  border-radius: 6px;
  color: #92400e;
  background: var(--ql-color-warning-soft);
  font-size: 0.75rem;
  line-height: 1.5;
}

.replay-review-timeline__entry dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
  margin: 0.7rem 0 0;
}

.replay-review-timeline__entry dl > div:nth-child(n + 3) {
  grid-column: 1 / -1;
}

.replay-review-timeline__entry dt {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  font-weight: 700;
}

.replay-review-timeline__entry dd {
  margin: 0.2rem 0 0;
  color: var(--ql-color-text-body);
  font-size: 0.75rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (max-width: 640px) {
  .replay-review-timeline__header,
  .replay-review-timeline__entry > header {
    flex-direction: column;
  }

  .replay-review-timeline__entry dl {
    grid-template-columns: 1fr;
  }

  .replay-review-timeline__entry dl > div:nth-child(n + 3) {
    grid-column: auto;
  }
}
</style>
