<script setup>
import { computed } from "vue";

import { formatReplayInvalidationRule, formatReplayReasonTags } from "../../utils/replayReviewPresentation.js";

const props = defineProps({
  decision: { type: Object, default: null },
  side: { type: String, default: "buy" },
});

const exitTypeLabel = computed(() => ({
  take_profit: "止盈",
  stop_loss: "止损",
  thesis_invalidated: "逻辑失效",
  reduce_risk: "降低风险 / 减仓",
  manual: "主动退出",
}[props.decision?.exitType] ?? "未记录"));
</script>

<template>
  <details v-if="decision" class="replay-order-snapshot">
    <summary>查看当时决策</summary>
    <dl>
      <div><dt>理由 / 信心</dt><dd>{{ formatReplayReasonTags(decision.reasonTags) }} · {{ decision.confidence }} / 5</dd></div>
      <div><dt>核心判断</dt><dd>{{ decision.thesis }}</dd></div>
      <div><dt>{{ side === 'buy' ? '开仓计划' : '卖出计划' }}</dt><dd>{{ decision.plan }}</dd></div>
      <template v-if="side === 'buy'">
        <div><dt>风险计划</dt><dd>{{ decision.riskPlan }}</dd></div>
        <div><dt>止损 / 失效</dt><dd>{{ decision.stopLossPrice || '未设置' }} · {{ formatReplayInvalidationRule(decision.invalidationRule) }}</dd></div>
      </template>
      <template v-else>
        <div><dt>卖出类型</dt><dd>{{ exitTypeLabel }}</dd></div>
        <div><dt>剩余仓位</dt><dd>{{ decision.remainingPositionPlan }}</dd></div>
      </template>
    </dl>
  </details>
</template>

<style scoped>
.replay-order-snapshot { margin-top: 7px; }
.replay-order-snapshot summary { color: var(--ql-accent); font-size: 10px; font-weight: 700; cursor: pointer; }
.replay-order-snapshot dl { display: grid; gap: 6px; margin: 8px 0 0; padding: 8px; border-radius: 7px; background: var(--ql-paper-soft); }
.replay-order-snapshot dl > div { display: grid; gap: 2px; }
.replay-order-snapshot dt { color: var(--ql-color-text-subtle); font-size: 9px; }
.replay-order-snapshot dd { margin: 0; color: var(--ql-color-text-muted); font-size: 10px; line-height: 1.5; white-space: pre-wrap; }
</style>
