<script setup>
import { computed, reactive, shallowRef, watch, onBeforeUnmount } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiInput from '../ui/UiInput.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTextarea from '../ui/UiTextarea.vue';
import UiTooltip from '../ui/UiTooltip.vue';
import { amount } from '../../utils/cryptoReplayPresentation.js';
import { createCryptoPreviewLoader } from '../../utils/cryptoOrderPreview.js';
import { cryptoQuantityToContracts } from '../../utils/cryptoQuantity.js';
const props = defineProps({ session: { type: Object, required: true }, busy: Boolean, blocked: Boolean, previewOrder: { type: Function, required: true } });
const emit = defineEmits(['command', 'advance', 'finish']);
const form = reactive({ intent: 'long', type: 'market', contracts: '', unit:'contracts', sizingMode: 'contracts', sizingAmount: '', limitPrice: '', stopLoss: '', takeProfit: '', reference: 'last', note: '' });
const position = computed(() => props.session.account.position);
const advancedSummary = computed(() => [form.sizingMode === 'margin' ? '保证金估仓' : form.sizingMode === 'risk' ? '风险估仓' : '', ...(form.intent === 'reduce' ? [] : [form.stopLoss ? '止损' : '', form.takeProfit ? '止盈' : '']), form.note ? '理由' : ''].filter(Boolean).join(' · '));
const protectionWarning = computed(() => {
  if (!form.stopLoss) return false;
  const side = form.intent;
  const current = Number(props.session.currentPrices[form.reference]);
  return side === "long" ? Number(form.stopLoss) >= current : side === "short" && Number(form.stopLoss) <= current;
});
const inactive = computed(() => props.busy || props.blocked || props.session.status !== 'active' || props.session.ending);
watch(position,value=>{if(!value&&form.intent==='reduce') form.intent='long';});
watch(() => props.session.id, () => { form.stopLoss = ''; form.takeProfit = ''; form.note = ''; }, { immediate: true });
const previewState = shallowRef({ busy: false, preview: null, error: '', key: '' });
const previewLoader = createCryptoPreviewLoader({ request: (id, body) => props.previewOrder(id, body), changed: value => { previewState.value = value; } });
const estimateExit = computed(() => {
  if (form.intent !== 'reduce' && form.stopLoss) return { price: form.stopLoss, reference: form.reference };
  if (!form.takeProfit && props.session.protection?.stopLoss) return props.session.protection.stopLoss;
  const saved = props.session.trainingJournal.plan;
  return saved.mode === 'manual' ? { price: saved.manualExitPrice, reference: 'last' } : null;
});
const previewRequest = computed(() => ({ sessionId: props.session.id, expectedRevision: props.session.revision,
  intent: form.intent, orderType: form.type, sizingMode: form.sizingMode, amount: form.sizingMode === 'contracts' ? cryptoQuantityToContracts(form.contracts,form.unit,props.session.contract,form.type==='limit'?form.limitPrice:props.session.currentPrices.last) : form.sizingAmount,
  ...(form.type === 'limit' ? { limitPrice: form.limitPrice } : {}),
  ...(estimateExit.value ? { exitPrice: estimateExit.value.price, exitReference: estimateExit.value.reference } : {}) }));
const readyPreview = computed(() => previewState.value.key === JSON.stringify(previewRequest.value) ? previewState.value.preview : null);
watch(() => form.intent, value => { if (value === 'reduce') form.sizingMode = 'contracts'; });
watch(() => form.sizingMode, () => { form.sizingAmount = ''; });
watch(() => form.unit,()=>{form.contracts='';});
watch(previewRequest, (input, _old, onCleanup) => {
  previewLoader.cancel(); previewState.value = { busy: false, preview: null, error: '', key: '' };
  if (props.session.status !== 'active' || props.session.ending || !input.amount || (input.orderType === 'limit' && !input.limitPrice)) return;
  if (input.sizingMode === 'risk' && !input.exitPrice) { previewState.value.error = '请先保存手动退出计划，或填写本单自动止损价，再按风险预算估仓。'; return; }
  const timer = setTimeout(() => previewLoader.load(input), 180);
  onCleanup(() => { clearTimeout(timer); previewLoader.cancel(); });
}, { immediate: true });
function protection() {
  return { ...(form.stopLoss ? { stopLoss: { price: form.stopLoss, reference: form.reference } } : {}), ...(form.takeProfit ? { takeProfit: { price: form.takeProfit, reference: form.reference } } : {}) };
}
function submit() {
  if (!readyPreview.value || inactive.value) return;
  const reduce = form.intent === 'reduce';
  emit('command', { type: `${form.type}-${reduce ? 'close' : 'open'}`, ...(reduce ? {} : { side: form.intent }), contracts: readyPreview.value.contracts,
    ...(form.type === 'limit' ? { limitPrice: form.limitPrice } : {}), ...(!reduce && (form.stopLoss || form.takeProfit) ? { protection: protection() } : {}) }, form.note);
}
onBeforeUnmount(()=>previewLoader.cancel());
</script>
<template>
  <aside class="crypto-trading">
    <section>
      <div class="order-heading"><h2>下单</h2><UiTooltip clickable label="下单与合约规格说明" :content="`每张 ${session.contract.ctVal} ${session.instrumentId.startsWith('BTC')?'BTC':'ETH'}；数量步长 ${session.contract.lotSz}，价格步长 ${session.contract.tickSz}。提交后从下一分钟起撮合；市价未成交余量撤销，限价余量继续等待。`" /></div>
      <form @submit.prevent="submit">
        <div class="crypto-segments order-directions" aria-label="交易方向">
          <button type="button" :aria-pressed="form.intent==='long'" :disabled="inactive" @click="form.intent='long'">买入 / 做多</button>
          <button type="button" :aria-pressed="form.intent==='short'" :disabled="inactive" @click="form.intent='short'">卖出 / 做空</button>
          <button v-if="position" type="button" :aria-pressed="form.intent==='reduce'" :disabled="inactive" @click="form.intent='reduce'">平仓</button>
        </div>
        <div class="order-type-row"><div class="crypto-section-tabs" aria-label="委托类型"><button type="button" :aria-pressed="form.type==='market'" :disabled="inactive" @click="form.type='market'">市价</button><button type="button" :aria-pressed="form.type==='limit'" :disabled="inactive" @click="form.type='limit'">限价</button></div><UiTooltip clickable label="委托类型说明" content="市价：从下一分钟起按可用容量成交，可能滑点或部分成交。限价：只在符合指定价格时成交，余量继续等待。平仓只减仓，不反向开仓。" /></div>
        <label v-if="form.type === 'limit'" class="order-field">限价 · USDT<UiInput v-model="form.limitPrice" aria-label="委托限价" inputmode="decimal" required :disabled="inactive" /></label>
        <div class="order-field">
<div class="order-field-title"><label :for="`order-quantity-${session.id}`">{{ form.intent==='reduce'?`平仓数量 · 持有 ${position?.contracts??0} 张`:'委托数量' }}</label><UiTooltip clickable label="数量与单位说明" content="张：合约数量。BTC/ETH：对应币数。USDT：名义金额，不是保证金；按当前最新价或委托限价换算张数，并按步长向下取整。预算估仓可在高级设置中选择。" /></div>
          <div v-if="form.sizingMode === 'contracts'" class="crypto-quantity-row"><UiInput :id="`order-quantity-${session.id}`" v-model="form.contracts" aria-label="委托张数" inputmode="decimal" required placeholder="填写数量" :disabled="inactive" /><UiSelect v-model="form.unit" aria-label="数量单位" :disabled="inactive"><option value="contracts">张</option><option value="base">{{ session.instrumentId.startsWith('BTC')?'BTC':'ETH' }}</option><option value="quote">USDT</option></UiSelect></div>
          <div v-else class="order-estimated-quantity" role="status">{{ readyPreview?`${readyPreview.contracts} 张`:'等待预算估算' }}<small>{{ form.sizingMode==='margin'?'按保证金':'按风险预算' }}</small></div>
        </div>
        <details class="order-advanced">
          <summary><span>高级设置</span><small v-if="advancedSummary">{{ advancedSummary }}</small></summary>
          <div class="order-advanced-content">
            <div class="order-field"><div class="order-field-title"><label :for="`order-sizing-${session.id}`">仓位输入方式</label><UiTooltip clickable label="预算估仓说明" content="保证金预算：按本单保证金估算张数，手续费另计。风险预算：按退出价、双边手续费和教学滑点估算张数，需先填止损价或保存手动退出计划；未知资金费未计入，不保证最大损失。" /></div><UiSelect :id="`order-sizing-${session.id}`" v-model="form.sizingMode" aria-label="仓位输入方式" :disabled="inactive || form.intent === 'reduce'"><option value="contracts">直接输入数量</option><option value="margin">按保证金预算</option><option value="risk">按风险预算</option></UiSelect></div>
            <label v-if="form.sizingMode !== 'contracts'" class="order-field">{{ form.sizingMode==='margin'?'保证金预算 · USDT':'风险预算 · USDT' }}<UiInput v-model="form.sizingAmount" :aria-label="form.sizingMode==='margin'?'保证金预算':'风险预算'" inputmode="decimal" required :disabled="inactive" /></label>
            <template v-if="form.intent!=='reduce'">
              <div class="order-field-title"><span>自动止盈止损</span><UiTooltip clickable label="止盈止损说明" content="可只填一项。随开仓委托提交，成交后生效；触发后按市价减仓，可能滑点或部分成交。一腿触发取消另一腿。已生效保护显示在相同触发价格类型的图上，待成交保护以虚线标注。" /></div>
              <div class="two-fields"><label class="order-field">止损价<UiInput v-model="form.stopLoss" aria-label="自动止损价" inputmode="decimal" placeholder="可选" :disabled="inactive" /></label><label class="order-field">止盈价<UiInput v-model="form.takeProfit" aria-label="自动止盈价" inputmode="decimal" placeholder="可选" :disabled="inactive" /></label></div>
              <label class="order-field">触发参考<UiSelect v-model="form.reference" aria-label="保护触发参考" :disabled="inactive"><option value="last">最新价</option><option value="mark">标记价格</option></UiSelect></label>
            </template>
            <label class="order-field">操作理由 · 可选<UiTextarea v-model="form.note" aria-label="操作理由" maxlength="2000" :disabled="inactive" placeholder="记录这次判断" /></label>
          </div>
        </details>
        <div class="order-preview" data-testid="crypto-order-preview" aria-live="polite">
          <div class="order-heading"><h3>提交前核对</h3><UiTooltip clickable wide label="预览估算说明" :content="`预览不扣款，按本单全部成交估算，其他待成交委托未计入。实际可能滑点或部分成交；限价按委托价估算，冻结按 Taker 费预留。无退出价时计划损失未定义。${readyPreview?.markBasisUnknown?'退出参考为 mark，本次估算暂按 last=mark，实际基差未知。':''}`" /></div>
          <p v-if="session.status !== 'active' || session.ending" class="muted">本次不再接受新委托。</p>
          <p v-else-if="previewState.busy" class="muted">估算中…</p>
          <p v-else-if="previewState.error" class="preview-error" role="status">{{ previewState.error }}</p>
          <template v-else-if="readyPreview">
            <dl class="order-preview-summary"><div><dt>保证金 · USDT</dt><dd>{{ amount(readyPreview.initialMargin) }}</dd></div><div><dt>预留资金 · USDT</dt><dd>{{ amount(readyPreview.requiredAvailable) }}</dd></div></dl>
            <details class="order-estimates">
<summary>更多估算</summary><dl class="facts">
              <div><dt>数量</dt><dd data-testid="crypto-preview-quantity">{{ readyPreview.contracts }} 张 / {{ readyPreview.baseQuantity }} {{ session.instrumentId.startsWith('BTC')?'BTC':'ETH' }}</dd></div>
              <div><dt>估算成交价</dt><dd>{{ readyPreview.fillPrice }}</dd></div>
              <div><dt>名义金额 · USDT</dt><dd>{{ readyPreview.notional }}</dd></div>
              <div><dt>逐仓保证金</dt><dd data-testid="crypto-preview-margin">{{ readyPreview.initialMargin }}</dd></div>
              <div><dt>Maker / Taker 费用</dt><dd>{{ readyPreview.makerFee }} / {{ readyPreview.takerFee }}</dd></div>
              <div><dt>计划估算损失</dt><dd data-testid="crypto-preview-loss">{{ readyPreview.estimatedPlanLoss??'未定义' }}</dd></div>
              <div><dt>估算强平价 · mark</dt><dd>{{ amount(readyPreview.projectedRisk?.estimatedLiquidationPrice,4) }}</dd></div>
            </dl><p v-if="readyPreview.roundedDown" class="muted">已按步长向下取整为 {{ readyPreview.contracts }} 张。</p>
</details>
            <p v-if="readyPreview.projectedRisk?.liquidationRequired" class="preview-error" role="status">成交后可能立即达到教学接管阈值。</p>
          </template>
          <p v-else class="muted">{{ previewRequest.amount?'估算中…':'填写数量后显示估算。' }}</p>
          <p v-if="form.intent!=='reduce'&&protectionWarning" class="preview-error" role="status">止损已在触发侧，下一分钟可能立即退出。</p>
        </div>
        <UiButton type="submit" :disabled="inactive || !readyPreview || previewState.busy" block>{{ form.intent==='reduce'?'提交平仓委托':form.intent==='long'?'买入 / 做多':'卖出 / 做空' }}</UiButton>
      </form>
    </section>
  </aside>
</template>
<style scoped>
.crypto-trading { min-width:0;background:var(--ql-panel);border:1px solid var(--ql-line-strong);border-radius:7px; }
section { padding:14px; }
h2,h3 { margin:0;font-size:13px;font-weight:500; }
.order-heading,.order-field-title,.order-type-row { display:flex;align-items:center;justify-content:space-between;gap:6px; }
.order-heading { margin-bottom:8px; }
.order-type-row { border-bottom:1px solid var(--ql-line); }
.order-type-row .crypto-section-tabs { border:0;gap:20px; }
.order-type-row .crypto-section-tabs>button { min-height:34px;padding:7px 0; }
.order-field { display:block;font-size:11px;line-height:1.7;margin:10px 0; }
.order-field>.ql-ui-control,.order-field>.ql-relative { margin-top:4px; }
.order-field-title { font-size:11px;line-height:1.7;margin-bottom:4px; }
.two-fields { display:grid;grid-template-columns:1fr 1fr;gap:8px; }.two-fields label { min-width:0;margin:0 0 10px; }
.order-advanced { margin:12px 0!important;border-top:1px solid var(--ql-line);border-bottom:1px solid var(--ql-line); }
.order-advanced>summary { padding:9px 0;font-size:11px;cursor:pointer; }
.order-advanced>summary small { float:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ql-accent);font-size:10px; }
.order-advanced-content { padding:0 0 2px; }
.order-advanced-content>.order-field:first-child { margin-top:0; }
.order-estimated-quantity { display:flex;justify-content:space-between;align-items:center;min-height:40px;padding:0 10px;border:1px solid var(--ql-line-strong);border-radius:8px;font-variant-numeric:tabular-nums; }
.order-estimated-quantity small { color:var(--ql-color-text-muted);font-size:10px; }
.order-preview { margin:10px 0;padding:10px;background:var(--ql-paper-soft);border-radius:5px; }
.order-preview .order-heading { margin-bottom:5px; }.order-preview h3 { font-size:11px; }
.order-preview-summary { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0;font-size:11px; }
.order-preview-summary dd { font-size:13px;margin-top:4px;text-align:left;color:var(--ql-ink); }
.order-estimates { margin:8px 0 0!important; }.order-estimates summary { font-size:10px;cursor:pointer;color:var(--ql-color-text-muted); }
.facts { margin:8px 0;font-size:11px; }.facts>div { display:flex;justify-content:space-between;gap:10px;padding:4px 0; }dt { color:var(--ql-color-text-muted); }dd { margin:0;font-variant-numeric:tabular-nums;text-align:right; }
.muted,.preview-error { font-size:11px;line-height:1.6;margin:6px 0; }.muted { color:var(--ql-color-text-muted); }.preview-error { color:var(--ql-color-danger); }
textarea { min-height:56px; }
</style>
