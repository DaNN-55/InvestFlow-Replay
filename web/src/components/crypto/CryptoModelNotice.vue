<script setup>
defineProps({ location: { type: String, required: true } });
</script>
<template>
  <div class="crypto-model-notice" :data-model-notice="location">
    <strong>保守教学结算</strong>
    <span>触发接管后全仓关闭，该仓保证金不返还；实盘可能部分减仓或返还余额。</span>
    <p v-if="location === 'risk'">追加保证金也承担接管损失；仓外资金不自动补入。估算强平价是风险阈值，不是保证成交价。</p>
    <p v-else-if="location === 'settlement'">费用已含在合计损失中，不重复扣。mark 与手续费仅作参考；实际清算成交价和官方清算费未知。</p>
    <p v-else-if="location === 'review'">教学模拟结果，非 OKX 实盘清算账单。净收益包含本模型接管结算；不向仓外追扣为教学约定，不是实盘赔付承诺，豁免不算交易盈利。</p>
    <p v-else>固定训练费率；分钟撮合与容量为教学近似，不重建盘口、排队和 ADL。恢复与复练沿用冻结版本。</p>
  </div>
</template>
<style scoped>
.crypto-model-notice { padding: 12px 14px; border-left: 3px solid var(--ql-accent); background: var(--ql-color-primary-soft); font-size: 12px; line-height: 1.7; color: var(--ql-ink); }
strong { margin-right: 10px; font-weight: 700; }
p { margin: 4px 0 0; color: inherit; }
</style>
