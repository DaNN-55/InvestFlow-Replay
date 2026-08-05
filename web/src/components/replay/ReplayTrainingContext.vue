<script setup>
import { BookOpenCheck, LockKeyhole } from "lucide-vue-next";
import { computed } from "vue";

const props = defineProps({
  trainingConfig: {
    type: Object,
    default: null,
  },
});

const isPlaybookTraining = computed(
  () => props.trainingConfig?.mode === "playbook",
);
const versionLabel = computed(
  () => `v${props.trainingConfig?.playbookVersionNumber ?? "—"}`,
);
const playbookContent = computed(
  () => String(props.trainingConfig?.playbookContent ?? "").trim(),
);
</script>

<template>
  <section
    v-if="isPlaybookTraining"
    class="replay-training-context"
    aria-label="本局专项战法"
  >
    <header class="replay-training-context__header">
      <BookOpenCheck :size="18" />
      <div>
        <span>本局战法</span>
        <strong>
          {{ trainingConfig.playbookName || "未命名战法" }} · {{ versionLabel }}
        </strong>
      </div>
      <span class="replay-training-context__locked">
        <LockKeyhole :size="12" />
        已冻结
      </span>
    </header>
    <p v-if="playbookContent" class="replay-training-context__content">
      {{ playbookContent }}
    </p>
    <p v-else class="replay-training-context__empty">
      当前冻结版本尚未填写内容，请到战法库补充后再用于下一局训练。
    </p>
    <small>本局固定使用 {{ versionLabel }}，战法后续修改不会影响本局记录。</small>
  </section>
</template>

<style scoped>
.replay-training-context {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid rgba(15, 82, 186, 0.16);
  border-radius: 10px;
  background:
    linear-gradient(120deg, rgba(235, 242, 255, 0.88), transparent 48%),
    var(--ql-color-bg-surface-strong);
}

.replay-training-context__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  color: var(--ql-accent);
}

.replay-training-context__header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.replay-training-context__header span {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.replay-training-context__header strong {
  overflow-wrap: anywhere;
  color: var(--ql-ink);
  font-size: 13px;
}

.replay-training-context__locked {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--ql-paper-soft);
}

.replay-training-context__content,
.replay-training-context__empty {
  max-height: 180px;
  overflow: auto;
  margin: 12px 0 8px;
  color: var(--ql-color-text-body);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.replay-training-context__empty,
.replay-training-context > small {
  color: var(--ql-color-text-muted);
}

.replay-training-context > small {
  font-size: 10px;
}

@media (max-width: 480px) {
  .replay-training-context__header {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .replay-training-context__locked {
    margin-left: 28px;
  }
}
</style>
