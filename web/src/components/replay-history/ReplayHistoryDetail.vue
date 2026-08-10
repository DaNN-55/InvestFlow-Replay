<script setup>
import { computed } from "vue";
import { ChevronDown, ChevronUp, Ellipsis, ExternalLink, RefreshCw, Trash2 } from "lucide-vue-next";

import {
  buildReplayHistoryScoreDimensions,
  formatReplayCompletionReason,
  formatReplayHistoryIdentity,
  getReplayAttemptPresentation,
  getReplayHistoryStatePresentation,
} from "../../utils/replayHistoryPresentation.js";
import {
  buildReplayScoreMetrics,
  buildReplayScoreWeightSnapshot,
  formatReplayScoreMetric,
} from "../../utils/replayScorePresentation.js";
import {
  buildReplayBlindReviewPrefill,
  formatReplayInvalidationRule,
  formatReplayReasonTags,
} from "../../utils/replayReviewPresentation.js";
import { getLatestReplayReviewSnapshot } from "../../utils/replayReviewCorrections.js";
import ReplayReviewTimeline from "../replay/ReplayReviewTimeline.vue";
import ReplayOrderDecisionSnapshot from "../replay/ReplayOrderDecisionSnapshot.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiTooltip from "../ui/UiTooltip.vue";

const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
  candidateState: {
    type: Object,
    default: () => ({}),
  },
  retrainState: {
    type: Object,
    default: () => ({}),
  },
  deleteState: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits([
  "open",
  "addCandidate",
  "retrain",
  "delete",
  "editCorrection",
  "deleteCorrection",
]);

const latestBlindCorrection = computed(() =>
  (props.item.corrections ?? []).filter((item) => item.stage === "blind").at(-1) ?? null,
);
const latestPostCorrection = computed(() =>
  (props.item.corrections ?? []).filter((item) => item.stage === "post").at(-1) ?? null,
);
const effectiveBlindReview = computed(() =>
  getLatestReplayReviewSnapshot({
    stage: "blind",
    originalReview: props.item.blindReview,
    corrections: props.item.corrections,
  }),
);
const displayedBlindReview = computed(() => {
  if (!effectiveBlindReview.value) return null;
  const decisionPrefill = buildReplayBlindReviewPrefill(props.item);
  return {
    ...effectiveBlindReview.value,
    stopLossPrice:
      effectiveBlindReview.value.stopLossPrice ??
      decisionPrefill?.stopLossPrice ??
      null,
    invalidationRule:
      effectiveBlindReview.value.invalidationRule ??
      decisionPrefill?.invalidationRule ??
      null,
  };
});
const effectivePostReview = computed(() =>
  getLatestReplayReviewSnapshot({
    stage: "post",
    originalReview: props.item.postReview,
    corrections: props.item.corrections,
  }),
);

const scoreDimensions = computed(() =>
  buildReplayHistoryScoreDimensions(props.item.scoreCard),
);
const scoreMetrics = computed(() =>
  buildReplayScoreMetrics(props.item.scoreCard, { benchmarkCode: props.item.benchmarkCode }),
);
const scoreWeightSnapshot = computed(() =>
  buildReplayScoreWeightSnapshot(props.item.scoreCard),
);
const playbookFitApplicable = computed(
  () =>
    Boolean(effectiveBlindReview.value?.playbookId) &&
    Boolean(effectiveBlindReview.value?.playbookVersionId),
);
const linkedPlaybook = computed(
  () =>
    Boolean(effectiveBlindReview.value?.playbookId) &&
    Boolean(effectiveBlindReview.value?.playbookVersionId),
);
const hasAdjustment = computed(() =>
  Boolean(effectivePostReview.value?.strategyAdjustment?.trim()),
);
const existingCandidate = computed(
  () =>
    props.candidateState.created ||
    Boolean(
      props.item.playbookCandidate ??
        props.item.playbookCandidateId ??
        props.item.candidateId,
    ),
);
const attemptPresentation = computed(() =>
  getReplayAttemptPresentation(props.item.attemptInfo),
);
const executions = computed(() =>
  Array.isArray(props.item.executions) ? props.item.executions : [],
);
const pendingOrders = computed(() =>
  Array.isArray(props.item.pendingOrders) ? props.item.pendingOrders : [],
);
const hasOrderRecords = computed(
  () => executions.value.length > 0 || pendingOrders.value.length > 0,
);
const orderColumns = computed(() =>
  ["buy", "sell"].map((side) => ({
    side,
    records: [
      ...executions.value
        .filter((execution) => execution.side === side)
        .map((execution) => ({
          key: `execution-${execution.orderId}`,
          kind: "execution",
          value: execution,
          sequence: Number(execution.sequence ?? 0),
        })),
      ...pendingOrders.value
        .filter((order) => order.side === side)
        .map((order) => ({
          key: `pending-${order.orderId}`,
          kind: "pending",
          value: order,
          sequence: Number(order.scheduledSequence ?? 0),
        })),
    ].sort((left, right) => left.sequence - right.sequence),
  })),
);

const outcomeLabels = {
  correct: "正确",
  partial: "部分正确",
  wrong: "错误",
};

function formatScore(value) {
  return Number(value ?? 0)
    .toFixed(2)
    .replace(/\.00$/u, "");
}

function formatMoney(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : "—";
}

function isStrongScore(value, maximum = 100) {
  const numericValue = Number(value);
  const numericMaximum = Number(maximum);
  return (
    Number.isFinite(numericValue) &&
    Number.isFinite(numericMaximum) &&
    numericMaximum > 0 &&
    numericValue / numericMaximum >= 0.8
  );
}

function isPositiveMetric(metric) {
  return (
    !metric.unavailable &&
    metric.signed &&
    Number.isFinite(Number(metric.value)) &&
    Number(metric.value) > 0
  );
}

</script>

<template>
  <article class="replay-history-detail">
    <header class="replay-history-detail__header">
      <div>
        <p>{{ item.revealed ? "真实标的已揭晓" : "匿名行情" }}</p>
        <h2>{{ formatReplayHistoryIdentity(item) }}</h2>
        <span>
          {{ getReplayHistoryStatePresentation(item.reviewState).label }}
          · {{ item.interval === "1m" ? "1 分钟" : item.interval === "hybrid" ? `日内模拟 · ${item.stepMinutes ?? 1}分钟` : "日线" }}
          {{ item.gameLength }} {{ item.interval === "1m" ? "分钟" : "日" }}
        </span>
      </div>
      <div class="replay-history-detail__actions">
        <UiActionMenu
          class="replay-history-detail__action-menu"
          label="演练记录操作"
          :min-width="150"
          :trigger-size="32"
        >
          <template #trigger><Ellipsis :size="17" /></template>
          <button class="ui-action-menu__item" type="button" @click="emit('open', item)"><ExternalLink :size="14" />打开演练</button>
          <button v-if="item.revealed" class="ui-action-menu__item" type="button" :disabled="retrainState.loading" @click="emit('retrain', item)"><RefreshCw :size="14" />复练此行情</button>
          <button class="ui-action-menu__item ui-action-menu__item--danger" type="button" :disabled="deleteState.loading || retrainState.loading" @click="emit('delete', item)"><Trash2 :size="14" />删除记录</button>
        </UiActionMenu>
        <small
          v-if="retrainState.error || deleteState.error"
          class="replay-history-detail__action-error"
          role="alert"
        >
          {{ retrainState.error || deleteState.error }}
        </small>
      </div>
    </header>

    <dl class="replay-history-detail__facts">
      <div>
        <dt>演练次数</dt>
        <dd>{{ attemptPresentation.label }}</dd>
      </div>
      <div>
        <dt>推进进度</dt>
        <dd>
          {{ item.progress?.current ?? 0 }} /
          {{ item.progress?.total ?? item.gameLength }}
        </dd>
      </div>
      <div>
        <dt>完成原因</dt>
        <dd>{{ formatReplayCompletionReason(item.completionReason) }}</dd>
      </div>
      <div v-if="item.revealed">
        <dt>行情区间</dt>
        <dd>{{ item.reveal?.startDate || "—" }} 至 {{ item.reveal?.endDate || "—" }}</dd>
      </div>
    </dl>

    <details
      v-if="item.scoreCard"
      class="replay-history-detail__score"
      open
    >
      <summary class="replay-history-detail__score-summary">
        <div>
          <span>综合评分</span>
          <strong
            :class="{
              'replay-history-detail__value--positive': isStrongScore(
                item.scoreCard.total,
              ),
            }"
          >
            {{ formatScore(item.scoreCard.total) }}
          </strong>
          <small>/ 100</small>
          <small class="replay-history-detail__algorithm">
            算法 {{ item.scoreCard.algorithmVersion || "旧版评分" }}
            <span
              class="replay-history-detail__score-note"
              :class="{
                'replay-history-detail__score-note--retrain':
                  attemptPresentation.kind === 'retrain',
              }"
            >
              {{ attemptPresentation.scoreNote }}
            </span>
          </small>
        </div>
        <div class="replay-history-detail__score-summary-side">
          <span
            class="replay-history-detail__collapse-hint replay-history-detail__collapse-hint--open"
            title="折叠评分"
          >
            <ChevronUp :size="17" />
          </span>
          <span
            class="replay-history-detail__collapse-hint replay-history-detail__collapse-hint--closed"
            title="展开评分"
          >
            <ChevronDown :size="17" />
          </span>
        </div>
      </summary>
      <div class="replay-history-detail__score-body">
        <div class="replay-history-detail__score-meta">
          <span class="replay-history-detail__score-meta-item">
            <span>权重快照：</span>
            <UiTooltip
              content="各维度权重来自评分算法；不适用的维度不计入本局得分。"
              label="查看权重快照说明"
            />
            <template v-for="(entry, index) in scoreWeightSnapshot" :key="entry.key">
              <span>
                {{ entry.label }} {{ entry.weight }}{{ entry.applicable ? "" : "（不适用）" }}
              </span>{{ index < scoreWeightSnapshot.length - 1 ? " · " : "" }}
            </template>
          </span>
          <span
            v-if="item.scoreCard.appliedWeightTotal != null"
            class="replay-history-detail__score-meta-item"
          >
            <span>
              本局适用权重
              {{ formatScore(item.scoreCard.appliedWeightTotal) }} / 100
              <template v-if="item.scoreCard.rawTotal != null">
                · 原始得分 {{ formatScore(item.scoreCard.rawTotal) }}
              </template>
            </span>
            <UiTooltip
              content="不适用维度会从总权重中扣除；原始得分按本局适用权重重新折算为 100 分。"
              label="查看适用权重说明"
            />
          </span>
        </div>
        <div
          class="replay-history-detail__dimensions"
          aria-label="评分维度"
        >
          <div
            v-for="dimension in scoreDimensions"
            :key="dimension.key"
            :class="{
              'replay-history-detail__data-card--positive':
                dimension.applicable &&
                isStrongScore(dimension.value, dimension.maximum),
            }"
          >
            <div class="replay-history-detail__metric-label">
              <span>{{ dimension.label }}</span>
              <UiTooltip
                v-if="dimension.explain"
                :content="dimension.description"
                :label="`查看${dimension.label}说明`"
              />
            </div>
            <strong v-if="dimension.applicable">
              {{ formatScore(dimension.value) }}
              <small>/ {{ dimension.maximum }}</small>
            </strong>
            <strong v-else class="replay-history-detail__not-applicable">
              不适用
            </strong>
            <small v-if="!dimension.applicable && dimension.reason">
              {{ dimension.reason }}
            </small>
          </div>
        </div>
        <div class="replay-history-detail__metrics">
          <div
            v-for="metric in scoreMetrics"
            :key="metric.key"
            :class="{
              'replay-history-detail__data-card--positive':
                isPositiveMetric(metric),
            }"
          >
            <div class="replay-history-detail__metric-label">
              <span>{{ metric.label }}</span>
              <UiTooltip
                v-if="metric.explain"
                :content="metric.description"
                :label="`查看${metric.label}说明`"
              />
            </div>
            <strong>{{ formatReplayScoreMetric(metric) }}</strong>
          </div>
        </div>
      </div>
    </details>

    <section class="replay-history-detail__section">
      <h3>逐笔委托与成交</h3>
      <div v-if="hasOrderRecords" class="replay-history-detail__order-columns">
        <section
          v-for="column in orderColumns"
          :key="column.side"
          class="replay-history-detail__order-column"
          :class="`replay-history-detail__order-column--${column.side}`"
        >
          <h4>{{ column.side === "buy" ? "买入记录" : "卖出记录" }}</h4>
          <div v-if="column.records.length" class="replay-history-detail__orders">
            <article
              v-for="record in column.records"
              :key="record.key"
              class="replay-history-detail__order"
            >
              <header>
                <span :class="`replay-history-detail__side--${column.side}`">
                  {{
                    record.kind === "pending"
                      ? column.side === "buy" ? "待买入" : "待卖出"
                      : column.side === "buy" ? "买入" : "卖出"
                  }}
                </span>
                <strong>
                  第 {{ record.kind === "execution" ? record.value.sequence : record.value.scheduledSequence }}
                  {{ item.interval === "hybrid" ? `${item.stepMinutes ?? 1}分钟` : item.interval === "1m" ? "分钟" : "日" }}{{ record.kind === "pending" ? "开盘" : "" }}
                </strong>
                <template v-if="record.kind === 'execution'">
                  <span v-if="record.value.status === 'filled'">
                    {{ record.value.quantity }} 股 · ¥{{ formatMoney(record.value.price) }}
                    · 费用 ¥{{ formatMoney(record.value.totalFee) }}
                  </span>
                  <span v-else class="replay-history-detail__order-status">
                    {{ record.value.status === "cancelled" ? "已取消" : "未成交" }}
                    <template v-if="record.value.reasonMessage">
                      · {{ record.value.reasonMessage }}
                    </template>
                  </span>
                </template>
                <span v-else>
                  {{
                    record.value.quantityType === "shares"
                      ? `${record.value.requestedQuantity} 股`
                      : `${Number(record.value.ratio) * 100}%`
                  }}
                </span>
              </header>
              <ReplayOrderDecisionSnapshot
                :decision="record.value.decision"
                :side="column.side"
              />
            </article>
          </div>
          <p v-else class="replay-history-detail__order-empty">
            暂无{{ column.side === "buy" ? "买入" : "卖出" }}记录
          </p>
        </section>
      </div>
      <p v-else class="replay-history-detail__empty">
        本局没有提交买卖委托。
      </p>
    </section>

    <details class="replay-history-detail__reviews" open>
      <summary class="replay-history-detail__reviews-summary">
        <div>
          <h3>两阶段复盘</h3>
          <p>揭晓前确认与揭晓后复盘共用一个展开区域。</p>
        </div>
        <ChevronDown class="replay-history-detail__reviews-chevron" :size="17" />
      </summary>
      <div class="replay-history-detail__reviews-grid">
      <section class="replay-history-detail__review-section">
        <h3>揭晓前整局确认</h3>
        <div class="replay-history-detail__review-body">
        <p v-if="latestBlindCorrection" class="replay-history-detail__effective-version">
          当前有效版本 · 已修正至第 {{ latestBlindCorrection.revisionNumber }} 版
        </p>
        <dl v-if="displayedBlindReview" class="replay-history-detail__review">
        <div class="replay-history-detail__review-field--compact">
          <dt>战法名称</dt>
          <dd>{{ displayedBlindReview.strategyName || "未指定" }}</dd>
          <small v-if="displayedBlindReview.playbookVersionNumber">
            关联战法 · v{{ displayedBlindReview.playbookVersionNumber }}，已冻结
          </small>
        </div>
        <div class="replay-history-detail__review-field--compact">
          <dt>判断信心</dt>
          <dd>{{ displayedBlindReview.confidence }} / 5</dd>
        </div>
        <div class="replay-history-detail__review-field--wide">
          <dt>判断理由</dt>
          <dd>{{ formatReplayReasonTags(displayedBlindReview.reasonTags) }}</dd>
        </div>
        <div class="replay-history-detail__review-field--compact">
          <dt>止损价</dt>
          <dd>
            {{
              Number(displayedBlindReview.stopLossPrice) > 0
                ? Number(displayedBlindReview.stopLossPrice)
                : "未记录"
            }}
          </dd>
        </div>
        <div class="replay-history-detail__review-field--compact">
          <dt>判断失效条件</dt>
          <dd>
            {{ formatReplayInvalidationRule(displayedBlindReview.invalidationRule) }}
          </dd>
        </div>
        <div class="replay-history-detail__review-field--wide">
          <dt>核心判断</dt>
          <dd>{{ displayedBlindReview.thesis }}</dd>
        </div>
        <div class="replay-history-detail__review-field--wide">
          <dt>交易计划</dt>
          <dd>{{ displayedBlindReview.tradePlan }}</dd>
        </div>
        <div class="replay-history-detail__review-field--wide">
          <dt>风险计划</dt>
          <dd>{{ displayedBlindReview.riskPlan }}</dd>
        </div>
        </dl>
        <p v-else class="replay-history-detail__empty">
          尚未保存盲评。
        </p>
        </div>
      </section>

      <section class="replay-history-detail__review-section">
        <h3>揭晓后复盘</h3>
        <div class="replay-history-detail__review-body">
        <p v-if="latestPostCorrection" class="replay-history-detail__effective-version">
          当前有效版本 · 已修正至第 {{ latestPostCorrection.revisionNumber }} 版
        </p>
        <dl v-if="effectivePostReview" class="replay-history-detail__review">
        <div>
          <dt>判断结果</dt>
          <dd>{{ outcomeLabels[effectivePostReview.outcome] || effectivePostReview.outcome }}</dd>
        </div>
        <div>
          <dt>执行纪律</dt>
          <dd>{{ effectivePostReview.disciplineScore }} / 5</dd>
        </div>
        <div>
          <dt>风险控制</dt>
          <dd>
            {{
              effectivePostReview.riskControlScore == null
                ? "旧记录未保存"
                : `${effectivePostReview.riskControlScore} / 5`
            }}
          </dd>
        </div>
        <div v-if="playbookFitApplicable">
          <dt>战法复核</dt>
          <dd>
            {{
              effectivePostReview.playbookFitScore == null
                ? "旧记录未保存"
                : `${effectivePostReview.playbookFitScore} / 5`
            }}
          </dd>
        </div>
        <div>
          <dt>执行复盘</dt>
          <dd>{{ effectivePostReview.executionReview }}</dd>
        </div>
        <div>
          <dt>错误与不足</dt>
          <dd>{{ effectivePostReview.mistakes }}</dd>
        </div>
        <div>
          <dt>经验总结</dt>
          <dd>{{ effectivePostReview.lessons }}</dd>
        </div>
        <div>
          <dt>战法调整建议</dt>
          <dd>{{ effectivePostReview.strategyAdjustment || "未填写" }}</dd>
          <small>候选改进，不会直接修改原战法</small>
          <div
            v-if="hasAdjustment"
            class="replay-history-detail__candidate"
          >
            <template v-if="linkedPlaybook">
              <UiButton
                v-if="!existingCandidate"
                type="button"
                size="sm"
                variant="secondary"
                :loading="candidateState.loading"
                :disabled="candidateState.loading"
                @click="emit('addCandidate', item)"
              >
                一键加入候选改进
              </UiButton>
              <span
                v-else
                class="replay-history-detail__candidate-success"
              >
                已加入候选库，等待人工处理
              </span>
            </template>
            <span v-else class="replay-history-detail__candidate-hint">
              本次盲评未关联战法，只保留调整文本，不能自动加入候选。
            </span>
            <span
              v-if="candidateState.error"
              class="replay-history-detail__candidate-error"
            >
              {{ candidateState.error }}
            </span>
            <span
              v-else-if="candidateState.success"
              class="replay-history-detail__candidate-success"
            >
              {{ candidateState.success }}
            </span>
          </div>
        </div>
        </dl>
        <p v-else class="replay-history-detail__empty">
          尚未保存事后复盘。
        </p>
        </div>
      </section>
      </div>
    </details>

    <ReplayReviewTimeline
      :blind-review="item.blindReview"
      :post-review="item.postReview"
      :corrections="item.corrections"
      :revealed="item.revealed"
      :show-original="false"
      editable
      @edit-correction="emit('editCorrection', $event)"
      @delete-correction="emit('deleteCorrection', $event)"
    />
  </article>
</template>

<style scoped>
.replay-history-detail {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  background: var(--ql-color-bg-surface-strong);
  min-width: 0;
  overflow: hidden;
}

.replay-history-detail__header {
  align-items: flex-start;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  padding: 1rem;
}

.replay-history-detail__header p {
  color: #2563eb;
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.06em;
}

.replay-history-detail__header h2 {
  color: var(--ql-color-text-strong);
  font-size: 1rem;
  font-weight: 800;
  margin-top: 0.25rem;
}

.replay-history-detail__header span {
  color: var(--ql-color-text-muted);
  display: block;
  font-size: 0.75rem;
  margin-top: 0.25rem;
}

.replay-history-detail__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}


.replay-history-detail__action-error {
  flex-basis: 100%;
  max-width: 260px;
  color: #be123c;
  font-size: 0.6875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-align: right;
}

.replay-history-detail__facts,
.replay-history-detail__dimensions,
.replay-history-detail__metrics {
  display: grid;
  gap: 0.75rem;
}

.replay-history-detail__facts {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 1rem;
}

.replay-history-detail__facts > div,
.replay-history-detail__dimensions > div,
.replay-history-detail__metrics > div {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.replay-history-detail dt,
.replay-history-detail__score span {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.replay-history-detail dd {
  color: var(--ql-color-text-body);
  font-size: 0.8125rem;
  font-weight: 650;
  line-height: 1.55;
  margin-top: 0.25rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.replay-history-detail__section,
.replay-history-detail__score,
.replay-history-detail__reviews {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
}

.replay-history-detail__section {
  padding: 1rem;
}

.replay-history-detail__section h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
  font-weight: 800;
  margin-bottom: 0.75rem;
}

.replay-history-detail__reviews {
  padding: 1rem;
}

.replay-history-detail__reviews-summary {
  align-items: center;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  list-style: none;
}

.replay-history-detail__reviews-summary::-webkit-details-marker {
  display: none;
}

.replay-history-detail__reviews-summary h3,
.replay-history-detail__reviews-summary p,
.replay-history-detail__review-section > h3 {
  margin: 0;
}

.replay-history-detail__reviews-summary h3,
.replay-history-detail__review-section > h3 {
  color: var(--ql-color-text-strong);
  font-size: 0.875rem;
  font-weight: 800;
}

.replay-history-detail__reviews-summary p {
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
  margin-top: 0.25rem;
}

.replay-history-detail__reviews-chevron {
  color: var(--ql-color-text-muted);
  transition: transform 160ms ease;
}

.replay-history-detail__reviews[open] .replay-history-detail__reviews-chevron {
  transform: rotate(180deg);
}

.replay-history-detail__reviews-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding-top: 1rem;
}

.replay-history-detail__review-section {
  border: 1px solid var(--ql-color-border-soft);
  border-radius: 10px;
  background: var(--ql-color-bg-muted);
  min-width: 0;
  padding: 0.875rem;
}

.replay-history-detail__review-body {
  padding-top: 0.75rem;
}

.replay-history-detail__effective-version {
  margin: 0 0 0.75rem;
  color: var(--ql-accent);
  font-size: 0.6875rem;
  font-weight: 700;
}

.replay-history-detail__review {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.replay-history-detail__review-field--wide {
  grid-column: 1 / -1;
}

.replay-history-detail__review small {
  color: #b45309;
  display: block;
  font-size: 0.6875rem;
  font-weight: 700;
  margin-top: 0.375rem;
}

.replay-history-detail__candidate {
  align-items: flex-start;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.replay-history-detail__candidate-error,
.replay-history-detail__candidate-hint,
.replay-history-detail__candidate-success {
  font-size: 0.75rem;
  line-height: 1.5;
}

.replay-history-detail__candidate-error {
  color: #be123c;
}

.replay-history-detail__candidate-hint {
  color: var(--ql-color-text-muted);
}

.replay-history-detail__candidate-success {
  color: #047857;
}

.replay-history-detail__empty {
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
}

.replay-history-detail__orders {
  display: grid;
  gap: 0.625rem;
}

.replay-history-detail__order-columns {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.replay-history-detail__order-column {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  min-width: 0;
  padding: 0.75rem;
}

.replay-history-detail__order-column h4 {
  color: var(--ql-color-text-body);
  font-size: 0.75rem;
  font-weight: 800;
  margin-bottom: 0.625rem;
}

.replay-history-detail__order-column--buy {
  background: var(--ql-color-danger-soft);
}

.replay-history-detail__order-column--sell {
  background: rgba(236, 253, 245, 0.36);
}

:global(html[data-theme="dark"] .replay-history-detail__order-column--buy) {
  border-color: rgba(248, 113, 113, 0.24);
  background: rgba(248, 113, 113, 0.08);
}

:global(html[data-theme="dark"] .replay-history-detail__order-column--sell) {
  border-color: rgba(52, 211, 153, 0.24);
  background: rgba(52, 211, 153, 0.08);
}

.replay-history-detail__order-empty {
  color: var(--ql-color-text-subtle);
  font-size: 0.75rem;
  margin: 0;
  padding: 1rem 0;
  text-align: center;
}

.replay-history-detail__order {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: var(--ql-color-bg-muted);
  padding: 0.75rem;
}

.replay-history-detail__order header {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--ql-color-text-muted);
  font-size: 0.75rem;
}

.replay-history-detail__order header strong {
  color: var(--ql-color-text-strong);
}

.replay-history-detail__side--buy,
.replay-history-detail__side--sell {
  border-radius: 999px;
  padding: 0.2rem 0.5rem;
  font-size: 0.6875rem;
  font-weight: 800;
}

.replay-history-detail__side--buy {
  color: #b91c1c;
  background: #fef2f2;
}

.replay-history-detail__side--sell {
  color: #047857;
  background: var(--ql-color-success-soft);
}

.replay-history-detail__order-status {
  color: #b45309;
}

.replay-history-detail__score-summary {
  align-items: end;
  box-sizing: border-box;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  list-style: none;
  min-height: 80px;
  padding: 0.5625rem 1rem;
}

.replay-history-detail__score-summary::-webkit-details-marker {
  display: none;
}

.replay-history-detail__score-summary strong {
  color: #1d4ed8;
  font-size: 1.75rem;
  margin-left: 0.5rem;
}

.replay-history-detail__score small {
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
}

.replay-history-detail__score-note {
  color: #166534;
  font-size: 0.6875rem;
  font-weight: 700;
  margin-left: 0.5rem;
}

.replay-history-detail__score-note--retrain {
  color: #b45309;
}

.replay-history-detail__score-summary-side {
  align-items: center;
  display: grid;
  place-items: center;
}

.replay-history-detail__collapse-hint {
  color: #94a3b8 !important;
  font-size: 0.6875rem !important;
  font-weight: 600 !important;
  line-height: 0;
}

.replay-history-detail__collapse-hint--closed,
.replay-history-detail__score:not([open])
  .replay-history-detail__collapse-hint--open {
  display: none;
}

.replay-history-detail__score:not([open])
  .replay-history-detail__collapse-hint--closed {
  display: inline;
}

.replay-history-detail__score-body {
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  padding: 0.875rem 1rem 1rem;
}

.replay-history-detail__algorithm {
  display: block;
  margin-top: 0.25rem;
}

.replay-history-detail__score-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin-bottom: 0.75rem;
  color: var(--ql-color-text-muted);
  font-size: 0.6875rem;
  line-height: 1.5;
}

.replay-history-detail__score-meta-item,
.replay-history-detail__metric-label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
}

.replay-history-detail__metric-label {
  justify-content: space-between;
}

.replay-history-detail__dimensions {
  gap: 0.5rem;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.replay-history-detail__dimensions > div {
  min-height: 64px;
  padding: 0.625rem 0.75rem;
}

.replay-history-detail__dimensions strong,
.replay-history-detail__metrics strong {
  color: var(--ql-color-text-strong);
  display: block;
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}

.replay-history-detail__metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 0.75rem;
}

.replay-history-detail__value--positive {
  color: var(--ql-color-success) !important;
}

.replay-history-detail__data-card--positive {
  border-color: rgba(16, 185, 129, 0.32) !important;
  background: var(--ql-color-success-soft) !important;
  box-shadow: inset 3px 0 0 #10b981;
}

.replay-history-detail__data-card--positive strong {
  color: var(--ql-color-success);
}

.replay-history-detail__not-applicable {
  color: var(--ql-color-text-muted) !important;
}

@media (max-width: 720px) {
  .replay-history-detail__header {
    flex-direction: column;
  }

  .replay-history-detail__actions {
    width: 100%;
    justify-content: flex-start;
  }

  .replay-history-detail__action-error {
    max-width: none;
    text-align: left;
  }

  .replay-history-detail__score-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.5rem;
  }

  .replay-history-detail__score-summary-side {
    align-items: center;
  }

  .replay-history-detail__score-note {
    margin-left: 0.375rem;
  }

  .replay-history-detail__facts,
  .replay-history-detail__order-columns,
  .replay-history-detail__review,
  .replay-history-detail__dimensions,
  .replay-history-detail__metrics {
    grid-template-columns: 1fr;
  }

  .replay-history-detail__review-field--wide {
    grid-column: auto;
  }
}

@media (max-width: 1100px) {
  .replay-history-detail__reviews-grid {
    grid-template-columns: 1fr;
  }
}
</style>
