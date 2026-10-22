<script setup>
import { computed, ref, watch } from 'vue';
import UiButton from '../../components/ui/UiButton.vue';
import UiInput from '../../components/ui/UiInput.vue';
import UiSelect from '../../components/ui/UiSelect.vue';
const props = defineProps({ before: Boolean, disabled: Boolean });
const emit = defineEmits(['submit', 'state']);
const operation = ref('开仓');
const side = ref('买入 / 做多');
const type = ref('市价');
const unit = ref('USDT');
const quantity = ref('');
const protection = ref(false);
const reference = ref('最新价');
const stop = ref('');
const profit = ref('');
const risk = ref('保证金');
watch(() => ({操作:operation.value,方向:side.value,类型:type.value,单位:unit.value,数量:quantity.value,估仓方式:risk.value,自动保护:protection.value,止损:stop.value,止盈:profit.value,触发依据:reference.value}), value => emit('state', value), {immediate:true});
const canSubmit = computed(() => Number(quantity.value) > 0 && !props.disabled);
</script>
<template>
  <section class="proto-order" data-feature="order">
    <div class="proto-section-title"><strong>下单</strong><span class="proto-chip">逐仓 · 5×</span></div>
    <form @submit.prevent="emit('submit', { operation, side, type, quantity, unit, protection, reference })">
      <template v-if="before"><label>操作<UiSelect v-model="side" aria-label="原布局合约操作"><option>买入 / 做多</option><option>卖出 / 做空</option><option>仅减仓 / 平仓</option></UiSelect></label><label>委托类型<UiSelect v-model="type" aria-label="原布局委托类型"><option>市价</option><option>限价</option></UiSelect></label></template>
      <template v-else><div class="proto-segments"><button v-for="v in ['开仓','平仓']" :key="v" type="button" :aria-pressed="operation === v" @click="operation=v">{{ v }}</button></div><div class="proto-segments proto-side"><button v-for="v in ['买入 / 做多','卖出 / 做空']" :key="v" type="button" :aria-pressed="side === v" @click="side=v">{{ operation === '平仓' ? v.replace('买入 / 做多','平空').replace('卖出 / 做空','平多') : v }}</button></div><div class="proto-line-tabs"><button v-for="v in ['市价','限价']" :key="v" type="button" :aria-pressed="type===v" @click="type=v">{{ v }}</button></div></template>
      <label v-if="type==='限价'">委托价格<UiInput aria-label="演示委托价格" placeholder="输入价格" inputmode="decimal" /></label>
      <label>数量<div class="proto-input-row"><UiInput v-model="quantity" aria-label="演示委托数量" placeholder="填写数量以预览" type="number" min="0" step="any" /><UiSelect v-model="unit" aria-label="数量单位"><option>USDT</option><option>BTC</option><option>张</option></UiSelect></div></label>
      <div v-if="!before" class="proto-percentages"><button v-for="v in [25,50,75,100]" :key="v" type="button" @click="quantity=String(v*10)">{{ v }}%</button></div>
      <label v-if="before">操作理由<UiInput aria-label="原布局操作理由" placeholder="判断与执行理由" /></label>
      <label v-if="!before">估仓方式<UiSelect v-model="risk" aria-label="估仓方式"><option>保证金</option><option>风险预算</option><option>直接数量</option></UiSelect></label>
      <div class="proto-check"><label><input v-model="protection" type="checkbox" :disabled="disabled"> 自动止盈止损</label><span class="proto-chip">委托</span></div>
      <template v-if="protection || before"><label>止损价格<UiInput v-model="stop" aria-label="演示自动止损价" placeholder="输入触发价" /></label><label>止盈价格<UiInput v-model="profit" aria-label="演示自动止盈价" placeholder="输入触发价" /></label><label>触发依据<UiSelect v-model="reference" aria-label="保护触发依据"><option>最新价</option><option>标记价格</option></UiSelect></label><p class="proto-context">以{{ reference }}触发；切换图表价格不改变此设置。触发价不保证成交价。</p></template>
      <details v-if="!before"><summary>记录本次判断（可选）</summary><UiInput aria-label="本次判断" placeholder="用一句话留下理由" /></details>
      <div class="proto-order-preview"><span>可用 <b>10,000.00 USDT</b></span><span>{{ risk==='风险预算' ? '计划风险预算' : '预计保证金' }} <b>{{ quantity ? (Number(quantity)/5).toFixed(2) : '—' }}</b></span><small v-if="risk==='风险预算' && !stop">先填写自动止损，或设置手动退出计划。</small></div>
      <UiButton type="submit" block :disabled="!canSubmit || (risk==='风险预算' && !stop)" :variant="side.includes('做空') ? 'secondary' : 'primary'">{{ disabled ? '本局已结束' : `${operation === '平仓' ? '提交平仓' : side} · 演示` }}</UiButton>
      <small class="proto-caption">交互演示，不产生真实委托。</small>
    </form>
  </section>
</template>
