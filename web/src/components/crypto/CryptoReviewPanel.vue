<script setup>
import { computed, reactive, watch } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiTextarea from '../ui/UiTextarea.vue';
import CryptoModelNotice from './CryptoModelNotice.vue';
import { amount, exact, eventName, relativeTime, commandName, eventReason } from '../../utils/cryptoReplayPresentation.js';
const props = defineProps({ session: { type: Object, required: true }, traces: { type: Array, default: () => [] }, ledger: { type: Array, default: () => [] }, busy: Boolean, blocked: Boolean, analysis: { type: Object, default: null }, analysisError: { type: String, default: '' } });
const emit = defineEmits(['blind', 'reveal', 'post', 'retrain']);
const draft = reactive({ thesis: '', tradePlan: '', observation: '', executionLesson: '', nextAttempt: '' });
watch(() => props.session.id, () => { const blind = props.session.blindReview, post = props.session.trainingJournal.postReview; Object.assign(draft, { thesis: blind?.thesis ?? '', tradePlan: blind?.tradePlan ?? '', observation: post?.observation ?? '', executionLesson: post?.executionLesson ?? '', nextAttempt: post?.nextAttempt ?? '' }); }, { immediate: true });
const liquidations = computed(() => props.traces.filter((e) => e.type === 'teaching-liquidation'));
const interesting = computed(() => props.traces.filter((e) => e.type !== 'funding-skipped'));
const metrics = computed(() => props.analysis?.analysis);
const returnPercent = computed(() => metrics.value?.returnPercent ?? Number(props.session.summary.netPnl) / Number(props.session.config.startingCash) * 100);
const disabled = computed(() => props.busy || props.blocked);
</script>
<template>
  <section class="crypto-review" aria-label="合约复盘">
    <header><p class="eyebrow">记录判断，再揭晓</p><h2>这次练习，留下什么？</h2><span>{{ session.attemptInfo.kind === 'first' ? '首次练习' : `复练 · 第 ${session.attemptInfo.attemptNumber} 次` }}</span></header>
    <CryptoModelNotice location="review" />
    <div class="review-facts">
      <div><span>净盈亏（含浮动）</span><strong data-testid="crypto-net-pnl">{{ exact(session.summary.netPnl) }}</strong></div>
      <div><span>账户收益率 · 教学结算口径</span><strong data-testid="crypto-return-percent">{{ amount(returnPercent, 4) }}%</strong></div>
      <div><span>最大回撤 · 分钟及资金动作后</span><strong data-testid="crypto-max-drawdown">{{ metrics ? amount(metrics.maxDrawdownPercent, 4) + '%' : '揭晓后核对' }}</strong></div>
      <div><span>滑点归因（已含于成交价）</span><strong data-testid="crypto-slippage-attribution">{{ exact(session.totals.slippageAttribution) }}</strong></div>
      <div><span>普通成交手续费</span><strong>{{ exact(session.totals.tradingFees) }}</strong></div>
      <div><span>资金费净支出</span><strong>{{ exact(session.totals.fundingPayments) }}</strong></div>
      <div><span>教学接管合计</span><strong>{{ exact(session.totals.liquidationAggregatePnl) }}</strong></div>
    </div>
    <p class="muted">单位 USDT，保留内部 8 位用于核对。资金费负数表示净收入；滑点已经体现在成交价格中，不再次扣费。追加保证金不计收入。</p>
    <p v-if="analysisError" class="analysis-error" role="status">{{ analysisError }}</p>
    <section v-if="metrics" class="plan-comparison" data-testid="crypto-plan-comparison">
      <h3>入场计划与实际退出</h3>
      <p class="muted">按每笔入场委托提交时的退出计划、实际成交数量累计；同向加仓和部分退出合并为一段持仓。此处比较价格损益，未含手续费和资金费；手动计划、mark 触发价均不保证实际成交价。调整轨迹仍保留在下方记录中。</p>
      <p v-if="!metrics.trades.length" class="muted">本次未发生交易，没有计划损失比较项；净盈亏与回撤按实际账户核对。</p>
      <ol class="plan-rows">
        <li v-for="(trade, index) in metrics.trades" :key="index">
        <strong>{{ trade.side === 'long' ? '多' : '空' }} · 累计入场 {{ trade.contracts }} 张 · {{ relativeTime(trade.entryMinute) }} → {{ relativeTime(trade.exitMinute) }}</strong>
        <dl><div><dt>入场计划价格损益</dt><dd>{{ trade.plannedPricePnl ?? '未定义：部分或全部入场缺少退出价' }}</dd></div><div><dt>实际价格损益</dt><dd>{{ trade.actualPricePnl ?? '教学接管，无真实清算成交价' }}</dd></div><div><dt>实际 − 计划</dt><dd>{{ trade.pricePnlDifference ?? '不可比较' }}</dd></div></dl>
        <p v-if="trade.exitKind === 'training-end'" class="muted">含训练结束退出，单独标记，不当作用户策略判断。</p>
        <p v-if="trade.comparisonStatus === 'different-settlement-model'" class="muted">教学接管为独立结算口径，不把参考 mark 盈亏伪装成实际清算成交损益。</p>
        </li>
      </ol>
      <p class="muted" data-testid="crypto-review-sampling">回撤核对 {{ metrics.equitySamples }} 个已执行分钟收盘及资金动作后权益采样点，至 {{ relativeTime(metrics.sampledThroughMinute) }}；不是分钟内或逐笔最大回撤。追加保证金仅作内部划转；收益率含教学结算，缺口豁免 {{ metrics.deficitWaiverMemo }} 仅作备忘，不计盈利次数或能力得分。</p>
    </section>
    <section v-for="event in liquidations" :key="event.sequence" class="settlement" data-testid="crypto-settlement">
      <h3>教学强平接管 · {{ relativeTime(event.observedAtMinute) }}</h3>
      <p>mark 风险达到阈值，撤销相关委托并复核后仍不安全，按教学规则全额接管。</p>
      <CryptoModelNotice location="settlement" />
      <dl class="settlement-facts">
        <div><dt>接管前 M</dt><dd>{{ amount(-Number(event.settlement.aggregateSettlementPnl), 8) }}</dd></div>
        <div><dt>合计结算（只记一次）</dt><dd>{{ exact(event.settlement.aggregateSettlementPnl) }}</dd></div>
        <div><dt>该动作后仓外可用</dt><dd>{{ exact(event.availableBalanceAfterAction) }}</dd></div>
        <div><dt>参考 mark</dt><dd>{{ exact(event.settlement.reference.markPrice) }}</dd></div>
        <div><dt>参考价格盈亏</dt><dd>{{ exact(event.settlement.reference.pricePnl) }}</dd></div>
        <div><dt>参考 taker 费（不另扣）</dt><dd>{{ exact(event.settlement.reference.takerFee) }}</dd></div>
        <div><dt>教学剩余权益扣除 W</dt><dd>{{ exact(event.settlement.reference.remainingEquityWriteoff) }}</dd></div>
        <div><dt>教学缺口豁免 S</dt><dd>{{ exact(event.settlement.reference.deficitWaiver) }}</dd></div>
        <div><dt>实际清算成交价</dt><dd>未知</dd></div><div><dt>官方清算费</dt><dd>未知</dd></div>
      </dl>
      <p class="muted">参考价格盈亏 − 参考 taker 费 − W + S = 合计结算。上述参考拆分均不再次入账。</p>
      <p class="waiver">不向仓外追扣为教学约定，不是实盘赔付承诺；缺口豁免不算交易盈利，也不计作盈利次数或交易能力得分。</p>
    </section>
    <div v-if="session.status !== 'completed'" class="muted">完成退出后提交首次盲评。结束受阻仍有仓位时，不能揭晓或复练。</div>
    <form v-else-if="!session.blindReview" @submit.prevent="emit('blind', { thesis: draft.thesis, tradePlan: draft.tradePlan })">
      <h3>首次盲评</h3><p class="muted">先记录当时的判断和执行计划，再看完整行情。提交后保留原记录。</p>
      <label>我看到了什么？<UiTextarea v-model="draft.thesis" aria-label="盲评判断" required maxlength="4000" :disabled="disabled" /></label>
      <label>交易或不交易计划<UiTextarea v-model="draft.tradePlan" aria-label="盲评交易计划" required maxlength="4000" :disabled="disabled" /></label>
      <UiButton type="submit" :disabled="disabled" variant="secondary">保存首次盲评</UiButton>
    </form>
    <section v-else>
      <h3>已冻结的盲评</h3><p class="preserve">{{ session.blindReview.thesis }}</p><p class="preserve">{{ session.blindReview.tradePlan }}</p>
      <UiButton v-if="!session.revealed" :disabled="disabled" @click="emit('reveal')">揭晓完整行情</UiButton>
    </section>
    <template v-if="session.revealed">
      <p class="muted">已揭晓：{{ new Date(session.reveal.replayStartMs).toISOString() }} 起；数据 {{ session.reveal.dataVersion }}。图表可读完整窗口，账户结果保持原样。</p>
      <form v-if="!session.trainingJournal.postReview" @submit.prevent="emit('post', { observation: draft.observation, executionLesson: draft.executionLesson, nextAttempt: draft.nextAttempt })">
        <h3>揭晓后的自评</h3>
        <label>行情与原判断有什么差异？<UiTextarea v-model="draft.observation" aria-label="复盘观察" required maxlength="4000" :disabled="disabled" /></label>
        <label>计划与实际执行有什么偏差？<UiTextarea v-model="draft.executionLesson" aria-label="执行偏差" required maxlength="4000" :disabled="disabled" /></label>
        <label>下次只改哪一件事？<UiTextarea v-model="draft.nextAttempt" aria-label="下次行动" required maxlength="4000" :disabled="disabled" /></label>
        <UiButton type="submit" variant="secondary" :disabled="disabled">保存事后复盘</UiButton>
      </form>
      <section v-else><h3>已保存的事后复盘</h3><p v-for="(value, key) in session.trainingJournal.postReview" :key="key" class="preserve">{{ value }}</p><p class="muted">原自评保留，不因盈亏自动判错或改写。</p></section>
      <section v-if="session.firstAttempt" data-testid="crypto-first-comparison"><h3>与首次练习比较</h3><p>首次净盈亏 {{ exact(session.firstAttempt.summary.netPnl) }} USDT / 本次 {{ exact(session.summary.netPnl) }} USDT</p><p v-if="analysis?.first" class="muted">首次 / 本次收益率 {{ amount(analysis.first.returnPercent, 4) }}% / {{ amount(metrics.returnPercent, 4) }}%；最大回撤 {{ amount(analysis.first.maxDrawdownPercent, 4) }}% / {{ amount(metrics.maxDrawdownPercent, 4) }}%。原资金结果不改写，参数不同不直接判定能力提升。</p><p class="preserve">首次判断：{{ session.firstAttempt.blindReview?.thesis }}</p><p class="muted">首次资金/杠杆/滑点：{{ session.firstAttempt.config.startingCash }}/{{ session.firstAttempt.config.leverage }}/{{ session.firstAttempt.config.slippageBps }} bps；参数不同时只作条件对照。复练是已见行情，单独保留，不混入首次成绩。</p></section>
      <UiButton :disabled="disabled" @click="emit('retrain')">按原版本复练</UiButton>
    </template>
    <details><summary>操作理由与计划记录（{{ session.trainingJournal.decisions.length }}）</summary><ol><li v-for="d in session.trainingJournal.decisions" :key="d.actionId"><strong>{{ relativeTime(d.cursorMinute) }}</strong> · {{ commandName(d.command.type) }}<p>{{ d.note || '未填写理由' }}</p><span class="muted">当时计划：{{ d.plan.mode === 'manual' ? `手动退出 ${d.plan.manualExitPrice}` : '未设手动退出价' }}</span></li></ol></details>
    <details open><summary>执行与风险事件（{{ interesting.length }}）</summary><ol class="timeline"><li v-for="e in interesting" :key="e.sequence"><span class="muted">{{ relativeTime(e.observedAtMinute) }}</span><strong>{{ eventName(e.type) }}</strong><span v-if="e.quote">{{ e.quote.contracts }} 张 @ {{ e.quote.fillPrice }} / {{ e.quote.liquidityRole }} / 费 {{ e.quote.fee }}</span><span v-if="e.payment">资金费 {{ e.payment }} / 结算率 {{ e.settledRate }}；mark 为事件前已完成分钟代理</span><span v-if="e.type === 'intraminute-ambiguity'">分钟内次序不明，执行冻结的较低权益路径，不宣称还原实盘先后。</span><span v-if="e.reason" class="muted">{{ eventReason(e.reason) }}</span></li></ol></details>
    <details><summary>资金账本（{{ ledger.length }} 个动作）</summary><div class="table-scroll"><table><caption>每动作实际资金桶变动；参考拆分不重复入账，单位 USDT</caption><thead><tr><th>版本</th><th>分钟</th><th>可用变化</th><th>冻结变化</th><th>保证金变化</th><th>手续费</th><th>资金费</th><th>接管合计</th></tr></thead><tbody><tr v-for="entry in ledger" :key="entry.actionId"><td>{{ entry.revision }}</td><td>{{ entry.cursorMinute }}</td><td>{{ entry.availableDelta }}</td><td>{{ entry.reservedDelta }}</td><td>{{ entry.marginDelta }}</td><td>{{ entry.feesDelta }}</td><td>{{ entry.fundingDelta }}</td><td>{{ entry.liquidationDelta }}</td></tr></tbody></table></div></details>
    <details><summary>冻结规则与完整差异</summary><p>规则 {{ session.frozenRules.ruleVersion }}；执行 {{ session.executionModelVersion }}；接管 {{ session.frozenRules.liquidationModelVersion }}。固定 Maker {{ Number(session.frozenRules.makerRate)*100 }}% / Taker {{ Number(session.frozenRules.takerRate)*100 }}%；单边滑点 {{ session.frozenRules.slippageBps }} bps。</p><p>规则为冻结训练基线，不等同于当时或你的账户实际规则。分钟行情不能重建盘口/排队/逐笔接管、动态价格限制或 ADL；资金费 mark 为事件前已完成分钟代理。同一分钟多个可达事件采用明确的保守路径。</p></details>
  </section>
</template>
<style scoped>
.crypto-review { border: 1px solid var(--ql-line-strong); border-radius: 10px; padding: 22px; background: var(--ql-panel); min-width: 0; }header { margin-bottom: 18px; }h2 { margin: 5px 0 8px; font-size: 22px; letter-spacing: -.03em; }h3 { font-size: 15px; margin: 18px 0 10px; }.eyebrow { font-size: 11px; color: var(--ql-accent); font-weight: 700; }header > span { font-size: 12px; color: var(--ql-color-text-muted); }
.review-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }.review-facts span { display: block; color: var(--ql-color-text-muted); font-size: 12px; margin-bottom: 6px; }.review-facts strong { font-size: 16px; font-variant-numeric: tabular-nums; }
.muted { color: var(--ql-color-text-muted); font-size: 12px; line-height: 1.8; }label { display: block; font-size: 13px; margin: 16px 0; }textarea { margin-top: 8px; }.preserve { white-space: pre-wrap; font-size: 13px; line-height: 1.9; overflow-wrap: anywhere; }.settlement { border: 1px solid #d97706; padding: 15px; border-radius: 8px; margin: 18px 0; } .settlement > p { font-size: 12px; line-height: 1.8; }.settlement-facts { font-size: 12px; }.settlement-facts > div { display: flex; justify-content: space-between; gap: 15px; padding: 5px 0; }dd { margin: 0; font-variant-numeric: tabular-nums; }.waiver { font-weight: 600; }
details { margin-top: 20px; border-top: 1px solid var(--ql-line); padding-top: 15px; font-size: 12px; line-height: 1.8; }summary { cursor: pointer; font-weight: 650; }li { padding: 10px 0; }li p { margin: 5px 0; }.timeline { padding-left: 20px; }.timeline li { border-bottom: 1px solid var(--ql-line); }.timeline li > * { display: block; }.timeline strong { margin: 3px 0; }.table-scroll { overflow: auto; }table { border-collapse: collapse; width: 100%; white-space: nowrap; font-variant-numeric: tabular-nums; }td,th { padding: 8px; border-bottom: 1px solid var(--ql-line); text-align: right; }caption { text-align: left; padding: 10px 0; color: var(--ql-color-text-muted); }
@media(max-width:600px) { .crypto-review { padding: 14px; }.review-facts strong { font-size: 14px; } }
</style>

<style scoped>
.analysis-error { color: #b91c1c; font-size: 12px; }
.plan-comparison { margin: 18px 0; border-top: 1px solid var(--ql-line); }
.plan-rows { padding-left: 18px; font-size: 12px; }
.plan-rows dl > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 5px 0; }
.plan-rows dd { margin: 0; font-variant-numeric: tabular-nums; }
</style>
