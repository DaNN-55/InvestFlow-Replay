<script setup>
import { computed, inject, onActivated, onDeactivated, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Settings2, Play, Pause } from 'lucide-vue-next';
import { api } from '../services/api.js';
import UiButton from '../components/ui/UiButton.vue';
import UiSelect from '../components/ui/UiSelect.vue';
import UiDrawer from '../components/ui/UiDrawer.vue';
import UiModal from '../components/ui/UiModal.vue';
import UiInput from '../components/ui/UiInput.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CryptoSetupPanel from '../components/crypto/CryptoSetupPanel.vue';
import CryptoTradingPanel from '../components/crypto/CryptoTradingPanel.vue';
import CryptoPositionPanel from '../components/crypto/CryptoPositionPanel.vue';
import CryptoChartWorkspace from '../components/crypto/CryptoChartWorkspace.vue';
import CryptoReviewPanel from '../components/crypto/CryptoReviewPanel.vue';
import { createCryptoReplayController } from '../utils/cryptoReplayController.js';
import { amount, relativeTime } from '../utils/cryptoReplayPresentation.js';
import { createOrderDraft, orderDraftCommand, createPriceDraft, priceDraftReached, priceDraftCurrent, priceDraftCommand, createPriceCancellation, priceCancellationCurrent, priceCancellationCommand } from '../utils/cryptoPriceDraft.js';
import { loadCryptoPreferences, CRYPTO_WORKSPACE_KEY, CRYPTO_PLAYBACK_SPEEDS, cryptoVisiblePeriods } from '../utils/cryptoWorkspacePreferences.js';
import '../components/crypto/crypto-terminal.css';
const route=useRoute(),router=useRouter();
const openData=inject('openCryptoData',()=>{});
const state=shallowRef({}),preferences=ref(loadCryptoPreferences(localStorage));
const controller=createCryptoReplayController({api,storage:localStorage,changed:value=>{state.value=value;}});
controller.state.timeframes=cryptoVisiblePeriods(preferences.value);controller.state.timeframe=controller.state.timeframes[0];state.value={...controller.state};
const s=computed(()=>state.value.session);
const progress=computed(()=>Math.min(100,Math.max(0,Number(s.value?.elapsedMinutes??0)/Math.max(1,Number(s.value?.gameLength??1))*100)));
const routeMismatch=computed(()=>route.name==='crypto-market-replay'&&typeof route.query.session==='string'&&route.query.session!==s.value?.id);
const priceDraft=shallowRef(null),priceDragging=ref(false),priceSaving=ref(false),priceNotice=ref('');
const cancellation=shallowRef(null),orderEditor=shallowRef(null),orderEditPrice=ref(''),orderEditQuantity=ref('');
const orderPreview=shallowRef(null),orderPreviewBusy=ref(false),orderPreviewError=ref('');
let orderPreviewGeneration=0;
const orderEditDraft=computed(()=>orderEditor.value?createOrderDraft(orderEditor.value.session,{orderId:orderEditor.value.orderId},orderEditPrice.value,orderEditQuantity.value):null);
const orderEditBody=computed(()=>orderEditDraft.value?orderDraftCommand(s.value,orderEditDraft.value):null);
const orderPreviewReady=computed(()=>Boolean(orderEditBody.value&&orderPreview.value?.key===JSON.stringify(orderEditBody.value)&&!orderPreviewBusy.value&&!orderPreviewError.value));
const orderChartDraft=computed(()=>orderEditDraft.value?.order.type==='limit'?orderEditDraft.value:priceDraft.value);
function clearOrderEditor() {orderPreviewGeneration++;orderEditor.value=null;orderEditPrice.value='';orderEditQuantity.value='';orderPreview.value=null;orderPreviewBusy.value=false;orderPreviewError.value='';}
function requestOrderEdit(target) {
  if(locked.value) return;
  const draft=createPriceCancellation(s.value,target);
  if(!draft?.order) return;
  stop();priceNotice.value='';orderEditor.value={...draft,session:s.value};orderEditPrice.value=draft.order.limitPrice??'';orderEditQuantity.value=draft.order.remainingContracts;
}
async function refreshOrderPreview() {
  const generation=++orderPreviewGeneration,body=orderEditBody.value;
  orderPreview.value=null;orderPreviewError.value='';orderPreviewBusy.value=false;
  if(!body) return;
  orderPreviewBusy.value=true;
  try {
    const {preview}=await api.cryptoPreview(orderEditor.value.sessionId,body);
    if(generation!==orderPreviewGeneration) return;
    if(preview.sessionId!==orderEditor.value?.sessionId||preview.revision!==body.expectedRevision) throw new Error('委托已变化，请重新预览');
    orderPreview.value={...preview,key:JSON.stringify(body)};
  } catch(error) {
    if(generation!==orderPreviewGeneration) return;
    if(error.code==='REPLAY_REVISION_CONFLICT') {clearOrderEditor();await controller.sync();priceNotice.value='委托已变化，请核对后重新修改。';return;}
    orderPreviewError.value=({INSUFFICIENT_CASH:'可用资金不足，请降低价格或数量。',OVER_REDUCTION:'数量超过可平仓余量，含其他平仓委托。',ORDER_SIZE_LIMIT:'数量超过本局委托上限。'})[error.code]??error.message??'暂时无法预览，请重试';
  }
  finally {if(generation===orderPreviewGeneration) orderPreviewBusy.value=false;}
}
watch(orderEditBody,refreshOrderPreview);
function confirmOrderEdit() {
  if(!orderPreviewReady.value) return;
  return saveChartCommand(orderEditBody.value,clearOrderEditor);
}
let priceDragSession=null;
const locked=computed(()=>state.value.busy||Boolean(state.value.pending)||routeMismatch.value||Boolean(priceDraft.value)||priceDragging.value||Boolean(cancellation.value)||Boolean(orderEditor.value));
const finishOpen=ref(false),settingsOpen=ref(false),playing=ref(false);
const retraining=ref(false);
const display=reactive({precision:'auto'});
let playbackTimer;
let playbackGeneration=0, playbackInFlight=false;
let lastRequestedSession=null;
function records(focusCurrent=false) { playing.value=false;router.push({path:'/decision/trade-records',query:{tab:'replay',market:'crypto-perpetual',...(focusCurrent===true&&s.value?{session:s.value.id}:{})}}); }
function command(value,note='') {if(locked.value) return false;playing.value=false;return controller.act('command',{command:value,...(note?{note}:{})});}
async function fresh() {if(locked.value) return;playing.value=false;await controller.fresh();if(!state.value.session) await router.replace({query:{}});}
function cancelPriceDraft() {priceDraft.value=null;priceDragging.value=false;priceDragSession=null;}
function priceDrag(event) {
  if(event.phase==='start') {
    if(locked.value) return;
    stop();priceNotice.value='';priceDragging.value=true;priceDragSession=s.value;
    return;
  }
  const base=priceDragSession;
  priceDragging.value=false;priceDragSession=null;
  if(event.phase!=='end'||!base) return;
  const draft=createPriceDraft(base,event,event.price);
  if(!draft) return;
  if(!priceDraftCurrent(s.value,draft)) {priceNotice.value='委托、持仓或保护已变化，请重新拖动。';return;}
  priceDraft.value=draft;
}
function clearCancellation() {cancellation.value=null;}
function requestCancellation(target) {
  if(locked.value) return;
  const draft=createPriceCancellation(s.value,target);
  if(!draft) return;
  stop();priceNotice.value='';cancellation.value=draft;
}
const cancellationTitle=computed(()=>cancellation.value?.kind==='order'?(cancellation.value.order.type==='limit'?'撤销限价委托？':'撤销市价委托？'):cancellation.value?.leg==='stopLoss'?'撤销自动止损？':'撤销自动止盈？');
const cancellationMessage=computed(()=>{
  const draft=cancellation.value;
  if(!draft) return '';
  if(draft.kind==='order') {
    const order=draft.order,direction=order.intent==='reduce'?(order.side==='long'?'平多':'平空'):(order.side==='long'?'开多':'开空');
    return `${direction} · 委托价 ${order.type==='limit'?order.limitPrice:'市价'} · 剩余未成交 ${order.remainingContracts} 张。仅撤销此委托的未成交部分。`;
  }
  const label=draft.leg==='stopLoss'?'止损':'止盈',sibling=draft.protection[draft.leg==='stopLoss'?'takeProfit':'stopLoss'];
  return `${label} ${draft.protection[draft.leg].price} · ${draft.protection.contracts} 张。${draft.protection.triggeredLeg?'已触发；撤销仅停止剩余退出，不恢复已平仓数量。':sibling?'仅撤销这一条，另一条保护保留。':'撤销后不再自动保护该持仓。'}`;
});
function confirmPriceDraft() {return saveChartCommand(priceDraftCommand(s.value,priceDraft.value),cancelPriceDraft);}
function confirmCancellation() {return saveChartCommand(priceCancellationCommand(s.value,cancellation.value),clearCancellation);}
async function saveChartCommand(body,clear) {
  if(state.value.busy||state.value.pending||routeMismatch.value||priceSaving.value) return;
  if(!body) {clear();priceNotice.value='委托、持仓或保护已变化，请重新操作。';return;}
  priceSaving.value=true;stop();
  try {
    const ok=await controller.act('command',body);
    clear();
    if(!ok&&!state.value.pending) {
      const synced=await controller.sync();
      priceNotice.value=synced?'已重新同步操作结果，请核对当前委托或保护后重新操作。':'结果未能同步，请先核对当前委托或保护。';
    }
  } finally {priceSaving.value=false;}
}
watch(()=>[s.value?.id,s.value?.revision],()=>{
  if(priceSaving.value) return;
  if(orderEditor.value&&!priceCancellationCurrent(s.value,orderEditor.value)) {clearOrderEditor();priceNotice.value='委托已变化，请重新修改价格。';}
  if(priceDraft.value&&!priceDraftCurrent(s.value,priceDraft.value)) {cancelPriceDraft();priceNotice.value='委托、持仓或保护已变化，未确认的调整已取消。';}
  if(cancellation.value&&!priceCancellationCurrent(s.value,cancellation.value)) {clearCancellation();priceNotice.value='委托、持仓或保护已变化，请核对后重新撤销。';}
});
function ensurePeriods() {
  const wanted=cryptoVisiblePeriods(preferences.value);
  if(!state.value.busy && wanted.join(',')!==state.value.timeframes.join(',')) controller.periods(wanted);
}
watch(preferences,value=>{try {localStorage.setItem(CRYPTO_WORKSPACE_KEY,JSON.stringify(value));}catch{/* A full browser store must not block practice. */}ensurePeriods();},{deep:true});
function syncRequestedSession() {
  const id=route.query.session;
  if(!state.value.busy&&!retraining.value&&route.name==='crypto-market-replay'&&typeof id==='string'&&id!==s.value?.id&&id!==lastRequestedSession) loadRequestedSession(id);
}
async function loadRequestedSession(id) {
  if(state.value.busy) return;
  stop();lastRequestedSession=id;
  await controller.select(id);
  if(!state.value.session&&!state.value.error&&route.query.session===id) await router.replace({query:{...route.query,session:undefined}});
}
function resync() {return typeof route.query.session==='string'?loadRequestedSession(route.query.session):controller.sync();}
watch(()=>state.value.busy,value=>{if(!value) {syncRequestedSession();ensurePeriods();}});
watch(()=>route.query.session,()=>{lastRequestedSession=null;syncRequestedSession();});
onActivated(()=>typeof route.query.session==='string'?loadRequestedSession(route.query.session):controller.sync());
async function advance(minutes=1) {if(locked.value) return false;playing.value=false;return controller.act('advance',{minutes});}
function schedulePlayback(generation=playbackGeneration) {
  clearTimeout(playbackTimer);
  if(playing.value&&!playbackInFlight) playbackTimer=setTimeout(()=>tick(generation),900/preferences.value.playbackSpeed);
}
async function tick(generation) {
  if(generation!==playbackGeneration) return;
  if(!playing.value||locked.value||s.value?.status!=='active'||s.value?.ending){playing.value=false;return;}
  const sequence=state.value.traces.at(-1)?.sequence??0;
  playbackInFlight=true;
  const ok=await controller.act('advance',{minutes:1});
  playbackInFlight=false;
  if(generation!==playbackGeneration) return;
  const paused=state.value.traces.some(e=>e.sequence>sequence&&['order-filled','order-rejected','funding-settled','protection-triggered','protection-filled','teaching-liquidation','risk-triggered','end-filled','training-ended','end-blocked'].includes(e.type));
  if(!ok||paused||s.value?.status!=='active') playing.value=false;
  if(playing.value) schedulePlayback(generation);
}
watch(playing,()=>{playbackGeneration++;clearTimeout(playbackTimer);if(playing.value) schedulePlayback();});
watch(()=>preferences.value.playbackSpeed,()=>{if(playing.value) schedulePlayback();});
function stop() {playing.value=false;playbackGeneration++;clearTimeout(playbackTimer);}
onDeactivated(()=>{stop();cancelPriceDraft();clearCancellation();clearOrderEditor();});onBeforeUnmount(()=>{stop();cancelPriceDraft();clearCancellation();clearOrderEditor();});
async function finish() {stop();if(await controller.act('finish')) finishOpen.value=false;}
async function retrain() {
  stop();retraining.value=true;
  try {if(await controller.act('retrain')) await router.replace({query:{session:state.value.session.id}});}
  finally {retraining.value=false;}
}
</script>
<template>
  <div class="crypto-workspace crypto-controls" :class="{'crypto-workspace--setup':!s}" :aria-busy="state.busy">
    <header v-if="s" class="crypto-header"><div><p class="crypto-eyebrow">USDT 永续 / 历史盲测</p><h1>{{ s?s.instrumentId:'合约练习' }} <span v-if="s">逐仓 · 单向</span></h1><div v-if="s" class="crypto-quotes"><span>最新价 <b data-testid="crypto-last">{{ amount(s.currentPrices.last,4) }}</b></span><span>标记价格 <b>{{ amount(s.currentPrices.mark,4) }}</b></span></div></div><div class="crypto-header-actions"><button type="button" class="crypto-icon" aria-label="交易与显示设置" title="交易与显示设置" @click="settingsOpen=true"><Settings2 :size="17" /></button></div></header>
    <div v-if="state.error" class="crypto-alert" role="alert"><span>{{ state.error }}</span><UiButton v-if="!state.pending" variant="secondary" :disabled="state.busy" @click="resync">重新同步</UiButton></div>
    <div v-if="state.pending&&!state.busy" class="crypto-alert" role="status"><span>上次动作的结果待核对；核对前不能提交新动作。可以从演练记录查看历史。</span><UiButton variant="secondary" @click="controller.retry()">重试原动作</UiButton></div>
    <p v-if="state.busy" class="crypto-save-status" role="status">正在同步与保存…</p><p v-else-if="state.notice" class="crypto-save-status" role="status">{{ state.notice }}</p>
    <p v-if="state.poolError" class="crypto-muted" role="status">{{ state.poolError }}</p>
    <p v-if="s&&priceNotice" class="crypto-muted" role="status">{{ priceNotice }}</p>
    <CryptoSetupPanel v-if="!s" :busy="state.busy" :pool="state.pool" :history="state.history" :blocked="Boolean(state.pending)||Boolean(state.poolError)" @create="controller.act('create',$event)" @resume="controller.select($event)" @records="records" />
    <template v-else>
      <div class="crypto-account" data-testid="crypto-account"><div v-for="[label,value,id] in [['账户权益 · USDT',s.summary.accountEquity,'crypto-equity'],['仓外可用',s.account.availableBalance,'crypto-available'],['委托冻结',s.reservedBalance,'crypto-reserved'],['本次净盈亏',s.summary.netPnl,'crypto-net-summary']]" :key="label"><span>{{ label }}</span><strong :data-testid="id" :title="String(value)">{{ amount(value,display.precision==='full'?8:2) }}</strong></div></div>
      <div class="crypto-terminal-grid" :class="{'order-collapsed':preferences.collapsed}">
        <div class="crypto-terminal-main">
          <CryptoChartWorkspace v-model="preferences" :session="s" :markets="state.markets" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch||Boolean(cancellation)||Boolean(orderEditor)" :price-draft="orderChartDraft" @price-drag="priceDrag" @confirm-price="confirmPriceDraft" @cancel-price="cancelPriceDraft" @request-cancellation="requestCancellation" />
          <p v-if="s.ending&&s.status!=='completed'" class="crypto-alert" role="status">{{ s.status==='end-blocked'?'结束受阻：预留分钟容量不足，仍有仓位；不能揭晓或复练。':'正在结束：继续推进以退出剩余仓位，不再新开仓。' }}</p>
          <CryptoPositionPanel :key="s.id" :session="s" :traces="state.traces" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch||Boolean(priceDraft)||priceDragging||Boolean(cancellation)||Boolean(orderEditor)" @command="command" @cancel-order="requestCancellation" @edit-order="requestOrderEdit" @records="records" />
          <CryptoReviewPanel v-if="s.status==='completed'" :key="`review:${s.id}`" :session="s" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch" @blind="controller.act('blind',{review:$event})" @reveal="controller.act('reveal')" @post="controller.act('post',{review:$event})" @retrain="retrain" />
          <footer class="crypto-workspace-footer"><span>成交、资金费与风险事件后自动暂停</span><button type="button" class="crypto-text-button" @click="openData">数据来源与教学规则</button><button type="button" class="crypto-text-button" @click="records(true)">完整记录与资金账本 ↗</button></footer>
        </div>
        <div class="crypto-terminal-side">
          <section class="crypto-playback" aria-label="回放控制">
            <div class="crypto-playback-heading">
              <button type="button" class="crypto-icon" :aria-label="playing?'暂停回放':'自动回放'" :disabled="!playing&&(locked||s.status!=='active'||s.ending)" @click="playing=!playing"><Pause v-if="playing" :size="16" /><Play v-else :size="16" /></button>
              <div><strong>{{ relativeTime(s.elapsedMinutes) }}</strong><small>{{ s.attemptInfo.kind==='first'?'首次盲测':`复练 #${s.attemptInfo.attemptNumber}` }} · {{ s.config.leverage }}倍</small></div>
              <UiSelect v-model="preferences.playbackSpeed" class="crypto-playback-speed" aria-label="自动回放倍率" title="调整播放间隔；每次仍推进 1 分钟，事件发生后暂停"><option v-for="speed in CRYPTO_PLAYBACK_SPEEDS" :key="speed" :value="speed">{{ speed }}×</option></UiSelect>
            </div>
            <div class="crypto-playback-progress"><div><span>练习进度</span><span>{{ Math.round(progress*100)/100 }}%</span></div><progress :value="progress" max="100" aria-label="练习进度" /></div>
            <div class="crypto-playback-steps"><UiButton v-for="n in [1,5,15]" :key="n" variant="secondary" :disabled="locked||s.status!=='active'" @click="advance(n)">推进 {{ n }} 分钟</UiButton></div>
            <div class="crypto-playback-actions"><UiButton variant="secondary" class="crypto-finish" :disabled="locked||s.status!=='active'||s.ending" @click="stop();finishOpen=true">结束练习</UiButton><UiButton variant="secondary" :disabled="locked" @click="fresh">新开一局</UiButton></div>
          </section>
          <CryptoTradingPanel v-show="!preferences.collapsed" :key="s.id" :session="s" :preview-order="api.cryptoPreview" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch||Boolean(priceDraft)||priceDragging||Boolean(cancellation)||Boolean(orderEditor)" @command="command" />
        </div>
      </div>
    </template>
    <UiDrawer :open="settingsOpen" title="交易与显示设置" description="交易参数开局后冻结；显示偏好可随时调整。" panel-class="crypto-controls crypto-data-drawer" @close="settingsOpen=false"><label>账户数字精度<UiSelect v-model="display.precision" aria-label="账户数字显示精度"><option value="auto">摘要 · 两位小数</option><option value="full">完整 · 八位小数</option></UiSelect></label><p>布局、各图周期和联动开关会在本浏览器记住。</p><template v-if="s"><dl class="crypto-detail-facts"><div><dt>杠杆 / 持仓</dt><dd>{{ s.config.leverage }}倍 · 逐仓单向</dd></div><div><dt>固定 Maker / Taker</dt><dd>{{ Number(s.frozenRules.makerRate)*100 }}% / {{ Number(s.frozenRules.takerRate)*100 }}%</dd></div><div><dt>单边教学滑点</dt><dd>{{ s.frozenRules.slippageBps }} bps</dd></div></dl></template><button type="button" class="crypto-text-button" @click="settingsOpen=false;openData()">查看数据来源与完整规则</button></UiDrawer>
    <UiModal :open="Boolean(orderEditor)" title="修改委托" description="确认前原委托仍有效。" :busy="state.busy||priceSaving" panel-class="crypto-controls crypto-order-editor" @close="clearOrderEditor">
      <form v-if="orderEditor" @submit.prevent="confirmOrderEdit">
        <p class="crypto-muted">{{ orderEditor.order.intent==='reduce'?(orderEditor.order.side==='long'?'平多':'平空'):(orderEditor.order.side==='long'?'开多':'开空') }} · 已成交 {{ orderEditor.order.filledContracts }} 张保持不变</p>
        <div class="crypto-order-editor-fields"><label v-if="orderEditor.order.type==='limit'">委托价格<UiInput v-model="orderEditPrice" aria-label="新委托价" inputmode="decimal" required :disabled="state.busy||priceSaving" /></label><label>剩余数量 · 张<UiInput v-model="orderEditQuantity" aria-label="新剩余数量" inputmode="decimal" required :disabled="state.busy||priceSaving" /></label></div>
        <table class="crypto-order-comparison">
          <thead><tr><th scope="col">项目</th><th scope="col">修改前</th><th scope="col">修改后</th></tr></thead><tbody>
          <tr><th scope="row">委托价</th><td>{{ orderEditor.order.limitPrice??'市价' }}</td><td>{{ orderEditor.order.type==='market'?'市价':orderEditDraft?.price??'—' }}</td></tr>
          <tr><th scope="row">剩余 · 张</th><td>{{ orderEditor.order.remainingContracts }}</td><td>{{ orderEditDraft?.remainingContracts??'—' }}</td></tr>
          <tr><th scope="row">冻结 · USDT</th><td>{{ amount(orderEditor.order.reservedBalance,8) }}</td><td data-testid="order-amend-reserve">{{ orderPreviewReady?amount(orderPreview.after.reservedBalance,8):'—' }}</td></tr>
          <tr><th scope="row">可用 · USDT</th><td :title="String(orderEditor.session.account.availableBalance)">{{ amount(orderEditor.session.account.availableBalance,2) }}</td><td data-testid="order-amend-available" :title="orderPreviewReady?orderPreview.funds.availableBalanceAfter:''">{{ orderPreviewReady?amount(orderPreview.funds.availableBalanceAfter,2):'—' }}</td></tr>
        </tbody>
        </table>
        <p v-if="orderPreviewReady" class="crypto-muted" data-testid="order-amend-change">{{ ({increase:'增加冻结',release:'释放冻结',unchanged:'冻结不变'})[orderPreview.funds.reserveChangeType] }} {{ amount(orderPreview.funds.reserveChangeAmount,8) }} USDT</p>
        <p v-if="orderPreviewBusy" class="crypto-muted" role="status">核算冻结资金…</p>
        <p v-if="orderPreviewError" class="crypto-muted" role="alert">{{ orderPreviewError }} <button type="button" class="crypto-text-button" @click="refreshOrderPreview">重新预览</button></p>
        <p class="crypto-muted">{{ orderEditor.order.type==='limit'?`价格按 ${orderEditor.session.contract.tickSz} 对齐；`:'' }}数量步长 {{ orderEditor.session.contract.lotSz }} 张，全部取消请撤单。</p>
        <p v-if="orderEditDraft?.order.type==='limit'&&priceDraftReached(s,orderEditDraft)" class="crypto-muted" role="status">新价格已越过当前价，下一分钟可能按吃单成交。</p>
        <div class="crypto-order-editor-actions"><UiButton variant="secondary" :disabled="state.busy||priceSaving" @click="clearOrderEditor">取消调整</UiButton><UiButton type="submit" :disabled="!orderPreviewReady||state.busy||priceSaving">确认生效</UiButton></div>
      </form>
    </UiModal>
    <ConfirmDialog :open="Boolean(cancellation)" :title="cancellationTitle" :message="cancellationMessage" confirm-text="确认撤销" cancel-text="保留" :busy="state.busy||priceSaving" @cancel="clearCancellation" @confirm="confirmCancellation" />
    <ConfirmDialog :open="finishOpen" title="结束本次练习？" message="结束练习会处理剩余仓位；退出完成后先提交盲评，再揭晓。仅平仓请使用图表下方的持仓操作。" confirm-text="结束并进入盲评" :busy="state.busy" @cancel="finishOpen=false" @confirm="finish" />
  </div>
</template>
