<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Grid2X2, LocateFixed, Maximize2, PanelRightClose, PanelRightOpen } from 'lucide-vue-next';
import CandlestickChart from '../CandlestickChart.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiButton from '../ui/UiButton.vue';
import UiTooltip from '../ui/UiTooltip.vue';
import { priceDraftCurrent, priceDraftReached } from '../../utils/cryptoPriceDraft.js';
import { CRYPTO_PERIODS } from '../../utils/cryptoReplayPresentation.js';
import { projectCryptoCharts } from '../../utils/cryptoChartProjection.js';
import { REPLAY_RISE_COLOR, REPLAY_FALL_COLOR } from '../../utils/replayKlineConfig.js';
const props=defineProps({session:{type:Object,required:true},markets:{type:Object,default:()=>({})},modelValue:{type:Object,required:true},busy:Boolean,blocked:Boolean,priceDraft:{type:Object,default:null}});
const emit=defineEmits(['update:modelValue','price-drag','confirm-price','cancel-price','request-cancellation']);
const draggingIndex=ref(null);
const movingPrice=ref(null);
const selected=ref(0), maximized=ref(null), menu=ref(false), root=ref(null);
const charts=new Map();
const colors=Object.freeze({rise:REPLAY_RISE_COLOR,fall:REPLAY_FALL_COLOR});
const count=computed(()=>props.modelValue.layout==='quad'?4:props.modelValue.layout==='single'?1:2);
const visible=computed(()=>maximized.value==null?Array.from({length:count.value},(_,i)=>i):[maximized.value]);
const prefs=computed(()=>props.modelValue);
const projection=computed(()=>projectCryptoCharts({
  session:props.session,markets:props.markets,
  display:{periods:prefs.value.periods,kinds:prefs.value.kinds},
  interaction:{busy:props.busy,blocked:props.blocked,draggingIndex:draggingIndex.value,movingPrice:movingPrice.value,priceDraft:props.priceDraft},
}));
function drag(index,event) {
  if(event.phase==='move') {movingPrice.value=event;return;}
  movingPrice.value=null;clearCrosshair();draggingIndex.value=event.phase==='start'?index:null;emit('price-drag',event);
}
function escape() {menu.value=false;maximized.value=null;if(props.priceDraft&&!props.busy) emit('cancel-price');}
function patch(value) { emit('update:modelValue',{...prefs.value,...value}); }
function toggle(key,checked) { patch({[key]:checked,...(key==='period'&&checked?{periods:Array(4).fill(prefs.value.periods[selected.value])}:{})}); }
function layout(value) { selected.value=0;maximized.value=null;patch({layout:value}); }
function period(value) { const periods=[...prefs.value.periods]; if(prefs.value.period) periods.fill(Number(value));else periods[selected.value]=Number(value);patch({periods}); }
function kind(value) { const kinds=[...prefs.value.kinds];kinds[selected.value]=value;patch({kinds}); }
function link(index,value) {
  if(!prefs.value.crosshair) return;
  for(const [i,chart] of charts) if(i!==index) chart?.syncCrosshair(value?{...value,price:prefs.value.price&&prefs.value.kinds[i]===prefs.value.kinds[index]?value.price:undefined}:null);
}
function range(index,value) {
  // Programmatic changes from non-active panes never propagate back.
  if(index!==selected.value || props.busy || (!prefs.value.time&&!prefs.value.dateRange)) return;
  for(const [i,chart] of charts) if(i!==index) chart?.syncRange(value,prefs.value.dateRange);
}
function clearCrosshair() {for(const c of charts.values()) c?.syncCrosshair(null);}
function latest() {charts.forEach(chart=>chart.latest());}
defineExpose({latest});
function outside(event) {if(!root.value?.contains(event.target)) menu.value=false;}
onMounted(()=>document.addEventListener('pointerdown',outside));
onBeforeUnmount(()=>document.removeEventListener('pointerdown',outside));
</script>
<template>
  <section ref="root" class="crypto-charts" aria-label="合约多周期行情" @keydown.esc="escape">
    <header class="crypto-chart-toolbar">
      <div class="crypto-period-shortcuts"><button v-for="p in [5,15,60,240]" :key="p" type="button" :aria-pressed="prefs.periods[selected]===p" :disabled="busy" @click="period(p)">{{ CRYPTO_PERIODS.find(([n])=>n===p)[1] }}</button></div>
      <UiSelect :model-value="prefs.periods[selected]" aria-label="选中图周期" :disabled="busy" @update:model-value="period"><option v-for="[v,label] in CRYPTO_PERIODS" :key="v" :value="v">{{ label }}</option></UiSelect>
      <UiSelect :model-value="prefs.kinds[selected]" aria-label="选中图价格类型" @update:model-value="kind"><option value="last">最新价</option><option value="mark">标记价格</option></UiSelect>
      <UiTooltip clickable wide label="止盈止损估算说明" content="预计金额是假设剩余持仓全部按标签价格退出的价格盈亏，不含手续费、滑点和资金费；收益率＝预计盈亏÷剩余开仓保证金基准（剩余入场成本÷本局杠杆）。追加保证金不改变分母。保护线在最新价与标记价图上均显示，线标注明实际触发参考。标记价触发不等于成交价，实际成交和强平结果可能不同。" />
      <button class="crypto-icon" type="button" title="回到当前" aria-label="回到当前" @click="latest"><LocateFixed :size="17" /></button>
      <button class="crypto-icon" type="button" title="图表布局与联动" aria-label="图表布局与联动" :aria-expanded="menu" @click="menu=!menu"><Grid2X2 :size="17" /></button>
      <button class="crypto-icon" type="button" title="放大选中图 / 恢复布局" aria-label="放大选中图或恢复布局" @click="maximized=maximized==null?selected:null"><Maximize2 :size="17" /></button>
      <button class="crypto-icon" type="button" :title="prefs.collapsed?'展开下单面板':'收起下单面板'" :aria-label="prefs.collapsed?'展开下单面板':'收起下单面板'" @click="patch({collapsed:!prefs.collapsed})"><PanelRightOpen v-if="prefs.collapsed" :size="17" /><PanelRightClose v-else :size="17" /></button>
      <div v-if="menu" class="crypto-layout-menu">
        <div class="crypto-layout-options"><button v-for="[key,label] in [['single','单图'],['dual','双列'],['rows','双行'],['quad','四图']]" :key="key" type="button" :aria-pressed="prefs.layout===key" :disabled="busy" @click="layout(key)"><span :class="['crypto-layout-icon',key]"><i v-for="n in key==='quad'?4:key==='single'?1:2" :key="n"></i></span>{{ label }}</button></div>
        <strong>图表联动</strong><label v-for="[key,label] in [['crosshair','十字线时间'],['price','同价格水平线'],['time','时间位置 / 拖动'],['dateRange','日期范围 / 缩放'],['period','周期（默认独立）']]" :key="key"><input type="checkbox" :checked="prefs[key]" @change="toggle(key,$event.target.checked)">{{ label }}</label>
        <p>同一合约，各图独立周期。价格线只在同一价格类型间同步；范围联动限于已加载行情。</p><button type="button" class="crypto-text-button" @click="menu=false">收起布局设置</button>
      </div>
    </header>
    <div v-if="projection.rewardRisk" class="crypto-reward-risk" data-testid="crypto-reward-risk" :data-preview="projection.rewardRisk.preview" :data-ratio="projection.rewardRisk.ratio">
      <span>预计盈亏比</span><strong>{{ projection.rewardRisk.text }}</strong><small v-if="projection.rewardRisk.reason">{{ projection.rewardRisk.reason }}</small><small v-if="projection.rewardRisk.preview" class="crypto-reward-risk-preview">预览</small>
      <UiTooltip clickable wide label="预计盈亏比说明" content="止盈预计盈利÷止损预计亏损的绝对值。例如2 : 1表示预计盈利是预计亏损的2倍。按剩余持仓从入场到各触发价的价格盈亏估算，不含手续费、滑点和资金费；不同触发参考不保证对应实际成交价。拖动时为待确认预览，原保护在确认前仍有效。" />
    </div>
    <section v-if="priceDraft" class="crypto-protection-confirm" :aria-label="priceDraft.kind==='order'?'确认限价委托调整':'确认止盈止损调整'">
      <div><strong>{{ priceDraft.kind==='order'?'委托价':priceDraft.leg==='stopLoss'?'止损':'止盈' }} {{ priceDraft.oldPrice }} → {{ priceDraft.price }}</strong><small v-if="projection.draftEstimate" data-testid="crypto-protection-draft-estimate">{{ projection.draftEstimate }}</small><small v-if="priceDraft.kind!=='order'">{{ priceDraft.protection[priceDraft.leg].reference==='mark'?'标记价格':'最新价' }}触发 · {{ priceDraft.position.contracts }} 张 · 原保护在确认前仍有效</small><small v-else>委托 #{{ priceDraft.orderId }} · 未成交 {{ priceDraft.order.remainingContracts }} 张 · 确认前原委托仍有效</small><p v-if="priceDraftReached(session,priceDraft)" role="status">{{ priceDraft.kind==='order'?'新价格已越过当前价，下一分钟可能按吃单成交。':'新价格已在触发侧，确认后下一分钟可能立即退出。' }}</p></div>
      <div class="crypto-protection-confirm-actions"><UiButton variant="secondary" :disabled="busy" @click="emit('cancel-price')">取消调整</UiButton><UiButton :disabled="busy||blocked||!priceDraftCurrent(session,priceDraft)" @click="emit('confirm-price')">确认生效</UiButton></div>
    </section>
    <div class="crypto-chart-grid" :class="maximized==null?prefs.layout:'single'" @pointerleave="clearCrosshair">
      <section v-for="i in visible" :key="`${session.id}:${i}`" class="crypto-chart-tile" :class="{'is-selected':i===selected}" :data-chart-index="i" tabindex="0" :aria-label="`图${i+1}，按回车选中`" @pointerdown.capture="selected=i" @wheel.capture="selected=i" @focusin="selected=i" @keydown.enter="selected=i">
        <header><button type="button" :aria-pressed="i===selected" @click="selected=i">{{ session.instrumentId }} <b>{{ CRYPTO_PERIODS.find(([v])=>v===prefs.periods[i])[1] }}</b><span>{{ prefs.kinds[i]==='last'?'最新价':'标记价格' }}</span></button><small v-if="i===selected">当前图</small></header>
        <CandlestickChart v-if="markets[prefs.periods[i]]" :key="`${prefs.periods[i]}:${prefs.kinds[i]}`" :ref="value=>value?charts.set(i,value):charts.delete(i)" :bars="projection.models[i].bars" :price-lines="projection.models[i].lines" :price-step="session.contract.tickSz" :colors="colors" compact :show-volume="projection.models[i].showVolume" :height="count===4||prefs.layout==='rows'?280:400" @crosshair="link(i,$event)" @range="range(i,$event)" @price-line-drag="drag(i,$event)" @price-line-cancel="clearCrosshair();emit('request-cancellation',$event)" />
        <p v-else class="crypto-chart-loading" role="status">行情加载中…</p>
      </section>
    </div>
  </section>
</template>
