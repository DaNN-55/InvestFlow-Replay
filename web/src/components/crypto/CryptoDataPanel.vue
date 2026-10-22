<script setup>
import { computed, ref, watch } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import UiModal from '../ui/UiModal.vue';
import CryptoModelNotice from './CryptoModelNotice.vue';
import { api } from '../../services/api.js';
import './crypto-terminal.css';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);
const pool = ref(null);
const error = ref('');
const busy = ref(false);
const name = computed(() => pool.value?.mode === 'history-pool'
  ? 'OKX 历史数据池'
  : pool.value?.mode === 'legacy-sample' ? '冻结教学小样' : '行情数据未就绪');

async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try { pool.value = await api.cryptoPool(); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
watch(() => props.open, value => { if (value) refresh(); });
</script>

<template>
  <UiModal :open="open" title="行情数据" description="数据池、来源与训练规则；已有练习沿用原冻结版本。" panel-class="crypto-controls crypto-data-modal" @close="emit('close')">
    <div class="crypto-data-heading">
      <strong>{{ name }}</strong>
      <button type="button" class="crypto-icon" aria-label="刷新数据状态" title="刷新数据状态" :disabled="busy" @click="refresh"><RefreshCw :size="15" /></button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">正在读取数据状态…</p>
    <template v-if="pool">
      <section class="crypto-data-group">
        <h3>练习场景</h3>
        <dl>
          <div><dt>背景行情</dt><dd>90 天</dd></div>
          <div><dt>单次回放</dt><dd>72 小时</dd></div>
          <div v-if="pool.mode==='history-pool'"><dt>已准入场景</dt><dd>{{ pool.admittedWindows }} 个</dd></div>
          <div v-for="item in pool.instruments??[]" :key="item.instrumentId"><dt>{{ item.instrumentId }}</dt><dd>{{ item.unseenWindows }} 个未见场景</dd></div>
        </dl>
        <p v-if="pool.mode==='legacy-sample'">当前是 BTC/ETH 冻结小样，不代表完整历史数据池；同窗再次练习将列为复练。</p>
        <p v-else-if="pool.mode!=='history-pool'">本地数据尚未就绪或校验失败。已有练习仍可从演练记录恢复。</p>
      </section>
      <details v-if="pool.coverage?.instruments?.length" class="crypto-data-details">
        <summary>合约样本覆盖</summary>
        <p>覆盖天数与可练场景分别统计；缺口或未准入场景不用于新练习。</p>
        <article v-for="item in pool.coverage.instruments" :key="item.instrumentId">
          <strong>{{ item.instrumentId }}</strong>
          <section v-for="year in item.years" :key="year.year" class="crypto-data-group">
            <h3>{{ year.year }} 年</h3>
            <dl>
              <div><dt>最新价 K 线</dt><dd>{{ year.lastDays }} / {{ year.targetDays }} 天</dd></div>
              <div><dt>标记价格 K 线</dt><dd>{{ year.markDays }} / {{ year.targetDays }} 天</dd></div>
              <div><dt>资金费归档</dt><dd>{{ year.fundingArchiveDays }} / {{ year.targetDays }} 天</dd></div>
            </dl>
          </section>
        </article>
      </details>
    </template>
    <details class="crypto-data-details">
      <summary>数据来源与冻结版本</summary>
      <p>来源为 OKX 历史归档，最新价 K 线、标记价格 K 线与资金费归档分别校验。来源覆盖不等于可练场景数量。</p>
      <p>继续练习和复练沿用原数据与规则版本。这里只展示总体覆盖；本局隐藏日期与版本信息在揭晓后显示。</p>
      <p>分钟内的盘口、排队、成交先后及 ADL 不能由分钟 K 线重建。</p>
    </details>
    <details class="crypto-data-details">
      <summary>训练规则与教学结算</summary>
      <CryptoModelNotice location="setup" />
      <h3>强平与保证金</h3><CryptoModelNotice location="risk" />
      <h3>资金与结果</h3><CryptoModelNotice location="review" />
      <p>成交、资金费、保护触发或教学强平后会暂停。手动退出计划只记录判断；自动止盈止损以委托指定的价格类型触发，切换图表不会改变它。</p>
      <p>各周期只聚合服务端已展示分钟；所有图共用同一个训练进度。</p>
    </details>
    <footer v-if="pool" class="crypto-data-footer"><p>{{ pool.note }}</p><span>池版本：{{ pool.poolVersion??'冻结小样' }}</span></footer>
  </UiModal>
</template>

<style>
.ui-modal__panel.crypto-data-modal { width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 48px);min-height:0; }
.crypto-data-modal .ui-modal__header { padding:16px 18px; }
.crypto-data-modal .ui-modal__header h2 { font-size:16px; }
.crypto-data-modal .ui-modal__body { padding:14px 18px; }
.crypto-data-heading { display:flex;align-items:center;justify-content:space-between;gap:12px; }
.crypto-data-heading strong { font-size:13px;font-weight:600; }
.crypto-data-heading .crypto-icon { width:28px;height:28px;min-height:28px;border:0;background:var(--ql-paper-soft); }
.crypto-data-modal h3 { margin:0 0 7px;color:var(--ql-color-text-muted);font-size:11px;font-weight:600; }
.crypto-data-modal p { margin:7px 0;font-size:11px;line-height:1.6; }
.crypto-data-group { padding:12px 0; }
.crypto-data-group dl { display:grid;gap:7px;margin:0; }
.crypto-data-group dl>div { display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:11px; }
.crypto-data-group dt { color:var(--ql-color-text-muted); }
.crypto-data-group dd { margin:0;text-align:right;font-variant-numeric:tabular-nums; }
.crypto-data-details { margin-top:10px;padding-top:10px;border-top:1px solid var(--ql-line); }
.crypto-data-details summary { display:flex;align-items:center;justify-content:space-between;min-height:30px;font-size:12px;font-weight:600;list-style:none; }
.crypto-data-details summary::-webkit-details-marker { display:none; }
.crypto-data-details summary::after { content:'⌄';color:var(--ql-color-text-muted); }
.crypto-data-details[open] summary::after { transform:rotate(180deg); }
.crypto-data-details article { padding:12px 0;border-bottom:1px solid var(--ql-line); }
.crypto-data-details article>strong { font-size:12px;font-weight:600; }
.crypto-data-details .crypto-model-notice { margin-top:10px;padding:8px 10px;font-size:11px; }
.crypto-data-details>h3 { margin-top:14px; }
.crypto-data-footer { margin-top:12px;padding-top:10px;border-top:1px solid var(--ql-line);color:var(--ql-color-text-muted);font-size:10px;line-height:1.6;overflow-wrap:anywhere; }
@media(max-width:640px) { .ui-modal__panel.crypto-data-modal { border-radius:12px; } }
</style>
