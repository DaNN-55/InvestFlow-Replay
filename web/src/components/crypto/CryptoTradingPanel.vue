<script setup>
import { computed, reactive, shallowRef, watch, onBeforeUnmount } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiInput from '../ui/UiInput.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTextarea from '../ui/UiTextarea.vue';
import { amount, riskPlan } from '../../utils/cryptoReplayPresentation.js';
import { createCryptoPreviewLoader } from '../../utils/cryptoOrderPreview.js';
import { cryptoQuantityToContracts } from '../../utils/cryptoQuantity.js';
const props = defineProps({ session: { type: Object, required: true }, busy: Boolean, blocked: Boolean, previewOrder: { type: Function, required: true } });
const emit = defineEmits(['command', 'advance', 'finish']);
const form = reactive({ intent: 'long', type: 'market', contracts: '', unit:'contracts', sizingMode: 'contracts', sizingAmount: '', limitPrice: '', stopLoss: '', takeProfit: '', reference: 'last', note: '' });
const position = computed(() => props.session.account.position);
const plan = computed(() => riskPlan(props.session));
const protectionWarning = computed(() => {
  if (!form.stopLoss) return false;
  const side = position.value?.side ?? form.intent;
  const current = Number(props.session.currentPrices[form.reference]);
  return side === "long" ? Number(form.stopLoss) >= current : side === "short" && Number(form.stopLoss) <= current;
});
const inactive = computed(() => props.busy || props.blocked || props.session.status !== 'active' || props.session.ending);
watch(() => props.session.id, () => { form.stopLoss = ''; form.takeProfit = ''; form.note = ''; }, { immediate: true });
const previewState = shallowRef({ busy: false, preview: null, error: '', key: '' });
const previewLoader = createCryptoPreviewLoader({ request: (id, body) => props.previewOrder(id, body), changed: value => { previewState.value = value; } });
const estimateExit = computed(() => {
  if (form.stopLoss) return { price: form.stopLoss, reference: form.reference };
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
      <h2>下单</h2>
      <form @submit.prevent="submit">
        <div class="crypto-segments" aria-label="开仓或平仓"><button type="button" :aria-pressed="form.intent !== 'reduce'" :disabled="inactive" @click="form.intent=position?.side??'long'">开仓</button><button type="button" :aria-pressed="form.intent === 'reduce'" :disabled="inactive || !position" @click="form.intent='reduce'">平仓</button></div>
        <div v-if="form.intent !== 'reduce'" class="crypto-segments order-directions"><button type="button" :aria-pressed="form.intent==='long'" :disabled="inactive" @click="form.intent='long'">买入 / 做多</button><button type="button" :aria-pressed="form.intent==='short'" :disabled="inactive" @click="form.intent='short'">卖出 / 做空</button></div>
        <p v-else class="muted">仅减仓，不会反向开仓；当前 {{ position?.contracts }} 张。</p>
        <div class="crypto-section-tabs" aria-label="委托类型"><button type="button" :aria-pressed="form.type==='market'" :disabled="inactive" @click="form.type='market'">市价</button><button type="button" :aria-pressed="form.type==='limit'" :disabled="inactive" @click="form.type='limit'">限价</button></div>
        <label>仓位输入方式<UiSelect v-model="form.sizingMode" aria-label="仓位输入方式" :disabled="inactive || form.intent === 'reduce'"><option value="contracts">直接输入张数</option><option value="margin">按本单保证金估仓</option><option value="risk">按计划风险预算估仓</option></UiSelect></label>
        <label v-if="form.sizingMode === 'contracts'">委托数量<div class="crypto-quantity-row"><UiInput v-model="form.contracts" aria-label="委托张数" inputmode="decimal" required placeholder="自行填写，不预选仓位" :disabled="inactive" /><UiSelect v-model="form.unit" aria-label="数量单位" :disabled="inactive"><option value="contracts">张</option><option value="base">{{ session.instrumentId.startsWith('BTC')?'BTC':'ETH' }}</option><option value="quote">USDT</option></UiSelect></div></label>
        <label v-else>{{ form.sizingMode === 'margin' ? '本单保证金预算（不含手续费）' : '计划风险预算（USDT）' }}<UiInput v-model="form.sizingAmount" :aria-label="form.sizingMode === 'margin' ? '保证金预算' : '风险预算'" inputmode="decimal" required :disabled="inactive" /></label>
        <p v-if="form.sizingMode==='contracts'&&form.unit!=='contracts'" class="muted">按{{ form.type==='limit'?'委托限价':'当前最新价' }}换算张数并向下取整；USDT为名义金额，不是保证金或保证成交金额。</p>
        <label v-if="form.type === 'limit'">限价（USDT）<UiInput v-model="form.limitPrice" aria-label="委托限价" inputmode="decimal" required :disabled="inactive" /></label>
        <details>
<summary>合约规格与成交规则</summary>        <p class="muted">每张 {{ session.contract.ctVal }} {{ session.instrumentId.startsWith('BTC') ? 'BTC' : 'ETH' }}；张数步长 {{ session.contract.lotSz }}，价格步长 {{ session.contract.tickSz }}。委托下一未展示分钟起生效；市价余量撤销，限价余量等待。</p>
</details>
        <details>
<summary>记录本次判断（可选）</summary>        <label>这次操作的理由<UiTextarea v-model="form.note" aria-label="操作理由" maxlength="2000" :disabled="inactive" /></label>
</details>
        <details>
<summary>自动止盈止损（可选）</summary>
        <div class="two-fields"><label>自动止损价（可空）<UiInput v-model="form.stopLoss" aria-label="自动止损价" inputmode="decimal" :disabled="inactive" /></label><label>自动止盈价（可空）<UiInput v-model="form.takeProfit" aria-label="自动止盈价" inputmode="decimal" :disabled="inactive" /></label></div>
        <label>保护触发参考<UiSelect v-model="form.reference" aria-label="保护触发参考" :disabled="inactive"><option value="last">普通价格 last</option><option value="mark">标记价格 mark</option></UiSelect></label>
        <p v-if="protectionWarning" class="muted" role="status">止损价已处于当前触发侧，下一执行分钟可能立即退出；触发价不保证成交。</p>
        </details>
        <div class="order-preview" data-testid="crypto-order-preview" aria-live="polite">
          <h3>提交前核对</h3>
          <p v-if="session.status !== 'active' || session.ending" class="muted">本次已结束或正在退出，不再接受新委托。</p>
          <p v-else-if="previewState.busy" class="muted">正在按当前已知价格估算…</p>
          <p v-else-if="previewState.error" class="preview-error" role="status">{{ previewState.error }}</p>
          <template v-else-if="readyPreview">
            <p>预计 {{ readyPreview.contracts }} 张 · 保证金 {{ amount(readyPreview.initialMargin) }} USDT</p><details>
<summary>完整估算与风险说明</summary><dl class="facts">
              <div><dt>本单张数 / 币数</dt><dd data-testid="crypto-preview-quantity">{{ readyPreview.contracts }} 张 / {{ readyPreview.baseQuantity }} {{ session.instrumentId.startsWith('BTC') ? 'BTC' : 'ETH' }}</dd></div>
              <div><dt>估算成交价</dt><dd>{{ readyPreview.fillPrice }}</dd></div>
              <div><dt>名义金额</dt><dd>{{ readyPreview.notional }} USDT</dd></div>
              <div><dt>本单逐仓保证金</dt><dd data-testid="crypto-preview-margin">{{ readyPreview.initialMargin }}</dd></div>
              <div><dt>Maker / Taker 费用</dt><dd>{{ readyPreview.makerFee }} / {{ readyPreview.takerFee }}</dd></div>
              <div><dt>预计委托冻结</dt><dd>{{ readyPreview.requiredAvailable }}</dd></div>
              <div><dt>计划估算损失 · 含双边费用/滑点</dt><dd data-testid="crypto-preview-loss">{{ readyPreview.estimatedPlanLoss ?? '未定义' }}</dd></div>
              <div><dt>本单成交后估算强平价 · mark</dt><dd>{{ amount(readyPreview.projectedRisk?.estimatedLiquidationPrice, 4) }}</dd></div>
            </dl>
            <p v-if="readyPreview.projectedRisk?.liquidationRequired" class="preview-error">按当前 mark 估算，成交后可能立即达到教学接管阈值。</p>
            <p v-if="readyPreview.roundedDown" class="muted">已按合约步长向下取整为 {{ readyPreview.contracts }} 张；输入金额为上限，不暗中扩大仓位。</p>
            <p class="muted">按本单全部成交估算，其他待成交委托未计入预计持仓。实际从下一分钟起执行，可能滑点或部分成交；预览不扣款。限价按输入限价估算，Maker/Taker 取决于实际撮合，冻结按 Taker 保守预留。保证金预算固定本单保证金，风险预算固定计划估算损失，杠杆均沿用本会话。</p>
            <p class="muted">风险预算使用已保存手动计划或本单止损价，计双边 Taker 费和教学滑点；未知资金费未计入，不是最大损失保证。{{ readyPreview.markBasisUnknown ? '本次退出参考为 mark，估算暂按 last=mark，实际基差和触发成交差异未知。' : '' }}</p>
</details>
          </template>
          <p v-else class="muted">填写张数或预算后显示预览；不自动选择仓位。无退出价时损失未定义，仍可按张数或保证金下单。</p>
        </div>
        <UiButton type="submit" :disabled="inactive || !readyPreview || previewState.busy" block>{{ form.intent==='reduce'?'提交平仓委托':form.intent==='long'?'买入 / 做多':'卖出 / 做空' }}</UiButton>
      </form>
    </section>
    <p class="muted order-risk-summary">{{ plan.label }} · {{ position ? '当前有持仓' : '当前空仓' }}。持仓、保护与手动计划在图表下方管理。</p>
  </aside>
</template>
<style scoped>
.crypto-trading { min-width: 0; background: var(--ql-panel); border: 1px solid var(--ql-line-strong); border-radius: 10px; }
section { padding: 18px; border-bottom: 1px solid var(--ql-line); } section:last-child { border-bottom: 0; }
h2 { margin: 0 0 12px; font-size: 15px; }.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }.section-heading h2 { margin: 0; }
.risk-badge { font-size: 12px; color: var(--ql-ink); border-bottom: 2px solid #d97706; }.risk-badge[data-risk-mode="automatic"] { border-color: #16a34a; }
.facts { margin: 14px 0; font-size: 12px; }.facts > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }dt { color: var(--ql-color-text-muted); }dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
label { display: block; font-size: 12px; margin: 10px 0; line-height: 2; } .two-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.two-fields label { min-width: 0; }
.muted { color: var(--ql-color-text-muted); font-size: 11px; line-height: 1.8; margin: 10px 0; }.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.orders { list-style: none; padding: 0; font-size: 12px; }.orders li { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--ql-line); padding: 10px 0; }
textarea { min-height: 64px; }
</style>

<style scoped>
.order-preview { margin: 16px 0; padding: 12px; border-left: 3px solid var(--ql-accent); background: var(--ql-paper-soft); }
.order-preview h3 { margin: 0; font-size: 13px; }
.preview-error { color: #b91c1c; font-size: 12px; line-height: 1.7; }
</style>
