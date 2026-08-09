<script setup>
import { Eye, RotateCcw, ShieldCheck } from "lucide-vue-next";
import { computed } from "vue";

import { getReplayAttemptPresentation } from "../../utils/replayHistoryPresentation.js";

const props = defineProps({
  attemptInfo: {
    type: Object,
    default: null,
  },
  cancelling: { type: Boolean, default: false },
});

const emit = defineEmits(["cancelRetrain"]);

const presentation = computed(() =>
  getReplayAttemptPresentation(props.attemptInfo),
);
</script>

<template>
  <section
    class="replay-attempt-context"
    :class="`replay-attempt-context--${presentation.kind}`"
    aria-label="本局演练次数"
  >
    <component
      :is="presentation.kind === 'retrain' ? Eye : ShieldCheck"
      :size="17"
    />
    <div>
      <strong>{{ presentation.label }}</strong>
      <small v-if="presentation.kind === 'retrain'">
        已知真实标的与历史结果，用于验证和修正方法，不计入首次盲测成绩。
      </small>
      <small v-else>
        这是该历史场景的首次匿名作答，成绩进入首次盲测统计。
      </small>
    </div>
    <button
      v-if="presentation.kind === 'retrain' && attemptInfo?.sourceSessionId"
      type="button"
      class="replay-attempt-context__cancel"
      :disabled="cancelling"
      @click="emit('cancelRetrain')"
    >
      <RotateCcw :size="13" />
      {{ cancelling ? "正在取消…" : "取消复练并返回首次结果" }}
    </button>
  </section>
</template>

<style scoped>
.replay-attempt-context {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 13px;
  border: 1px solid rgba(5, 150, 105, 0.16);
  border-radius: 10px;
  color: #047857;
  background: var(--ql-color-success-soft);
}

.replay-attempt-context--retrain {
  border-color: rgba(217, 119, 6, 0.18);
  color: #b45309;
  background: var(--ql-color-warning-soft);
}

.replay-attempt-context > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.replay-attempt-context__cancel {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 4px 7px;
  border: 0;
  border-radius: 6px;
  color: inherit;
  background: transparent;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.replay-attempt-context__cancel:hover:not(:disabled) {
  background: rgba(217, 119, 6, 0.1);
}

.replay-attempt-context__cancel:disabled { cursor: wait; opacity: 0.55; }

.replay-attempt-context strong {
  color: inherit;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.replay-attempt-context small {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  line-height: 1.55;
}
</style>
