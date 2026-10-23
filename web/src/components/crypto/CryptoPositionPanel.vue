<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { FileText, Info, Pencil } from 'lucide-vue-next';
import UiButton from '../ui/UiButton.vue';
import UiDrawer from '../ui/UiDrawer.vue';
import UiInput from '../ui/UiInput.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTooltip from '../ui/UiTooltip.vue';
import CryptoModelNotice from './CryptoModelNotice.vue';
import { cryptoProtectionEstimate } from '../../utils/cryptoProtectionEstimate.js';
import { amount, riskPlan, cryptoRiskDetails, plannedPricePnl, eventName, relativeTime } from '../../utils/cryptoReplayPresentation.js';
const props=defineProps({session:{type:Object,required:true},traces:{type:Array,default:()=>[]},busy:Boolean,blocked:Boolean});
const emit=defineEmits(['command','records']);
const tab=ref('持仓'), drawer=ref(''), selectedActivity=ref(null);
const position=computed(()=>props.session.account.position), plan=computed(()=>riskPlan(props.session)), risk=computed(()=>cryptoRiskDetails(props.session));
const floatingReturn=computed(()=>cryptoProtectionEstimate(props.session,props.session.currentPrices.mark)?.returnPercent);
const pnlTone=computed(()=>Number(props.session.risk?.unrealizedPnl)>0?'profit':Number(props.session.risk?.unrealizedPnl)<0?'loss':'neutral');
const disabled=computed(()=>props.busy||props.blocked||props.session.status!=='active'||props.session.ending);
const historyTypes=['order-submitted','order-amended','order-filled','order-cancelled','order-rejected'];
const fillTypes=['order-filled','protection-filled','end-filled'];
const activityRows=computed(()=>{
  if(tab.value==='当前委托') return props.session.orders.map(order=>activityRow(order,null));
  const orders=new Map(), rows=[];
  for(const event of props.traces) {
    if(event.order) orders.set(event.order.id,{...event.order});
    if(event.type==='order-amended'&&orders.has(event.orderId)) orders.set(event.orderId,{...orders.get(event.orderId),limitPrice:event.limitPrice});
    if((tab.value==='成交'?fillTypes:historyTypes).includes(event.type)) rows.push(activityRow(orders.get(event.orderId)??event.order??{},event));
  }
  return rows;
});
function direction(order) {
  if(!order.side) return '—';
  return order.intent==='reduce'?(order.side==='long'?'平多':'平空'):(order.side==='long'?'开多':'开空');
}
function activityRow(order,event) {
  const source={...order,...event}, filled=Boolean(event?.quote);
  return {key:event?.sequence??order.id,order,event,direction:direction(source),
    label:event?eventName(event.type):(order.type==='limit'?'限价':'市价'),
    price:event?.quote?.fillPrice??event?.limitPrice??order.limitPrice,
    market:!filled&&order.type==='market',
    quantity:event?.quote?.contracts??event?.remainingContracts??event?.unfilledContracts??order.remainingContracts??order.contracts,
    quantityLabel:filled?'成交量':!event||event.type==='order-amended'||event.type==='order-cancelled'?'未成交':'委托量',
    priceLabel:filled?'成交价':'委托价'};
}
function showActivity(row) { selectedActivity.value=row;drawer.value='activity'; }
const activityDetails=computed(()=>{
  const row=selectedActivity.value;if(!row) return [];
  const {order:o,event:e}=row;
  return [['交易品种',props.session.instrumentId],['方向',row.direction],['事件',row.label],['时间',e?relativeTime(e.observedAtMinute):null],
    ['委托编号',e?.orderId??o.id],['委托类型',o.type?(o.type==='limit'?'限价':'市价'):null],['原委托价',e?.oldPrice],
    [row.priceLabel,row.market?'市价':row.price],[`${row.quantityLabel} · 张`,row.quantity],['原委托量 · 张',o.contracts],
    ['手续费 · USDT',e?.quote?.fee],['已实现盈亏 · USDT',e?.realizedPnl],['冻结资金 · USDT',e?.reservedBalance??(!e?o.reservedBalance:null)],
    ['释放冻结 · USDT',e?.releasedReserve],['原因',({'user':'手动撤单','position-closed':'持仓已平','reduce-only-position-shrank':'持仓减少','risk-cancellation':'风险接管','IOC-unfilled-remainder':'市价单剩余量未成交','remaining-reserve-shortfall':'剩余可用资金不足','protective-exit-triggered':'止盈止损触发','training-end':'练习结束','NO_MINUTE_CAPACITY':'当前分钟无可成交数量','NO_AFFORDABLE_OR_TIER_CAPACITY':'资金或仓位档位不足'})[e?.reason]??e?.reason]].filter(([,value])=>value!=null&&value!=='');
});
const form=reactive({mode:'none',price:'',reason:'',stop:'',profit:'',reference:'last',topup:''});
watch(()=>props.session.id,()=>{drawer.value='';selectedActivity.value=null;},{immediate:true});
function open(value) {
  const s=props.session;
  Object.assign(form,{mode:s.trainingJournal.plan.mode,price:s.trainingJournal.plan.manualExitPrice??'',reason:s.trainingJournal.plan.reason??'',stop:s.protection?.stopLoss?.price??'',profit:s.protection?.takeProfit?.price??'',reference:s.protection?.stopLoss?.reference??s.protection?.takeProfit?.reference??'last',topup:''});drawer.value=value;
}
function protection() {emit('command',{type:'set-protection',...(form.stop?{stopLoss:{price:form.stop,reference:form.reference}}:{}),...(form.profit?{takeProfit:{price:form.profit,reference:form.reference}}:{})});}
</script>
<template>
  <section class="crypto-position" data-testid="crypto-risk">
    <nav class="crypto-section-tabs" aria-label="本局交易信息"><button v-for="v in ['持仓','当前委托','历史委托','成交']" :key="v" type="button" :aria-pressed="tab===v" @click="tab=v">{{ v }}<small v-if="v==='持仓'"> {{ position?1:0 }}</small><small v-if="v==='当前委托'"> {{ session.orders.length }}</small></button><button type="button" class="crypto-text-button position-records" @click="emit('records')">演练记录 ↗</button></nav>
    <template v-if="tab==='持仓'">
<div class="crypto-position-facts crypto-position-table"><div><span>交易品种<button type="button" class="crypto-position-icon" aria-label="持仓详情与完整精度" title="持仓详情与完整精度" @click="open('details')"><Info aria-hidden="true" /></button></span><strong>{{ session.instrumentId }}</strong><small>{{ session.config.leverage }}倍 · {{ position?.side==='short'?'做空':position?'做多':'未持仓' }}</small></div><div><span>持仓量</span><strong>{{ position?`${position.contracts} 张`:'空仓' }}</strong></div><div><span>开仓均价</span><strong>{{ amount(position?.entryPrice,4) }}</strong></div><div><span>预估强平价</span><strong>{{ amount(session.risk?.estimatedLiquidationPrice,4) }}</strong></div><div class="crypto-position-pnl" :data-tone="pnlTone"><span>浮动盈亏 · USDT</span><strong>{{ amount(session.risk?.unrealizedPnl) }}</strong><small v-if="position">{{ amount(floatingReturn) }}%</small></div><div><span>保证金 · USDT<button type="button" class="crypto-position-icon" aria-label="调整保证金" title="调整保证金" :disabled="disabled||!position" @click="open('margin')"><Pencil aria-hidden="true" /></button></span><strong data-testid="crypto-margin">{{ amount(position?.marginBalance) }}</strong><small>逐仓</small></div><div data-testid="crypto-protection"><span>止盈 / 止损<button type="button" class="crypto-position-icon" aria-label="止盈止损" title="止盈止损" :disabled="disabled||!position" @click="open('protection')"><Pencil aria-hidden="true" /></button></span><strong class="crypto-position-protection-prices"><em>盈</em>{{ session.protection?.takeProfit?.price??'—' }}<i aria-hidden="true">/</i><em>损</em>{{ session.protection?.stopLoss?.price??'—' }}</strong></div><div class="crypto-position-close"><UiButton variant="secondary" :disabled="disabled||!position" @click="drawer='close'">市价平全部</UiButton></div></div>
      <div class="crypto-position-note"><span class="crypto-risk-badge" :data-risk-mode="plan.mode">{{ plan.label }}</span><button type="button" class="crypto-position-icon" aria-label="手动退出计划" title="手动退出计划" :disabled="disabled" @click="open('plan')"><FileText aria-hidden="true" /></button><UiTooltip clickable wide label="持仓与退出规则说明" :content="`${plan.detail} 一腿触发取消另一腿，保护数量随剩余持仓联动。教学强平会全仓接管，保证金不返还；估算强平价不是保证成交价。`" /><span>按标记价格估值 · 保护随持仓联动</span></div>
    </template>
    <template v-else>
      <ul v-if="activityRows.length" class="crypto-activity-list" :aria-label="tab">
        <li v-for="row in activityRows" :key="row.key" class="crypto-activity-row">
          <div class="crypto-activity-heading"><strong>{{ row.direction }}</strong><small>{{ row.label }}</small></div>
          <div class="crypto-activity-value"><span>{{ row.priceLabel }}</span><strong>{{ row.market?'市价':amount(row.price,4) }}</strong></div>
          <div class="crypto-activity-value"><span>{{ row.quantityLabel }} · 张</span><strong>{{ row.quantity??'—' }}</strong></div>
          <div class="crypto-activity-actions"><button type="button" class="crypto-position-icon" :aria-label="tab==='成交'?'成交详情':'委托详情'" :title="tab==='成交'?'成交详情':'委托详情'" @click="showActivity(row)"><Info aria-hidden="true" /></button><UiButton v-if="tab==='当前委托'" variant="secondary" :disabled="disabled" @click="emit('command',{type:'cancel-order',orderId:row.order.id})">撤单</UiButton></div>
        </li>
      </ul>
      <p v-else class="crypto-empty">{{ tab==='当前委托'?'暂无待成交委托。':`暂无${tab}。` }}</p>
    </template>
    <UiDrawer :open="Boolean(drawer)" :title="({plan:'手动退出计划',protection:'持仓止盈止损',margin:'调整逐仓保证金',details:'持仓详情与完整精度',close:'市价平全部',activity:selectedActivity?.event?.quote?'成交详情':'委托详情'})[drawer]??'持仓操作'" :description="drawer==='activity'?'本局委托与成交记录。':'持仓操作沿用本局冻结规则。'" panel-class="crypto-controls crypto-data-drawer" @close="drawer=''">
      <form v-if="drawer==='plan'" @submit.prevent="emit('command',{type:'set-plan',mode:form.mode,manualExitPrice:form.mode==='manual'?form.price:null,reason:form.reason})"><p class="crypto-muted">手动计划仅记录判断，不自动提交平仓委托。</p><label>计划方式<UiSelect v-model="form.mode" aria-label="计划方式" :disabled="disabled"><option value="none">未设退出价</option><option value="manual">手动退出计划</option></UiSelect></label><label v-if="form.mode==='manual'">手动退出价<UiInput v-model="form.price" aria-label="手动退出价" required inputmode="decimal" :disabled="disabled" /></label><label>计划原因<UiInput v-model="form.reason" aria-label="计划原因" maxlength="2000" :disabled="disabled" /></label><UiButton type="submit" :disabled="disabled">保存退出计划</UiButton><p class="crypto-muted">{{ session.trainingJournal.plan.reason }}</p></form>
      <form v-else-if="drawer==='protection'" @submit.prevent="protection"><label>自动止损价<UiInput v-model="form.stop" aria-label="持仓自动止损价" inputmode="decimal" :disabled="disabled" /></label><label>自动止盈价<UiInput v-model="form.profit" aria-label="持仓自动止盈价" inputmode="decimal" :disabled="disabled" /></label><label>触发参考<UiSelect v-model="form.reference" aria-label="持仓保护触发参考" :disabled="disabled"><option value="last">最新价</option><option value="mark">标记价格</option></UiSelect></label><p class="crypto-muted">触发后按市价减仓，可能滑点或部分成交。切换图表不改变委托触发依据。</p><UiButton type="submit" :disabled="disabled||(!form.stop&&!form.profit)">更新持仓保护</UiButton><div v-if="session.protection" class="crypto-position-actions"><UiButton variant="secondary" :disabled="disabled" @click="emit('command',{type:'cancel-protection'})">取消全部保护</UiButton><UiButton v-if="session.protection.stopLoss" variant="secondary" :disabled="disabled" @click="emit('command',{type:'cancel-protection',leg:'stopLoss'})">仅取消止损</UiButton><UiButton v-if="session.protection.takeProfit" variant="secondary" :disabled="disabled" @click="emit('command',{type:'cancel-protection',leg:'takeProfit'})">仅取消止盈</UiButton></div></form>
      <form v-else-if="drawer==='margin'" @submit.prevent="emit('command',{type:'add-margin',amount:form.topup})"><label>追加金额 · USDT<UiInput v-model="form.topup" aria-label="追加金额" inputmode="decimal" required :disabled="disabled" /></label><CryptoModelNotice location="risk" /><UiButton type="submit" :disabled="disabled">追加保证金</UiButton><p class="crypto-muted">只从仓外可用资金划入，不增加张数或收入；不会自动补仓。</p></form>
      <template v-else-if="drawer==='close'"><p>仅平掉本仓，练习仍可继续。委托从下一未展示分钟起生效，可能部分成交。</p><UiButton :disabled="disabled" @click="emit('command',{type:'market-close'});drawer=''">确认市价平全部</UiButton></template>
      <template v-else-if="drawer==='activity'"><dl class="crypto-detail-facts"><div v-for="[label,value] in activityDetails" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></div></dl></template>
      <template v-else><dl class="crypto-detail-facts"><div v-for="[label,value] in [['标记价格',session.currentPrices.mark],['开仓均价',position?.entryPrice],['预估强平价',session.risk?.estimatedLiquidationPrice],['账户权益',session.summary.accountEquity],['仓外可用',session.account.availableBalance],['对应币数',risk.baseQuantity],['名义仓位 · mark',risk.notional],['逐仓保证金',position?.marginBalance],['mark 浮动盈亏',session.risk?.unrealizedPnl],['浮盈亏 / 权益 %',risk.unrealizedEquityPercent],['风险率（≤100%触发）',session.risk?Number(session.risk.riskRatio)*100:null],['距离估算强平价 %',risk.liquidationDistancePercent],['计划退出价',plan.price],['计划价格盈亏（未含费用）',plannedPricePnl(session)]]" :key="label"><dt>{{ label }}</dt><dd>{{ amount(value,8) }}</dd></div></dl><p v-if="position&&session.risk?.estimatedLiquidationPrice==null" class="crypto-muted">当前无正强平价估算，不能理解为没有风险。</p><CryptoModelNotice location="risk" /></template>
    </UiDrawer>
  </section>
</template>
