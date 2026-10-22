<script setup>
import { computed, inject, onActivated, onDeactivated, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Settings2, Play, Pause } from 'lucide-vue-next';
import { api } from '../services/api.js';
import UiButton from '../components/ui/UiButton.vue';
import UiSelect from '../components/ui/UiSelect.vue';
import UiDrawer from '../components/ui/UiDrawer.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CryptoSetupPanel from '../components/crypto/CryptoSetupPanel.vue';
import CryptoTradingPanel from '../components/crypto/CryptoTradingPanel.vue';
import CryptoPositionPanel from '../components/crypto/CryptoPositionPanel.vue';
import CryptoChartWorkspace from '../components/crypto/CryptoChartWorkspace.vue';
import CryptoReviewPanel from '../components/crypto/CryptoReviewPanel.vue';
import { createCryptoReplayController } from '../utils/cryptoReplayController.js';
import { amount, relativeTime } from '../utils/cryptoReplayPresentation.js';
import { loadCryptoPreferences, CRYPTO_WORKSPACE_KEY, cryptoVisiblePeriods } from '../utils/cryptoWorkspacePreferences.js';
import '../components/crypto/crypto-terminal.css';
const route=useRoute(),router=useRouter();
const openData=inject('openCryptoData',()=>{});
const state=shallowRef({}),preferences=ref(loadCryptoPreferences(localStorage));
const controller=createCryptoReplayController({api,storage:localStorage,changed:value=>{state.value=value;}});
controller.state.timeframes=cryptoVisiblePeriods(preferences.value);controller.state.timeframe=controller.state.timeframes[0];state.value={...controller.state};
const s=computed(()=>state.value.session);
const progress=computed(()=>Math.min(100,Math.max(0,Number(s.value?.elapsedMinutes??0)/Math.max(1,Number(s.value?.gameLength??1))*100)));
const routeMismatch=computed(()=>route.name==='crypto-market-replay'&&typeof route.query.session==='string'&&route.query.session!==s.value?.id);
const locked=computed(()=>state.value.busy||Boolean(state.value.pending)||routeMismatch.value);
const finishOpen=ref(false),settingsOpen=ref(false),playing=ref(false);
const retraining=ref(false);
const display=reactive({precision:'auto'});
let playbackTimer;
let lastRequestedSession=null;
function records(focusCurrent=false) { playing.value=false;router.push({path:'/decision/trade-records',query:{tab:'replay',market:'crypto-perpetual',...(focusCurrent===true&&s.value?{session:s.value.id}:{})}}); }
function command(value,note='') {playing.value=false;return controller.act('command',{command:value,...(note?{note}:{})});}
async function fresh() {playing.value=false;await controller.fresh();if(!state.value.session) await router.replace({query:{}});}
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
async function advance(minutes=1) {playing.value=false;return controller.act('advance',{minutes});}
async function tick() {
  if(!playing.value||locked.value||s.value?.status!=='active'||s.value?.ending){playing.value=false;return;}
  const sequence=state.value.traces.at(-1)?.sequence??0;
  const ok=await controller.act('advance',{minutes:1});
  const paused=state.value.traces.some(e=>e.sequence>sequence&&['order-filled','funding-settled','protection-triggered','teaching-liquidation','risk-triggered','end-filled','training-ended'].includes(e.type));
  if(!ok||paused||s.value?.status!=='active') playing.value=false;
  if(playing.value) playbackTimer=setTimeout(tick,900);
}
watch(playing,value=>{clearTimeout(playbackTimer);if(value) playbackTimer=setTimeout(tick,200);});
function stop() {playing.value=false;clearTimeout(playbackTimer);}
onDeactivated(stop);onBeforeUnmount(stop);
async function finish() {stop();if(await controller.act('finish')) finishOpen.value=false;}
async function retrain() {
  stop();retraining.value=true;
  try {if(await controller.act('retrain')) await router.replace({query:{session:state.value.session.id}});}
  finally {retraining.value=false;}
}
</script>
<template>
  <div class="crypto-workspace crypto-controls" :class="{'crypto-workspace--setup':!s}" :aria-busy="state.busy">
    <header v-if="s" class="crypto-header"><div><p class="crypto-eyebrow">USDT 永续 / 历史盲测</p><h1>{{ s?s.instrumentId:'合约练习' }} <span v-if="s">逐仓 · 单向</span></h1><div v-if="s" class="crypto-quotes"><span>最新价 <b data-testid="crypto-last">{{ amount(s.currentPrices.last,4) }}</b></span><span>标记价格 <b>{{ amount(s.currentPrices.mark,4) }}</b></span></div></div><div class="crypto-header-actions"><UiButton variant="secondary" @click="records">演练记录</UiButton><button v-if="s" type="button" class="crypto-icon" aria-label="交易与显示设置" title="交易与显示设置" @click="settingsOpen=true"><Settings2 :size="17" /></button><UiButton v-if="s" variant="secondary" :disabled="locked" @click="fresh">新开一局</UiButton></div></header>
    <div v-if="state.error" class="crypto-alert" role="alert"><span>{{ state.error }}</span><UiButton v-if="!state.pending" variant="secondary" :disabled="state.busy" @click="resync">重新同步</UiButton></div>
    <div v-if="state.pending&&!state.busy" class="crypto-alert" role="status"><span>上次动作的结果待核对；核对前不能提交新动作。可以从演练记录查看历史。</span><UiButton variant="secondary" @click="controller.retry()">重试原动作</UiButton></div>
    <p v-if="state.busy" class="crypto-save-status" role="status">正在同步与保存…</p><p v-else-if="state.notice" class="crypto-save-status" role="status">{{ state.notice }}</p>
    <p v-if="state.poolError" class="crypto-muted" role="status">{{ state.poolError }}</p>
    <CryptoSetupPanel v-if="!s" :busy="state.busy" :pool="state.pool" :history="state.history" :blocked="Boolean(state.pending)||Boolean(state.poolError)" @create="controller.act('create',$event)" @resume="controller.select($event)" @records="records" />
    <template v-else>
      <div class="crypto-account" data-testid="crypto-account"><div v-for="[label,value,id] in [['账户权益 · USDT',s.summary.accountEquity,'crypto-equity'],['仓外可用',s.account.availableBalance,'crypto-available'],['委托冻结',s.reservedBalance,'crypto-reserved'],['本次净盈亏',s.summary.netPnl,'crypto-net-summary']]" :key="label"><span>{{ label }}</span><strong :data-testid="id" :title="String(value)">{{ amount(value,display.precision==='full'?8:2) }}</strong></div></div>
      <div class="crypto-terminal-grid" :class="{'order-collapsed':preferences.collapsed}">
        <div class="crypto-terminal-main">
          <CryptoChartWorkspace v-model="preferences" :session="s" :markets="state.markets" :busy="state.busy" />
          <p v-if="s.ending&&s.status!=='completed'" class="crypto-alert" role="status">{{ s.status==='end-blocked'?'结束受阻：预留分钟容量不足，仍有仓位；不能揭晓或复练。':'正在结束：继续推进以退出剩余仓位，不再新开仓。' }}</p>
          <CryptoPositionPanel :key="s.id" :session="s" :traces="state.traces" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch" @command="command" @records="records" />
          <CryptoReviewPanel v-if="s.status==='completed'" :key="`review:${s.id}`" :session="s" :traces="state.traces" :ledger="state.ledger" :analysis="state.analysis" :analysis-error="state.analysisError" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch" @blind="controller.act('blind',{review:$event})" @reveal="controller.act('reveal')" @post="controller.act('post',{review:$event})" @retrain="retrain" />
          <footer class="crypto-workspace-footer"><span>成交、资金费与风险事件后自动暂停</span><button type="button" class="crypto-text-button" @click="openData">数据来源与教学规则</button><button type="button" class="crypto-text-button" @click="records(true)">完整记录与资金账本 ↗</button></footer>
        </div>
        <div class="crypto-terminal-side">
          <section class="crypto-playback" aria-label="回放控制">
            <div class="crypto-playback-heading">
              <button type="button" class="crypto-icon" :aria-label="playing?'暂停回放':'自动回放'" :disabled="locked||s.status!=='active'||s.ending" @click="playing=!playing"><Pause v-if="playing" :size="16" /><Play v-else :size="16" /></button>
              <div><strong>{{ relativeTime(s.elapsedMinutes) }}</strong><small>{{ s.attemptInfo.kind==='first'?'首次盲测':`复练 #${s.attemptInfo.attemptNumber}` }} · {{ s.config.leverage }}倍</small></div>
            </div>
            <div class="crypto-playback-progress"><div><span>练习进度</span><span>{{ Math.round(progress*100)/100 }}%</span></div><progress :value="progress" max="100" aria-label="练习进度" /></div>
            <div class="crypto-playback-steps"><UiButton v-for="n in [1,5,15]" :key="n" variant="secondary" :disabled="locked||s.status!=='active'" @click="advance(n)">推进 {{ n }} 分钟</UiButton></div>
            <UiButton variant="secondary" class="crypto-finish" block :disabled="locked||s.status!=='active'||s.ending" @click="stop();finishOpen=true">结束练习</UiButton>
          </section>
          <CryptoTradingPanel v-show="!preferences.collapsed" :key="s.id" :session="s" :preview-order="api.cryptoPreview" :busy="state.busy" :blocked="Boolean(state.pending)||routeMismatch" @command="command" />
        </div>
      </div>
    </template>
    <UiDrawer :open="settingsOpen" title="交易与显示设置" description="交易参数开局后冻结；显示偏好可随时调整。" panel-class="crypto-controls crypto-data-drawer" @close="settingsOpen=false"><label>账户数字精度<UiSelect v-model="display.precision" aria-label="账户数字显示精度"><option value="auto">摘要 · 两位小数</option><option value="full">完整 · 八位小数</option></UiSelect></label><p>布局、各图周期和联动开关会在本浏览器记住。</p><template v-if="s"><dl class="crypto-detail-facts"><div><dt>杠杆 / 持仓</dt><dd>{{ s.config.leverage }}倍 · 逐仓单向</dd></div><div><dt>固定 Maker / Taker</dt><dd>{{ Number(s.frozenRules.makerRate)*100 }}% / {{ Number(s.frozenRules.takerRate)*100 }}%</dd></div><div><dt>单边教学滑点</dt><dd>{{ s.frozenRules.slippageBps }} bps</dd></div></dl></template><button type="button" class="crypto-text-button" @click="settingsOpen=false;openData()">查看数据来源与完整规则</button></UiDrawer>
    <ConfirmDialog :open="finishOpen" title="结束本次练习？" message="结束练习会处理剩余仓位；退出完成后先提交盲评，再揭晓。仅平仓请使用图表下方的持仓操作。" confirm-text="结束并进入盲评" :busy="state.busy" @cancel="finishOpen=false" @confirm="finish" />
  </div>
</template>
