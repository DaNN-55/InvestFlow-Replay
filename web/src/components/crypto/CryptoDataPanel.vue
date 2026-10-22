<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown, Database, RefreshCw } from 'lucide-vue-next';
import { api } from '../../services/api.js';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close', 'toggle']);
const root = ref(null);
const trigger = ref(null);
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
function outside(event) {
  if (props.open && !root.value?.contains(event.target)) emit('close');
}
function escape(event) {
  if (!props.open || event.key !== 'Escape') return;
  if (root.value?.contains(document.activeElement)) trigger.value?.focus();
  emit('close');
}
watch(() => props.open, value => { if (value) refresh(); });
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', escape);
});
</script>

<template>
  <div ref="root" class="crypto-data-popover">
    <button ref="trigger" type="button" class="crypto-data-trigger" :class="{'crypto-data-trigger--warning':error || pool?.ready===false}" aria-label="合约行情数据" title="合约行情数据" :aria-expanded="open" aria-controls="crypto-data-panel" @click="emit('toggle')"><Database :size="17" /></button>
    <section v-if="open" id="crypto-data-panel" class="crypto-data-panel" role="region" aria-labelledby="crypto-data-title">
      <header class="crypto-data-heading">
        <div><strong id="crypto-data-title">行情数据</strong><p>{{ busy ? '正在读取数据状态…' : name }}</p></div>
        <button type="button" aria-label="刷新数据状态" title="刷新" :disabled="busy" @click="refresh"><RefreshCw :size="15" /></button>
      </header>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="pool">
        <section class="crypto-data-group">
          <h3>练习场景</h3>
          <dl>
            <div><dt>固定窗口</dt><dd>90 天背景 / 72 小时回放</dd></div>
            <div v-if="pool.mode==='history-pool'"><dt>已准入</dt><dd>{{ pool.admittedWindows }} 段</dd></div>
            <div v-for="item in pool.instruments??[]" :key="item.instrumentId"><dt>{{ item.instrumentId }}</dt><dd>{{ item.unseenWindows == null ? '冻结小样' : `${item.unseenWindows} 段可首次盲测` }}</dd></div>
          </dl>
          <p v-if="pool.mode==='legacy-sample'">仅冻结小样；同一片段再次练习计为复练。</p>
          <p v-else-if="pool.mode!=='history-pool'">数据未就绪；已有练习仍可继续。</p>
        </section>
        <details v-if="pool.coverage?.instruments?.length" class="crypto-data-details">
          <summary>合约样本覆盖<ChevronDown :size="14" /></summary>
          <article v-for="item in pool.coverage.instruments" :key="item.instrumentId">
            <strong>{{ item.instrumentId }}</strong>
            <dl v-for="year in item.years" :key="year.year">
              <div><dt>{{ year.year }} · 最新价</dt><dd>{{ year.lastDays }}/{{ year.targetDays }} 天</dd></div>
              <div><dt>标记价格</dt><dd>{{ year.markDays }}/{{ year.targetDays }} 天</dd></div>
              <div><dt>资金费归档</dt><dd>{{ year.fundingArchiveDays }}/{{ year.targetDays }} 天</dd></div>
            </dl>
          </article>
        </details>
      </template>
      <details class="crypto-data-details">
        <summary>数据来源与冻结版本<ChevronDown :size="14" /></summary>
        <p>OKX 历史归档：最新价、标记价和资金费分别校验。继续与复练沿用开局版本；本局日期在揭晓后显示。两种价格图下方均显示同时间段的真实成交量（张）。</p>
      </details>
      <details class="crypto-data-details">
        <summary>训练规则与教学结算<ChevronDown :size="14" /></summary>
        <p>逐仓单向，按已展示分钟撮合，不还原盘口、排队或 ADL。手动计划只记录，止盈止损按委托参考价触发。</p>
        <p>教学强平全仓关闭，仓内保证金不返还、不向仓外追扣，费用不重复扣；实盘可能部分减仓或返还余额。追加保证金同样承担损失，仓外不自动补入；估算强平价不保证成交。</p>
        <p>结果包含教学强平损失，不是实盘清算账单。资金费按数据结算；成交和风险事件后暂停。</p>
      </details>
      <footer v-if="pool">版本 {{ pool.poolVersion??'冻结小样' }} · 已见及相关时段不再计为首次</footer>
    </section>
  </div>
</template>

<style scoped>
.crypto-data-popover { position:relative;color:var(--ql-color-text-muted); }
.crypto-data-trigger { display:grid;place-items:center;width:32px;height:32px;min-height:32px;padding:0;border:1px solid var(--ql-line-strong);border-radius:6px;background:transparent;color:var(--ql-color-success);cursor:pointer; }
.crypto-data-trigger--warning { color:var(--ql-color-warning); }
.crypto-data-panel { position:absolute;top:calc(100% + 8px);right:0;z-index:50;width:min(340px,calc(100vw - 24px));padding:14px;max-height:min(80vh,720px);overflow-y:auto;border:1px solid var(--ql-line-strong);border-radius:10px;background:var(--ql-panel);box-shadow:var(--ql-shadow-lg); }
.crypto-data-heading { display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:11px;border-bottom:1px solid var(--ql-line); }
.crypto-data-heading strong { color:var(--ql-ink);font-size:14px; }
.crypto-data-heading p { margin:4px 0 0; }
.crypto-data-heading button { display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px;min-height:28px;padding:0;border:0;border-radius:6px;background:var(--ql-paper-soft);color:var(--ql-muted);cursor:pointer; }
.crypto-data-heading button:disabled { opacity:.5;cursor:wait; }
.crypto-data-panel h3 { margin:0 0 6px;color:var(--ql-muted-soft);font-size:10px;font-weight:600; }
.crypto-data-panel p { margin:5px 0 0;font-size:11px;line-height:1.5; }
.crypto-data-group { padding-top:11px; }
.crypto-data-panel dl { display:grid;gap:5px;margin:0; }
.crypto-data-panel dl>div { display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:11px; }
.crypto-data-panel dd { margin:0;color:var(--ql-ink);text-align:right;font-variant-numeric:tabular-nums; }
.crypto-data-details { margin-top:11px;padding-top:9px;border-top:1px solid var(--ql-line); }
.crypto-data-details summary { display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;color:var(--ql-ink);font-size:12px;font-weight:600;list-style:none;cursor:pointer; }
.crypto-data-details summary::-webkit-details-marker { display:none; }
.crypto-data-details[open] summary svg { transform:rotate(180deg); }
.crypto-data-details article { padding:10px 0;border-bottom:1px solid var(--ql-line); }
.crypto-data-details article>strong { color:var(--ql-ink);font-size:12px; }
.crypto-data-details article dl { margin-top:7px; }
.crypto-data-panel footer { margin-top:11px;padding-top:9px;border-top:1px solid var(--ql-line);font-size:10px;line-height:1.5;overflow-wrap:anywhere; }
.crypto-data-popover button:focus-visible,.crypto-data-details summary:focus-visible { outline:2px solid var(--ql-accent);outline-offset:2px;border-radius:4px; }
@media(max-width:720px) { .crypto-data-panel { position:fixed;top:52px;right:12px;left:12px;width:auto; } }
</style>
