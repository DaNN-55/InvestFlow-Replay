<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { GitCompareArrows } from "lucide-vue-next";
import { api } from "../../services/api.js";
import { buildAttemptComparisonRows, formatComparisonExecution, formatComparisonValue, selectComparisonAttempt } from "../../utils/replayAttemptComparison.js";
import { getLatestReplayReviewSnapshot } from "../../utils/replayReviewCorrections.js";
import { formatDisplayDate } from "../../utils/datePresentation.js";
import ReplayReviewTimeline from "./ReplayReviewTimeline.vue";
import ReplayOrderDecisionSnapshot from "./ReplayOrderDecisionSnapshot.vue";
import UiButton from "../ui/UiButton.vue";
import UiDrawer from "../ui/UiDrawer.vue";
import UiSelect from "../ui/UiSelect.vue";

const props = defineProps({ open: Boolean, sessionId: { type: String, default: "" } });
const emit = defineEmits(["close"]);
const result = shallowRef(null);
const loading = ref(false);
const error = ref("");
const selectedId = ref("");
let requestVersion = 0;
const attempts = computed(() => result.value?.attempts ?? []);
const first = computed(() => attempts.value.find(item => item.id === result.value?.firstSessionId) ?? null);
const retrains = computed(() => attempts.value.filter(item => item.kind === "retrain"));
const selected = computed(() => retrains.value.find(item => item.id === selectedId.value) ?? null);
const rows = computed(() => buildAttemptComparisonRows(first.value, selected.value));
const records = computed(() => [{ label: "首次盲测", item: first.value }, { label: selected.value ? `第 ${selected.value.attemptNumber} 次 · 已知复练` : "已知复练", item: selected.value }]);

async function load() {
  const version = ++requestVersion;
  result.value = null;
  error.value = "";
  selectedId.value = "";
  if (!props.open || !props.sessionId) { loading.value = false; return; }
  loading.value = true;
  try {
    const payload = await api.getReplayAttemptComparison(props.sessionId);
    if (version !== requestVersion) return;
    result.value = payload;
    selectedId.value = selectComparisonAttempt(payload.attempts ?? [], payload.selectedSessionId);
  } catch (cause) {
    if (version === requestVersion) error.value = cause?.message || "对照记录加载失败";
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
function confirmedPost(item) {
  return getLatestReplayReviewSnapshot({ stage: "post", originalReview: item?.originalReview?.postReview, corrections: item?.corrections });
}
function outcomeLabel(value) {
  return { correct: "正确", partial: "部分正确", wrong: "错误" }[value] ?? "未确认";
}
watch(() => [props.open, props.sessionId], load, { immediate: true });
onBeforeUnmount(() => { ++requestVersion; });
</script>

<template>
  <UiDrawer :open="open" title="首次与复练对照" description="同一段历史行情，保留第一次的判断，再看复练发生了什么变化。" panel-class="replay-comparison-drawer" @close="emit('close')">
    <div class="replay-comparison" aria-label="首次与复练对照内容">
      <p v-if="loading" role="status">正在加载同场景记录…</p>
      <div v-else-if="error" class="replay-comparison__error" role="alert">
        <p>{{ error }}</p><UiButton variant="secondary" size="sm" @click="load">重新加载对照</UiButton>
      </div>
      <template v-else-if="result">
        <header class="replay-comparison__intro">
          <GitCompareArrows :size="20" aria-hidden="true" />
          <div><strong>首次 {{ result.counts?.first ?? 0 }} 次 · 已知复练 {{ result.counts?.retrain ?? 0 }} 次</strong><p>复练已知道后续行情，单独记录，不计入首次盲测成绩。</p></div>
        </header>
        <p v-if="result.firstUnavailable" class="replay-comparison__notice" role="status">{{ result.firstUnavailable === 'deleted' ? '首次记录已删除' : '未找到可用的首次记录' }}，无法与首次计算差值；以下保留可见复练，不会将它们当成首次。</p>
        <div v-if="retrains.length" class="replay-comparison__selector">
          <label for="replay-comparison-attempt">选择对照复练</label>
          <UiSelect id="replay-comparison-attempt" v-model="selectedId">
            <option v-for="item in retrains" :key="item.id" :value="item.id">第 {{ item.attemptNumber }} 次 · {{ item.available ? '已揭晓' : item.status === 'active' ? '进行中，未揭晓' : '待揭晓' }}</option>
          </UiSelect>
        </div>
        <p v-else class="replay-comparison__notice">还没有复练记录。揭晓后可从“演练记录操作”中选择“复练此行情”，完成后回到这里对照。</p>
        <p v-if="selected && !selected.available" class="replay-comparison__notice" role="status">这次复练尚未揭晓，暂不展示判断、交易或成绩。</p>
        <div v-if="selected?.comparison?.reasons?.length" class="replay-comparison__notice">
          <strong>对照条件提示</strong><ul><li v-for="reason in selected.comparison.reasons" :key="reason">{{ reason }}</li></ul><p>差值仅在条件一致时显示，不据此判断能力提升。</p>
        </div>
        <div class="replay-comparison__table-wrap">
          <table aria-label="首次与复练结果对照">
            <thead><tr><th scope="col">结果</th><th scope="col">首次盲测</th><th scope="col">{{ selected ? `第 ${selected.attemptNumber} 次复练` : '复练' }}</th><th scope="col">复练 − 首次</th></tr></thead>
            <tbody><tr v-for="row in rows" :key="row.key"><th scope="row">{{ row.label }}</th><td>{{ row.first }}</td><td>{{ row.attempt }}</td><td>{{ row.delta }}</td></tr></tbody>
          </table>
        </div>
        <p class="replay-comparison__caption">仓位按每步结束时持仓市值占总资产计算；部分成交按实际成交笔数计。原始评分缺失时显示“—”，复盘修正不会重算评分。</p>
        <div class="replay-comparison__records">
          <section v-for="record in records" :key="record.label" :aria-label="`${record.label}记录`" class="replay-comparison__record">
            <header><h3>{{ record.label }}</h3><span v-if="record.item">{{ formatDisplayDate(record.item.createdAt, '—') }}</span></header>
            <p v-if="!record.item?.available" class="replay-comparison__caption">{{ record.item ? '尚未揭晓，结果暂不展示。' : '暂无可用记录。' }}</p>
            <template v-else>
              <dl class="replay-comparison__conditions"><div><dt>初始资金</dt><dd>{{ formatComparisonValue(record.item.conditions?.initialCapital, 'money') }}</dd></div><div><dt>实际推进</dt><dd>{{ record.item.conditions?.completedSteps }} / {{ record.item.conditions?.totalSteps }} 步</dd></div></dl>
              <h4>原始判断</h4>
              <dl class="replay-comparison__text-fields"><div><dt>行情判断</dt><dd>{{ record.item.originalReview?.blindReview?.thesis || '未记录' }}</dd></div><div><dt>交易计划</dt><dd>{{ record.item.originalReview?.blindReview?.tradePlan || '未记录' }}</dd></div><div><dt>风险计划</dt><dd>{{ record.item.originalReview?.blindReview?.riskPlan || '未记录' }}</dd></div></dl>
              <h4>用户确认的复盘</h4>
              <p class="replay-comparison__caption">{{ (record.item.corrections ?? []).some(item => item.stage === 'post') ? '以下采用最新复盘修正；原始内容可在时间线查看。' : '以下为原始复盘，不根据盈亏自动归因。' }}</p>
              <dl class="replay-comparison__text-fields"><div><dt>自评判断</dt><dd>{{ outcomeLabel(confirmedPost(record.item)?.outcome) }}</dd></div><div v-if="confirmedPost(record.item)?.issueTags?.length"><dt>确认的问题标签</dt><dd>{{ confirmedPost(record.item).issueTags.join('、') }}</dd></div><div><dt>问题与教训</dt><dd>{{ confirmedPost(record.item)?.mistakes || '未确认' }}</dd><dd v-if="confirmedPost(record.item)?.lessons">{{ confirmedPost(record.item).lessons }}</dd></div></dl>
              <details class="replay-comparison__trades" open>
                <summary>委托与成交 · {{ record.item.executions?.length ?? 0 }} 条</summary>
                <ol v-if="record.item.executions?.length"><li v-for="(execution, index) in record.item.executions" :key="execution.executionId || index"><span :class="execution.side === 'buy' ? 'replay-comparison__buy' : 'replay-comparison__sell'">{{ formatComparisonExecution(execution) }}</span><ReplayOrderDecisionSnapshot v-if="execution.decision" :decision="execution.decision" :side="execution.side" /><p v-if="execution.reasonMessage">{{ execution.reasonMessage }}</p></li></ol>
                <p v-else class="replay-comparison__caption">本次没有成交或未成交委托记录。</p>
              </details>
              <ReplayReviewTimeline :blind-review="record.item.originalReview?.blindReview" :post-review="record.item.originalReview?.postReview" :corrections="record.item.corrections ?? []" revealed />
            </template>
          </section>
        </div>
      </template>
    </div>
  </UiDrawer>
</template>

<style scoped>
:global(.ql-ui-drawer__panel.replay-comparison-drawer) { max-width: min(1000px, 100vw); }
.replay-comparison { display: grid; gap: 18px; color: var(--ql-ink); font-size: 13px; line-height: 1.6; }
.replay-comparison p { margin: 0; }
.replay-comparison__intro { display: flex; align-items: flex-start; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--ql-line); }
.replay-comparison__intro svg { margin-top: 2px; color: var(--ql-color-primary); flex-shrink: 0; }
.replay-comparison__intro p, .replay-comparison__caption { color: var(--ql-color-text-muted); font-size: 12px; }
.replay-comparison__selector { display: grid; grid-template-columns: 110px minmax(0, 300px); align-items: center; gap: 12px; }
.replay-comparison__notice { padding: 12px; border-left: 3px solid var(--ql-color-warning); background: var(--ql-paper-soft); color: var(--ql-ink); }
.replay-comparison__notice ul { margin: 6px 0; padding-left: 18px; }
.replay-comparison__error { color: var(--ql-color-danger); display: grid; justify-items: start; gap: 12px; }
.replay-comparison__table-wrap { overflow-x: auto; border: 1px solid var(--ql-line); border-radius: 8px; }
.replay-comparison table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; white-space: nowrap; }
.replay-comparison th, .replay-comparison td { text-align: right; padding: 11px 14px; border-bottom: 1px solid var(--ql-line); }
.replay-comparison thead { background: var(--ql-paper-soft); }
.replay-comparison thead th { font-size: 12px; font-weight: 600; color: var(--ql-color-text-muted); }
.replay-comparison th:first-child { text-align: left; }
.replay-comparison tbody th { font-weight: 500; }
.replay-comparison tr:last-child > * { border-bottom: 0; }
.replay-comparison tbody td:last-child { background: var(--ql-paper-soft); color: var(--ql-color-text-muted); }
.replay-comparison__records { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.replay-comparison__record { min-width: 0; padding-top: 12px; border-top: 2px solid var(--ql-line-strong); overflow-wrap: anywhere; }
.replay-comparison__record header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.replay-comparison h3 { margin: 0; font-size: 15px; }
.replay-comparison h4 { margin: 20px 0 8px; font-size: 13px; }
.replay-comparison__record header span { color: var(--ql-color-text-muted); font-size: 11px; }
.replay-comparison dl { margin: 0; }
.replay-comparison dd { margin: 0; white-space: pre-wrap; }
.replay-comparison dt { color: var(--ql-color-text-muted); }
.replay-comparison__conditions { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px !important; padding: 10px 0; border-bottom: 1px solid var(--ql-line); font-size: 12px; }
.replay-comparison__text-fields { display: grid; gap: 10px; }
.replay-comparison__text-fields dt { margin-bottom: 3px; font-size: 11px; }
.replay-comparison__trades { margin-top: 20px; }
.replay-comparison__trades summary { cursor: pointer; font-weight: 600; }
.replay-comparison__trades ol { list-style: none; padding: 0; max-height: 320px; overflow-y: auto; }
.replay-comparison__trades li { padding: 10px 0; border-bottom: 1px solid var(--ql-line); font-size: 12px; }
.replay-comparison__trades li p { color: var(--ql-color-text-muted); margin-top: 4px; }
.replay-comparison__buy { color: var(--ql-color-danger); }
.replay-comparison__sell { color: var(--ql-color-success); }
.replay-comparison__record :deep(.replay-review-timeline) { margin-top: 16px; padding: 12px 0; }
.replay-comparison__record :deep(.replay-review-timeline__body) { grid-template-columns: 1fr; }
@media (max-width: 640px) {
  .replay-comparison__records { grid-template-columns: 1fr; }
  .replay-comparison__selector { grid-template-columns: 1fr; gap: 5px; }
  .replay-comparison th, .replay-comparison td { padding: 10px 12px; }
}
</style>
