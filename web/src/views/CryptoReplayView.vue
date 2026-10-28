<script setup>
import { computed, inject, onActivated, onDeactivated, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Settings2 } from 'lucide-vue-next';
import { api } from '../services/api.js';
import UiButton from '../components/ui/UiButton.vue';
import UiAlert from '../components/ui/UiAlert.vue';
import UiDrawer from '../components/ui/UiDrawer.vue';
import UiModal from '../components/ui/UiModal.vue';
import UiInput from '../components/ui/UiInput.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CryptoSetupPanel from '../components/crypto/CryptoSetupPanel.vue';
import CryptoTradingPanel from '../components/crypto/CryptoTradingPanel.vue';
import ReplayPlaybackControls from '../components/replay/ReplayPlaybackControls.vue';
import CryptoPositionPanel from '../components/crypto/CryptoPositionPanel.vue';
import CryptoChartWorkspace from '../components/crypto/CryptoChartWorkspace.vue';
import CryptoReviewPanel from '../components/crypto/CryptoReviewPanel.vue';
import { createCryptoReplayController } from '../utils/cryptoReplayController.js';
import { amount, moneyAmount, relativeTime } from '../utils/cryptoReplayPresentation.js';
import { priceDraftReached } from '../utils/cryptoPriceDraft.js';
import { createCryptoModificationConfirmation } from '../utils/cryptoModificationConfirmation.js';
import { loadCryptoPreferences, CRYPTO_WORKSPACE_KEY, CRYPTO_PLAYBACK_SPEEDS, cryptoVisiblePeriods } from '../utils/cryptoWorkspacePreferences.js';
import '../components/crypto/crypto-terminal.css';
const route=useRoute(),router=useRouter();
const openData=inject('openCryptoData',()=>{});
const state=shallowRef({}),preferences=ref(loadCryptoPreferences(localStorage));
const controller=createCryptoReplayController({api,storage:localStorage,restoreSession:false,changed:value=>{state.value=value;}});
controller.state.timeframes=cryptoVisiblePeriods(preferences.value);controller.state.timeframe=controller.state.timeframes[0];state.value={...controller.state};
const s=computed(()=>state.value.session);
const active=ref(false),orderInputError=ref(''),visibleAlert=shallowRef(null);
const persistentAlert=computed(()=>{
  if(state.value.pending) return {title:'上次操作结果尚未确认',message:state.value.error,context:priceNotice.value,detail:'暂时不能提交新操作。请重试原操作，系统会核对同一次请求，避免重复下单。',action:'retry'};
  if(state.value.readStale) return {title:'需要重新同步',message:state.value.error,context:priceNotice.value,detail:'账户和行情尚未完成核对，暂时不能下单或推进。重新同步只读取数据，不会重复提交订单。',action:'sync'};
  if(state.value.error) return {title:'操作未完成',message:state.value.error,action:'sync'};
  if(s.value?.status==='active'&&!s.value.ending&&orderInputError.value) return {title:'请调整下单信息',message:orderInputError.value};
  if(priceNotice.value) return {title:'请核对当前委托或保护',message:priceNotice.value,canDismiss:true};
  if(s.value?.ending&&s.value.status!=='completed') return {title:s.value.status==='end-blocked'?'结束受阻':'正在结束练习',message:s.value.status==='end-blocked'?'剩余成交容量不足，当前仍有持仓，暂时不能揭晓或复练。':'请继续推进，等待剩余仓位退出；当前不再接受开仓。'};
  if(state.value.poolError) return {title:'新场景暂不可用',message:state.value.poolError};
  return null;
});
watch(()=>s.value?.id,()=>{orderInputError.value='';});
const lastGoodChartPreferences=shallowRef(null);
watch(()=>[state.value.busy,state.value.readStale,state.value.markets,preferences.value],()=>{
  if(!s.value) {lastGoodChartPreferences.value=null;return;}
  if(!state.value.busy&&!state.value.readStale&&cryptoVisiblePeriods(preferences.value).every(period=>state.value.markets[period])) {
    lastGoodChartPreferences.value={...preferences.value,periods:[...preferences.value.periods],kinds:[...preferences.value.kinds]};
  }
},{deep:true});
const chartPreferences=computed({
  get:()=>state.value.readStale&&lastGoodChartPreferences.value?{...preferences.value,layout:lastGoodChartPreferences.value.layout,periods:lastGoodChartPreferences.value.periods}:preferences.value,
  set:value=>{preferences.value=value;},
});
const progress=computed(()=>Math.min(100,Math.max(0,Number(s.value?.elapsedMinutes??0)/Math.max(1,Number(s.value?.gameLength??1))*100)));
const routeMismatch=computed(()=>route.name==='crypto-market-replay'&&typeof route.query.session==='string'&&route.query.session!==s.value?.id);
const confirmationView=shallowRef(null);
const confirmation=createCryptoModificationConfirmation({
  readContext:()=>({session:s.value,busy:state.value.busy||state.value.readStale,pending:state.value.pending,routeMismatch:routeMismatch.value}),
  previewOrder:api.cryptoPreview,
  submitCommand:body=>controller.act('command',body),
  syncSession:()=>controller.sync(),
  pausePlayback:stop,
  changed:value=>{confirmationView.value=value;},
});
confirmationView.value=confirmation.view;
const priceSaving=computed(()=>confirmationView.value.saving),priceNotice=computed(()=>confirmationView.value.notice);
watch([persistentAlert,()=>state.value.busy],([alert,busy])=>{if(!busy) visibleAlert.value=alert;},{immediate:true});
const cancellation=computed(()=>confirmationView.value.cancellation),orderEditor=computed(()=>confirmationView.value.editor);
const orderEditPrice=computed({get:()=>confirmationView.value.input.price,set:price=>confirmation.updateOrder({price})});
const orderEditQuantity=computed({get:()=>confirmationView.value.input.remainingContracts,set:remainingContracts=>confirmation.updateOrder({remainingContracts})});
const orderEditDraft=computed(()=>confirmationView.value.orderDraft),orderPreview=computed(()=>confirmationView.value.preview);
const orderPreviewBusy=computed(()=>confirmationView.value.previewBusy),orderPreviewError=computed(()=>confirmationView.value.previewError);
const orderPreviewReady=computed(()=>confirmationView.value.previewReady),orderCanConfirm=computed(()=>confirmationView.value.canConfirm);
const orderChartDraft=computed(()=>confirmationView.value.chartDraft);
const cancellationTitle=computed(()=>confirmationView.value.title),cancellationMessage=computed(()=>confirmationView.value.message);
const fundingAmount=value=>Number(value)>0&&Number(value)<0.01?'<0.01':amount(value,2);
const availableBalanceAmount=value=>Number(value)<0&&Number(value)>-0.01?'缺口 <0.01':fundingAmount(value);
const locked=computed(()=>confirmationView.value.blockNewActions);
watch(()=>[s.value?.id,s.value?.revision,state.value.busy,state.value.readStale,state.value.pending,routeMismatch.value],()=>confirmation.reconcile());
const finishOpen=ref(false),settingsOpen=ref(false),playing=ref(false);
const retraining=ref(false);
let playbackTimer;
let playbackGeneration=0, playbackInFlight=false;
let lastRequestedSession=null;
function records(focusCurrent=false) { playing.value=false;router.push({path:'/decision/trade-records',query:{tab:'replay',market:'crypto-perpetual',...(focusCurrent===true&&s.value?{session:s.value.id}:{})}}); }
function command(value,note='') {if(locked.value) return false;playing.value=false;return controller.act('command',{command:value,...(note?{note}:{})});}
async function fresh() {if(locked.value) return;playing.value=false;await controller.fresh();if(!state.value.session) await router.replace({query:{}});}
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
async function resync() {
  if(!state.value.readStale) return typeof route.query.session==='string'?loadRequestedSession(route.query.session):controller.sync();
  const ok=await controller.sync();
  if(ok) confirmation.dismissNotice();
  if(ok&&s.value&&typeof route.query.session==='string'&&route.query.session!==s.value.id) await router.replace({query:{...route.query,session:s.value.id}});
  return ok;
}
watch(()=>state.value.busy,value=>{if(!value) {syncRequestedSession();ensurePeriods();}});
watch(()=>route.query.session,()=>{lastRequestedSession=null;syncRequestedSession();});
onActivated(()=>{active.value=true;controller.syncPendingFromStorage();return typeof route.query.session==='string'?loadRequestedSession(route.query.session):controller.sync();});
async function retryPending() {
  const kind=state.value.pending?.kind;
  if(kind==='retrain') retraining.value=true;
  try {
    if(await controller.retry()&&kind==='retrain'&&s.value) await router.replace({query:{...route.query,session:s.value.id}});
  } finally {if(kind==='retrain') retraining.value=false;}
}
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
onDeactivated(()=>{active.value=false;stop();confirmation.reset();});onBeforeUnmount(()=>{stop();confirmation.dispose();});
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
    <Teleport to="body">
      <UiAlert v-if="active&&visibleAlert" id="crypto-active-alert" floating variant="warning" role="alert" :title="visibleAlert.title" :dismissible="visibleAlert.canDismiss" data-testid="crypto-persistent-alert" @dismiss="confirmation.dismissNotice">
        <p v-if="visibleAlert.message" class="crypto-notification-text">{{ visibleAlert.message }}</p>
        <p v-if="visibleAlert.context" class="crypto-notification-text">{{ visibleAlert.context }}</p>
        <p v-if="visibleAlert.detail" class="crypto-notification-text" :data-testid="state.readStale?'crypto-read-stale':undefined">{{ visibleAlert.detail }}</p>
        <UiButton v-if="visibleAlert.action" variant="secondary" class="crypto-notification-action" :disabled="state.busy" @click="visibleAlert.action==='retry'?retryPending():resync()">{{ state.busy?'正在核对…':visibleAlert.action==='retry'?'重试原动作':'重新同步' }}</UiButton>
      </UiAlert>
    </Teleport>
    <p v-if="state.busy" class="crypto-save-status" role="status">正在同步与保存…</p><p v-else-if="state.notice" class="crypto-save-status" role="status">{{ state.notice }}</p>
    <CryptoSetupPanel v-if="!s" :busy="state.busy" :pool="state.pool" :history="state.history" :blocked="Boolean(state.pending)||Boolean(state.poolError)||state.readStale" @create="controller.act('create',$event)" @resume="controller.select($event)" @records="records" />
    <template v-else>
      <div class="crypto-account" data-testid="crypto-account"><div v-for="[label,value,id] in [['账户权益 · USDT',s.summary.accountEquity,'crypto-equity'],['仓外可用',s.account.availableBalance,'crypto-available'],['委托冻结',s.reservedBalance,'crypto-reserved'],['本次净盈亏',s.summary.netPnl,'crypto-net-summary']]" :key="label"><span>{{ label }}</span><strong :data-testid="id" :title="String(value)">{{ moneyAmount(value) }}</strong></div></div>
      <div class="crypto-terminal-grid" :class="{'order-collapsed':preferences.collapsed}">
        <div class="crypto-terminal-main">
          <CryptoChartWorkspace v-model="chartPreferences" :session="s" :markets="state.markets" :busy="state.busy" :blocked="confirmationView.blockChartActions" :price-draft="orderChartDraft" @price-drag="confirmation.handlePriceDrag" @confirm-price="confirmation.confirm" @cancel-price="confirmation.cancel" @request-cancellation="confirmation.openCancellation" />
          <CryptoPositionPanel :key="s.id" :session="s" :traces="state.traces" :busy="state.busy" :blocked="confirmationView.blockNewActions" @command="command" @cancel-order="confirmation.openCancellation" @edit-order="confirmation.openOrder" @records="records" />
          <CryptoReviewPanel v-if="s.status==='completed'" :key="`review:${s.id}`" :session="s" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch||state.readStale" @blind="controller.act('blind',{review:$event})" @reveal="controller.act('reveal')" @post="controller.act('post',{review:$event})" @retrain="retrain" />
          <footer class="crypto-workspace-footer"><span>成交、资金费与风险事件后自动暂停</span><button type="button" class="crypto-text-button" @click="openData">数据来源与教学规则</button><button type="button" class="crypto-text-button" @click="records(true)">完整记录与资金账本 ↗</button></footer>
        </div>
        <div class="crypto-terminal-side">
          <ReplayPlaybackControls
            class="crypto-playback"
            :label="relativeTime(s.elapsedMinutes)" :detail="`${s.attemptInfo.kind==='first'?'首次盲测':`复练 #${s.attemptInfo.attemptNumber}`} · ${s.config.leverage}倍`"
            :playing="playing" :speed="preferences.playbackSpeed" :speeds="CRYPTO_PLAYBACK_SPEEDS.map(value=>({value,label:`${value}×`}))"
            :steps="[1,5,15].map(value=>({value,label:`推进 ${value} 分钟`}))" :progress="progress"
            play-label="自动回放" pause-label="暂停回放" speed-label="自动回放倍率" help="倍率调整播放间隔；每次仍推进 1 分钟，成交或风险事件后暂停。"
            :play-disabled="!playing&&(locked||s.status!=='active'||s.ending)" :steps-disabled="locked||s.status!=='active'"
            @toggle="playing=!playing" @speed="preferences.playbackSpeed=Number($event)" @step="advance"
          >
            <template #actions><UiButton variant="secondary" class="crypto-finish" :disabled="locked||s.status!=='active'||s.ending" @click="stop();finishOpen=true">结束练习</UiButton><UiButton variant="secondary" :disabled="locked" @click="fresh">新开一局</UiButton></template>
          </ReplayPlaybackControls>
          <CryptoTradingPanel v-show="!preferences.collapsed" :key="s.id" :session="s" :preview-order="api.cryptoPreview" :busy="state.busy" :blocked="confirmationView.blockNewActions" @command="command" @validation-error="orderInputError=$event" />
        </div>
      </div>
    </template>
    <UiDrawer :open="settingsOpen" title="交易与显示设置" description="交易参数开局后冻结；显示偏好可随时调整。" panel-class="crypto-controls crypto-data-drawer" @close="settingsOpen=false"><p>布局、各图周期和联动开关会在本浏览器记住。</p><template v-if="s"><dl class="crypto-detail-facts"><div><dt>杠杆 / 持仓</dt><dd>{{ s.config.leverage }}倍 · 逐仓单向</dd></div><div><dt>固定 Maker / Taker</dt><dd>{{ Number(s.frozenRules.makerRate)*100 }}% / {{ Number(s.frozenRules.takerRate)*100 }}%</dd></div><div><dt>单边教学滑点</dt><dd>{{ s.frozenRules.slippageBps }} bps</dd></div></dl></template><button type="button" class="crypto-text-button" @click="settingsOpen=false;openData()">查看数据来源与完整规则</button></UiDrawer>
    <UiModal :open="Boolean(orderEditor)" title="修改委托" description="确认前原委托仍有效。" :busy="state.busy||priceSaving" panel-class="crypto-controls crypto-order-editor" @close="confirmation.cancel">
      <form v-if="orderEditor" @submit.prevent="confirmation.confirm">
        <p class="crypto-muted">{{ orderEditor.order.intent==='reduce'?(orderEditor.order.side==='long'?'平多':'平空'):(orderEditor.order.side==='long'?'开多':'开空') }} · 已成交 {{ orderEditor.order.filledContracts }} 张保持不变</p>
        <div class="crypto-order-editor-fields"><label v-if="orderEditor.order.type==='limit'">委托价格<UiInput v-model="orderEditPrice" aria-label="新委托价" inputmode="decimal" required :disabled="state.busy||state.readStale||priceSaving" /></label><label>剩余数量 · 张<UiInput v-model="orderEditQuantity" aria-label="新剩余数量" inputmode="decimal" required :disabled="state.busy||state.readStale||priceSaving" /></label></div>
        <table class="crypto-order-comparison">
          <thead><tr><th scope="col">项目</th><th scope="col">修改前</th><th scope="col">修改后</th></tr></thead><tbody>
          <tr><th scope="row">委托价</th><td>{{ orderEditor.order.limitPrice??'市价' }}</td><td>{{ orderEditor.order.type==='market'?'市价':orderEditDraft?.price??'—' }}</td></tr>
          <tr><th scope="row">剩余 · 张</th><td>{{ orderEditor.order.remainingContracts }}</td><td>{{ orderEditDraft?.remainingContracts??'—' }}</td></tr>
          <tr><th scope="row">冻结 · USDT</th><td :title="String(orderEditor.order.reservedBalance)">{{ amount(orderEditor.order.reservedBalance,2) }}</td><td data-testid="order-amend-reserve" :title="orderPreviewReady?orderPreview.after.reservedBalance:''">{{ orderPreviewReady?amount(orderPreview.after.reservedBalance,2):'—' }}</td></tr>
          <tr><th scope="row">可用 · USDT</th><td :title="String(orderEditor.session.account.availableBalance)">{{ amount(orderEditor.session.account.availableBalance,2) }}</td><td data-testid="order-amend-available" :title="orderPreviewReady?orderPreview.funds.availableBalanceAfter:''">{{ orderPreviewReady?availableBalanceAmount(orderPreview.funds.availableBalanceAfter):'—' }}</td></tr>
        </tbody>
        </table>
        <p v-if="orderPreviewReady" class="crypto-muted" data-testid="order-amend-change" :title="`${orderPreview.funds.reserveChangeAmount} USDT`">{{ ({increase:'增加冻结',release:'释放冻结',unchanged:'冻结不变'})[orderPreview.funds.reserveChangeType] }} {{ fundingAmount(orderPreview.funds.reserveChangeAmount) }} USDT</p>
        <p v-if="orderPreviewReady&&!orderPreview.funds.affordable" class="crypto-muted" role="alert" data-testid="order-amend-shortfall" :title="`${orderPreview.funds.shortfall} USDT`">资金不足，还差 {{ fundingAmount(orderPreview.funds.shortfall) }} USDT</p>
        <template v-if="orderPreviewReady&&!orderPreview.funds.affordable"><UiButton variant="secondary" :disabled="!(Number(orderPreview.funds.maximumRemainingContracts)>0)||state.busy||state.readStale||priceSaving" @click="confirmation.applyMaximum">调整到最大可用数量 · {{ orderPreview.funds.maximumRemainingContracts }} 张</UiButton><p v-if="orderPreview.funds.maximumRemainingContracts==='0'" class="crypto-muted">可用资金不足最小委托数量。</p></template>
        <p v-if="orderPreviewReady&&orderPreview.changed===false" class="crypto-muted">与原委托一致，无需修改。</p>
        <p v-if="orderPreviewBusy" class="crypto-muted" role="status">核算冻结资金…</p>
        <p v-if="orderPreviewError" class="crypto-muted" role="alert">{{ orderPreviewError }} <button type="button" class="crypto-text-button" @click="confirmation.retryPreview">重新预览</button></p>
        <p class="crypto-muted">{{ orderEditor.order.type==='limit'?`价格按 ${orderEditor.session.contract.tickSz} 对齐；`:'' }}数量步长 {{ orderEditor.session.contract.lotSz }} 张，全部取消请撤单。</p>
        <p v-if="orderEditDraft?.order.type==='limit'&&priceDraftReached(s,orderEditDraft)" class="crypto-muted" role="status">新价格已越过当前价，下一分钟可能按吃单成交。</p>
        <div class="crypto-order-editor-actions"><UiButton variant="secondary" :disabled="state.busy||priceSaving" @click="confirmation.cancel">取消调整</UiButton><UiButton type="submit" :disabled="!orderCanConfirm||state.busy||priceSaving">确认生效</UiButton></div>
      </form>
    </UiModal>
    <ConfirmDialog :open="Boolean(cancellation)" :title="cancellationTitle" :message="cancellationMessage" confirm-text="确认撤销" cancel-text="保留" :busy="state.busy||priceSaving" @cancel="confirmation.cancel" @confirm="confirmation.confirm" />
    <ConfirmDialog :open="finishOpen" title="结束本次练习？" message="结束练习会处理剩余仓位；退出完成后先提交盲评，再揭晓。仅平仓请使用图表下方的持仓操作。" confirm-text="结束并进入盲评" :busy="state.busy" @cancel="finishOpen=false" @confirm="finish" />
  </div>
</template>
