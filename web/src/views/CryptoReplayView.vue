<script setup>
import { computed, onActivated, shallowRef, watch } from 'vue';
import { api } from '../services/api.js';
import UiButton from '../components/ui/UiButton.vue';
import UiSelect from '../components/ui/UiSelect.vue';
import CandlestickChart from '../components/CandlestickChart.vue';
import CryptoSetupPanel from '../components/crypto/CryptoSetupPanel.vue';
import CryptoTradingPanel from '../components/crypto/CryptoTradingPanel.vue';
import CryptoReviewPanel from '../components/crypto/CryptoReviewPanel.vue';
import CryptoModelNotice from '../components/crypto/CryptoModelNotice.vue';
import { createCryptoReplayController } from '../utils/cryptoReplayController.js';
import { amount, CRYPTO_PERIODS, cryptoChartBars, cryptoChartLines, relativeTime } from '../utils/cryptoReplayPresentation.js';
const state = shallowRef({});
const controller = createCryptoReplayController({ api, storage: localStorage, changed: (value) => { state.value = value; } });
state.value = { ...controller.state };
const kind = shallowRef('last');
const bars = computed(() => cryptoChartBars(state.value.market, kind.value));
const s = computed(() => state.value.session);
const priceLines = computed(() => cryptoChartLines(s.value, kind.value));
const otherPriceLines = computed(() => cryptoChartLines(s.value).filter(line => line.reference !== kind.value));
const locked = computed(() => state.value.busy || Boolean(state.value.pending));
const selectableHistory = computed(() => state.value.history ?? []);
function command(value, note = '') { return controller.act('command', { command: value, ...(note ? { note } : {}) }); }
watch(() => s.value?.id, () => window.scrollTo({ top: 0 }));
onActivated(() => controller.sync());
</script>
<template>
  <div class="crypto-workspace" :aria-busy="state.busy">
    <header class="crypto-header"><div><p class="eyebrow">决策台 / 合约盲测</p><h1>{{ s ? s.instrumentId : '合约练习' }} <span v-if="s">逐仓 · 单向</span></h1></div><div class="header-actions"><UiSelect aria-label="恢复历史合约练习" :model-value="s?.id ?? ''" :disabled="state.busy" @update:model-value="controller.select($event)"><option disabled value="">恢复历史练习</option><option v-for="h in selectableHistory" :key="h.id" :value="h.id">{{ h.instrumentId }} · {{ h.attemptInfo.kind === 'first' ? '首次' : '复练' }} #{{ h.attemptInfo.attemptNumber }} · {{ h.status === 'completed' ? '已结束' : '进行中' }}</option></UiSelect><UiButton v-if="s" variant="secondary" :disabled="locked" @click="controller.fresh()">新开一局</UiButton></div></header>
    <div v-if="state.error" class="crypto-error" role="alert">{{ state.error }}<UiButton v-if="!state.pending" variant="secondary" :disabled="state.busy" @click="controller.sync()">重新同步</UiButton></div>
    <div v-if="state.pending && !state.busy" class="crypto-pending" role="status">有一个动作的结果待核对。可以查看历史练习；请重试原动作，核对前不能提交新操作。<UiButton variant="secondary" @click="controller.retry()">重试原动作</UiButton></div>
    <p v-if="state.busy" class="muted" role="status">正在保存与同步…</p>
    <p v-else-if="state.notice" class="muted" role="status">{{ state.notice }}</p>
    <p v-if="state.poolError" class="muted" role="status">{{ state.poolError }}</p>
    <CryptoSetupPanel v-if="!s" :busy="state.busy" :pool="state.pool" :blocked="Boolean(state.pending) || Boolean(state.poolError)" @create="controller.act('create', $event)" />
    <template v-else>
      <CryptoModelNotice location="setup" />
      <div class="crypto-account" data-testid="crypto-account"><div><span>账户权益 · USDT</span><strong>{{ amount(s.summary.accountEquity, 8) }}</strong></div><div><span>仓外可用</span><strong data-testid="crypto-available">{{ s.account.availableBalance }}</strong></div><div><span>委托冻结</span><strong>{{ amount(s.reservedBalance, 8) }}</strong></div><div><span>本次净盈亏</span><strong>{{ amount(s.summary.netPnl, 8) }}</strong></div></div>
      <div class="crypto-progress"><span>{{ relativeTime(s.elapsedMinutes) }} · 已展示 {{ s.elapsedMinutes }}/{{ s.gameLength }} 分钟</span><span>{{ s.config.leverage }} 倍 · {{ s.attemptInfo.kind === 'first' ? '首次练习' : `已见复练 #${s.attemptInfo.attemptNumber}` }}</span><progress :value="s.elapsedMinutes" :max="s.gameLength" aria-label="训练进度" /></div>
      <div class="crypto-grid">
        <div class="crypto-main">
          <section class="crypto-chart">
            <div class="chart-toolbar"><h2>观察行情</h2><UiSelect v-model="kind" aria-label="图表价格"><option value="last">普通价格 last</option><option value="mark">标记价格 mark</option></UiSelect><UiSelect aria-label="K线周期" :model-value="String(state.timeframe)" :disabled="state.busy" @update:model-value="controller.period($event)"><option v-for="[value,label] in CRYPTO_PERIODS" :key="value" :value="String(value)">{{ label }}</option></UiSelect></div>
            <div class="crypto-quotes"><span>普通价格 <strong data-testid="crypto-last">{{ amount(s.currentPrices.last, 4) }}</strong></span><span>标记价格 <strong>{{ amount(s.currentPrices.mark, 4) }}</strong></span></div>
            <p class="muted">90 天背景，72 小时练习与一个结束执行分钟。仅聚合服务端已知分钟；形成中 K 线只含已知部分。图表显示最近 {{ bars.length }} / {{ state.market?.availableBars ?? 0 }} 根，1day 可观察完整背景。</p>
            <CandlestickChart v-if="state.market" :key="`${s.id}:${state.timeframe}:${kind}`" :bars="bars" :price-lines="priceLines" />
            <p v-else role="status">正在同步已展示行情…</p>
            <p v-if="otherPriceLines.length" class="muted">另有 {{ otherPriceLines.length }} 条计划/委托/保护使用另一价格流；请切换图表价格查看，触发参考不会随图表切换改变。</p>
            <div class="advance-bar"><UiButton :disabled="locked || s.status !== 'active'" @click="controller.act('advance', { minutes: 1 })">推进 1 分钟</UiButton><UiButton variant="secondary" :disabled="locked || s.status !== 'active'" @click="controller.act('advance', { minutes: 5 })">推进 5 分钟</UiButton><UiButton variant="secondary" :disabled="locked || s.status !== 'active'" @click="controller.act('advance', { minutes: 15 })">推进 15 分钟</UiButton><UiButton variant="secondary" :disabled="locked || s.status !== 'active' || s.ending" @click="controller.act('finish')">结束并退出</UiButton></div>
            <p class="muted">成交、持仓资金费、保护触发或教学强平后自动暂停在该分钟；一次点击未必推进满所选分钟。结束平仓也受容量限制。</p>
            <p v-if="s.ending" role="status" class="end-warning">{{ s.status === 'end-blocked' ? '结束受阻：预留分钟容量不足，仍有仓位；保留该状态，不能揭晓或复练。' : '正在结束：继续推进以退出剩余仓位，不再新开仓。' }}</p>
          </section>
          <CryptoReviewPanel :key="s.id" :session="s" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" :busy="state.busy" :blocked="Boolean(state.pending)" @blind="controller.act('blind', { review: $event })" @reveal="controller.act('reveal')" @post="controller.act('post', { review: $event })" @retrain="controller.act('retrain')" />
        </div>
        <CryptoTradingPanel :key="s.id" :session="s" :preview-order="api.cryptoPreview" :busy="state.busy" :blocked="Boolean(state.pending)" @command="command" />
      </div>
    </template>
  </div>
</template>
<style scoped>
.crypto-workspace :deep(.ql-ui-control) { min-height: 40px; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; box-shadow: none; color: #344054; font-size: 13px; }
.crypto-workspace :deep(.ql-ui-control:focus) { border-color: #2563eb; box-shadow: 0 0 0 3px rgb(37 99 235 / 14%); }
.crypto-workspace :deep(.ql-ui-control:disabled) { background: #f2f4f7; }
.crypto-workspace :deep(.ql-ui-button) { min-height: 40px; border-radius: 8px; font-size: 13px; }
.crypto-workspace { display: flex; flex-direction: column; gap: 16px; padding-top: 22px; min-width: 0; }.crypto-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }.eyebrow { margin: 0 0 6px; color: var(--ql-accent); font-size: 11px; font-weight: 700; }h1 { margin: 0; font-size: 27px; letter-spacing: -.035em; }h1 span { font-size: 12px; font-weight: 500; color: var(--ql-color-text-muted); margin-left: 10px; }.header-actions { display: flex; gap: 10px; min-width: 0; }.header-actions > :first-child { max-width: 300px; }
.crypto-account { display: grid; grid-template-columns: repeat(4,1fr); gap: 20px; border-block: 1px solid var(--ql-line); padding: 18px 0; min-width: 0; }.crypto-account span { display: block; font-size: 12px; color: var(--ql-color-text-muted); margin-bottom: 7px; }.crypto-account strong { font-size: clamp(14px,1.65vw,22px); font-variant-numeric: tabular-nums; letter-spacing: -.02em; overflow-wrap: anywhere; }
.crypto-progress { display: flex; align-items: center; gap: 20px; font-size: 12px; color: var(--ql-color-text-muted); flex-wrap: wrap; }progress { width: 180px; height: 5px; accent-color: var(--ql-accent); }
.crypto-grid { display: grid; grid-template-columns: minmax(0,1fr) 365px; gap: 20px; align-items: start; }.crypto-main { display: flex; flex-direction: column; gap: 20px; min-width: 0; }.crypto-chart { min-width: 0; padding: 18px; border: 1px solid var(--ql-line-strong); border-radius: 10px; background: var(--ql-panel); }.chart-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }.chart-toolbar h2 { margin: 0 auto 0 0; font-size: 16px; }.crypto-quotes { display: flex; gap: 25px; margin: 20px 0 0; font-size: 12px; color: var(--ql-color-text-muted); }.crypto-quotes strong { margin-left: 6px; color: var(--ql-ink); font-variant-numeric: tabular-nums; }.advance-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }.muted { margin: 7px 0; color: var(--ql-color-text-muted); font-size: 12px; line-height: 1.8; }.crypto-error { padding: 12px; border: 1px solid #dc2626; border-radius: 8px; display: flex; align-items: center; gap: 15px; font-size: 13px; }.crypto-pending,.end-warning { padding: 12px; background: var(--ql-color-primary-soft); font-size: 13px; line-height: 1.8; }
@media(max-width:1050px) { .crypto-grid { display: flex; flex-direction: column; }.crypto-main { display: contents; }.crypto-chart { width: 100%; }.crypto-grid > aside { order: 1; width: 100%; }.crypto-grid :deep(.crypto-review) { order: 2; width: 100%; }.crypto-account { grid-template-columns: 1fr 1fr; }.crypto-header { align-items: flex-start; flex-direction: column; }.header-actions { width: 100%; }.header-actions > :first-child { max-width: none; flex: 1; } }
@media(max-width:600px) { .crypto-chart { padding: 12px; }h1 { font-size: 23px; }.crypto-account { gap: 16px 8px; }.crypto-error { align-items: flex-start; flex-direction: column; } }
</style>
