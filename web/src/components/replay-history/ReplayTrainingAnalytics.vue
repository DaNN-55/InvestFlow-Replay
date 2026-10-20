<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { api } from "../../services/api.js";
import { formatTrainingMetric, trainingBucketWidth, trainingCohortLabel, trainingSampleDate } from "../../utils/replayTrainingAnalytics.js";
import UiButton from "../ui/UiButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiSelect from "../ui/UiSelect.vue";
import ReplayHistoryControls from "./ReplayHistoryControls.vue";

const props = defineProps({ kind: { type: String, default: "first", validator: value => ["first", "retrain"].includes(value) } });
const emit = defineEmits(["openRecord", "viewChange"]);
const filters = reactive({ from: "", to: "", interval: "all", gameLength: "all", board: "all" });
const report = shallowRef(null);
const loading = ref(false);
const error = ref("");
let requestVersion = 0;
const group = computed(() => report.value?.groups?.[props.kind]);
const counts = computed(() => group.value?.counts ?? {});
const cohortItems = computed(() => [{ label: "此前一组", value: group.value?.cohorts?.earlier }, { label: "最近一组", value: group.value?.cohorts?.recent }]);
const eventItems = [
  ["evaluableSessions", "有明确条件"], ["triggeredSessions", "条件曾触发"],
  ["stopTriggeredSessions", "止损触价"], ["invalidationTriggeredSessions", "日收盘失效"],
  ["protectedSessions", "设置止损保护"], ["autoExitSessions", "自动止损成交"],
  ["stopCancelledSessions", "主动取消保护"], ["exitOrderSessions", "提交退出委托"],
  ["restrictedSessions", "成交曾受限制"], ["partialFillSessions", "出现部分成交"],
];
const distributionItems = computed(() => [{ title: "单次收益率分布", value: group.value?.distributions?.returns }, { title: "单次最大回撤分布", value: group.value?.distributions?.drawdowns }]);
const coverageItems = computed(() => [{ title: "周期构成", items: group.value?.breakdowns?.intervals }, { title: "板块构成", items: group.value?.breakdowns?.boards }, { title: "成交规则构成", items: group.value?.breakdowns?.executionModels }]);
const appliedRange = computed(() => `${report.value?.filters?.from || '不限起始日期'} 至 ${report.value?.filters?.to || '不限结束日期'}`);
function modelLabel(value) {
  return { "bar-orders-v2": "按板块执行", "bar-orders-v1": "基础持续委托", "legacy-next-open": "旧版下一开盘执行", "1d": "日线", hybrid: "日内模拟", "1m": "1分钟", main: "主板", chinext: "创业板", star: "科创板" }[value] ?? value;
}
async function load() {
  if (loading.value) return;
  if (filters.from && filters.to && filters.from > filters.to) { error.value = "开始日期不能晚于结束日期"; return; }
  const version = ++requestVersion;
  loading.value = true;
  error.value = "";
  try {
    const payload = await api.getReplayTrainingAnalytics({ ...filters });
    if (version === requestVersion) report.value = payload;
  } catch (cause) {
    if (version === requestVersion) error.value = cause?.message || "训练分析加载失败";
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
watch(() => filters.interval, () => { filters.gameLength = "all"; });
onMounted(load);
onBeforeUnmount(() => { ++requestVersion; });
</script>

<template>
  <section class="training-analytics" aria-label="跨会话训练分析" :aria-busy="loading">
    <ReplayHistoryControls :active-view="kind" @view-change="emit('viewChange', $event)">
      <form class="training-analytics__filters" @submit.prevent="load">
        <label><span>创建开始日期</span><UiInput v-model="filters.from" type="date" /></label>
        <label><span>创建结束日期</span><UiInput v-model="filters.to" type="date" /></label>
        <label><span>练习周期</span><UiSelect v-model="filters.interval"><option value="all">全部周期</option><option value="1d">日线</option><option value="hybrid">日内模拟</option><option value="1m">1分钟</option></UiSelect></label>
        <label><span>练习长度</span><UiSelect v-model="filters.gameLength"><option value="all">全部长度</option><template v-if="filters.interval !== '1m'"><option value="20">20日</option><option value="60">60日</option><option value="120">120日</option></template><template v-if="filters.interval === 'all' || filters.interval === '1m'"><option value="240">240分钟</option><option value="720">720分钟</option><option value="1200">1200分钟</option></template></UiSelect></label>
        <label><span>股票板块</span><UiSelect v-model="filters.board"><option value="all">全部板块</option><option value="main">主板</option><option value="chinext">创业板</option><option value="star">科创板</option></UiSelect></label>
        <UiButton type="submit" variant="secondary" :loading="loading">更新分析</UiButton>
      </form>
      <p class="training-analytics__hint">按北京时间的练习创建日期筛选；统计全部筛选结果，不受记录分页影响。离线Demo与已删除记录不纳入。</p>
    </ReplayHistoryControls>
    <div v-if="error" class="training-analytics__error" role="alert"><span>{{ error }}</span><UiButton variant="secondary" size="sm" :disabled="loading" @click="load">重新加载分析</UiButton></div>
    <p v-else-if="loading && !report" role="status">正在汇总训练记录…</p>
    <template v-else-if="group">
      <p class="training-analytics__scope">{{ kind === 'first' ? '仅统计首次盲测，复练单列。' : '仅统计已知行情复练，不计入首次盲测成绩。' }} {{ appliedRange }}</p>
      <dl class="training-analytics__summary">
        <div><dt>已揭晓完成</dt><dd>{{ counts.analysed ?? 0 }}<small> / {{ counts.sessions ?? 0 }} 次练习</small></dd></div>
        <div><dt>主动不做</dt><dd>{{ counts.skipped ?? 0 }}<small> 次，不自动认定为错误</small></dd></div>
        <div><dt>进行中 / 未揭晓</dt><dd>{{ counts.active ?? 0 }} / {{ counts.unrevealed ?? 0 }}</dd></div>
        <div><dt>已确认问题标签</dt><dd>{{ counts.tagged ?? 0 }}<small> 次练习</small></dd></div>
      </dl>
      <p v-if="!counts.analysed" class="training-analytics__empty">当前分组暂无已完成且揭晓的样本。完成练习并揭晓后可查看结果；暂不展示未揭晓的收益、交易和判断。</p>
      <template v-else>
        <div class="training-analytics__columns">
          <section v-for="distribution in distributionItems" :key="distribution.title" class="training-analytics__section" :aria-label="distribution.title">
            <h3>{{ distribution.title }} <small>{{ distribution.value?.n ?? 0 }} 次</small></h3>
            <p class="training-analytics__metric">中位数 <strong>{{ formatTrainingMetric(distribution.value?.median) }}</strong><span>范围 {{ formatTrainingMetric(distribution.value?.min) }} 至 {{ formatTrainingMetric(distribution.value?.max) }}</span></p>
            <p v-if="counts.metricsUncomputable" class="training-analytics__hint">有效推进或结果数据不足：{{ counts.metricsUncomputable }} 次，未计入分布。</p>
            <ul class="training-analytics__histogram"><li v-for="bucket in distribution.value?.buckets ?? []" :key="bucket.label"><span>{{ bucket.label }}</span><div><i :style="{width: trainingBucketWidth(bucket.count, distribution.value.n)}" /></div><b>{{ bucket.count }}</b></li></ul>
          </section>
        </div>
        <section class="training-analytics__section" aria-label="前后两组练习">
          <h3>前后两组练习 <small>各最多20次</small></h3>
          <p class="training-analytics__hint">按创建先后分组，每次练习独立计算。这里只描述变化，不把不同或重叠行情拼成账户净值，也不据此推断能力提升。</p>
          <div class="training-analytics__cohorts"><article v-for="cohort in cohortItems" :key="cohort.label"><h4>{{ cohort.label }}</h4><p>{{ trainingCohortLabel(cohort.value) }}</p><dl><div><dt>收益率中位数</dt><dd>{{ formatTrainingMetric(cohort.value?.returnMedian) }}</dd></div><div><dt>最大回撤中位数</dt><dd>{{ formatTrainingMetric(cohort.value?.drawdownMedian) }}</dd></div><div><dt>确认问题 / 条件触发</dt><dd>{{ cohort.value?.n ? `${cohort.value.taggedSessions ?? 0} / ${cohort.value.triggeredSessions ?? 0} 次` : '—' }}</dd></div></dl></article></div>
          <p v-if="!group.cohorts?.earlier?.n" class="training-analytics__hint">目前不足两组样本，先保留最近一组，不计算前后改善率。</p>
        </section>
        <section class="training-analytics__section" aria-label="客观执行事件">
          <h3>客观执行事件 <small>按练习数计，同规则持续触发不重复计机会</small></h3>
          <dl class="training-analytics__events"><div v-for="[key,label] in eventItems" :key="key"><dt>{{ label }}</dt><dd>{{ group.events?.[key] ?? 0 }} 次</dd></div></dl>
          <p class="training-analytics__hint">无法自动评估条件：{{ counts.uncomputable ?? 0 }} 次。历史记录仅使用已冻结的下单条件与已推进行情回算，不把事后填写的条件当事前计划；收盘失效按完整日线判断。旧记录未保存的成交受限过程无法还原，事件为0仅表示未找到相应记录。</p>
          <p class="training-analytics__hint">触发、提交退出与成交是不同事件。T+1、涨跌停或容量不足不等同用户违规；自动止损成交也不等同人工纪律提高。本报告不计算“拖延率”。</p>
        </section>
        <section class="training-analytics__section" aria-label="用户确认的重复问题">
          <h3>用户确认的重复问题 <small>{{ counts.tagged ?? 0 }} 次已标注练习</small></h3>
          <p class="training-analytics__hint">只汇总你在事后复盘中选择的标签，采用最新有效修正。未选择不代表没有问题，也不会从旧文本自动推断。</p>
          <ul v-if="group.issues?.length" class="training-analytics__issues"><li v-for="issue in group.issues" :key="issue.tag"><header><strong>{{ issue.tag }}</strong><span>{{ issue.count }} / {{ counts.tagged }} 次已标注练习</span></header><div><UiButton v-for="sample in issue.samples" :key="sample.sessionId" variant="ghost" size="sm" @click="emit('openRecord', sample.sessionId)">查看样本 · 第{{ sample.attemptNumber }}次 · {{ trainingSampleDate(sample.createdAt) }}</UiButton></div></li></ul>
          <p v-else class="training-analytics__empty">还没有确认的问题标签。可在已揭晓练习的事后复盘或追加修正中选择。</p>
        </section>
        <section class="training-analytics__section" aria-label="分析样本构成">
          <h3>样本构成与统计边界</h3>
          <div class="training-analytics__composition"><div v-for="coverage in coverageItems" :key="coverage.title"><h4>{{ coverage.title }}</h4><p v-for="item in coverage.items ?? []" :key="item.label">{{ modelLabel(item.label) }} <b>{{ item.count }} 次</b></p></div></div>
          <p class="training-analytics__hint">不同周期、长度、板块或成交规则会影响结果；可用上方筛选缩小范围。已评分 {{ counts.scored ?? 0 }} 次；样本总交易费用 {{ formatTrainingMetric(group.feesTotal, ' 元') }}。报告只读，不修改原始记录和评分。</p>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.training-analytics { display: grid; gap: 16px; color: var(--ql-ink); font-size: 13px; line-height: 1.6; }
.training-analytics p, .training-analytics dl, .training-analytics dd { margin: 0; }
.training-analytics__filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.training-analytics__filters label { display: grid; gap: 5px; flex: 1 1 140px; min-width: 0; }
.training-analytics__filters label > span { color: var(--ql-color-text-muted); font-size: 12px; }
.training-analytics__hint, .training-analytics__scope { font-size: 12px; color: var(--ql-color-text-muted); }
.training-analytics__summary { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; }
.training-analytics__summary > div { padding: 16px; border: 1px solid var(--ql-line); border-radius: 8px; background: var(--ql-panel); }
.training-analytics dt { color: var(--ql-color-text-muted); font-size: 12px; }
.training-analytics__summary dd { margin-top: 6px; font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.training-analytics small { color: var(--ql-color-text-muted); font-size: 11px; font-weight: 400; }
.training-analytics__summary small { font-size: 11px; }
.training-analytics__columns { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
.training-analytics__section { min-width: 0; padding: 18px; background: var(--ql-panel); border: 1px solid var(--ql-line); border-radius: 8px; }
.training-analytics h3 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
.training-analytics h3 small { margin-left: 8px; }
.training-analytics h4 { margin: 0 0 6px; font-size: 13px; }
.training-analytics__metric { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; color: var(--ql-color-text-muted); font-size: 12px; }
.training-analytics__metric strong { color: var(--ql-ink); font-size: 20px; font-variant-numeric: tabular-nums; }
.training-analytics__metric span { margin-left: auto; }
.training-analytics__histogram { list-style: none; padding: 0; display: grid; gap: 12px; margin: 16px 0 0; }
.training-analytics__histogram li { display: grid; grid-template-columns: 105px minmax(0,1fr) 30px; gap: 10px; align-items: center; font-size: 12px; }
.training-analytics__histogram li > div { height: 8px; background: var(--ql-paper-soft); border-radius: 2px; overflow: hidden; }
.training-analytics__histogram i { display: block; height: 100%; background: var(--ql-color-primary); }
.training-analytics__histogram b { text-align: right; font-variant-numeric: tabular-nums; }
.training-analytics__cohorts, .training-analytics__composition { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 20px; margin: 14px 0; }
.training-analytics__cohorts > article { padding-top: 12px; border-top: 2px solid var(--ql-line-strong); }
.training-analytics__cohorts article > p { font-size: 12px; color: var(--ql-color-text-muted); }
.training-analytics__cohorts dl { display: grid; gap: 6px; margin-top: 10px; }
.training-analytics__cohorts dl > div, .training-analytics__composition p { display: flex; justify-content: space-between; gap: 12px; }
.training-analytics__events { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 18px 10px; margin-bottom: 14px !important; }
.training-analytics__events dd { font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 4px; }
.training-analytics__issues { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 12px; }
.training-analytics__issues li { border-top: 1px solid var(--ql-line); padding-top: 12px; }
.training-analytics__issues header { display: flex; justify-content: space-between; gap: 12px; }
.training-analytics__issues header span { color: var(--ql-color-text-muted); font-size: 12px; }
.training-analytics__issues li > div { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.training-analytics__composition { grid-template-columns: repeat(3,minmax(0,1fr)); }
.training-analytics__composition p { padding: 4px 0; color: var(--ql-color-text-muted); font-size: 12px; }
.training-analytics__composition b { font-weight: 500; color: var(--ql-ink); }
.training-analytics__empty { padding: 16px 0; color: var(--ql-color-text-muted); }
.training-analytics__error { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--ql-color-danger); }
@media (max-width: 900px) { .training-analytics__events { grid-template-columns: repeat(3,minmax(0,1fr)); } .training-analytics__summary { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 640px) { .training-analytics__columns, .training-analytics__cohorts, .training-analytics__composition { grid-template-columns: 1fr; } .training-analytics__events { grid-template-columns: repeat(2,minmax(0,1fr)); } .training-analytics__summary > div { padding: 12px; } .training-analytics__summary dd { font-size: 20px; } .training-analytics__filters label { flex-basis: 150px; } }
</style>
