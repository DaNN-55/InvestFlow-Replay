<script setup>
import { computed } from "vue";

const props = defineProps({
  session: {
    type: Object,
    required: true,
  },
});

const account = computed(() => props.session.account ?? {});
const valuation = computed(() => props.session.valuation ?? {});
const totalPnl = computed(() => Number(valuation.value.totalPnl ?? 0));
const statusLabel = computed(() => {
  if (props.session.status !== "completed") {
    return "演练中";
  }
  if (props.session.completionReason === "early") return "提前交卷";
  if (props.session.completionReason === "no_opportunity") return "无交易机会";
  return "自然完成";
});
const pnlClass = computed(() => ({
  "replay-account__value--rise": totalPnl.value > 0,
  "replay-account__value--fall": totalPnl.value < 0,
}));
const progressUnit = computed(() =>
  props.session.interval === "1m" ? "分钟" : "日",
);

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

function formatShares(value) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}
</script>

<template>
  <section class="replay-account" aria-label="虚拟账户摘要">
    <div class="replay-account__primary">
      <span class="replay-account__label">账户总资产</span>
      <strong class="replay-account__hero">
        <small>¥</small>{{ formatMoney(valuation.totalEquity) }}
      </strong>
      <div class="replay-account__progress">
        <span
          class="replay-account__status"
          :class="{ 'replay-account__status--done': session.status === 'completed' }"
        >
          {{ statusLabel }}
        </span>
        <span>
          已推进 {{ session.revealedFutureBars }} / {{ session.gameLength }} {{ progressUnit }}
        </span>
      </div>
    </div>

    <dl class="replay-account__metrics">
      <div class="replay-account__metric">
        <dt>可用现金</dt>
        <dd>¥{{ formatMoney(account.cash) }}</dd>
      </div>
      <div class="replay-account__metric">
        <dt>持仓市值</dt>
        <dd>¥{{ formatMoney(valuation.marketValue) }}</dd>
      </div>
      <div class="replay-account__metric">
        <dt>累计盈亏</dt>
        <dd :class="pnlClass">
          {{ totalPnl > 0 ? "+" : "" }}¥{{ formatMoney(totalPnl) }}
        </dd>
      </div>
      <div class="replay-account__metric">
        <dt>持仓 / 可卖</dt>
        <dd>
          {{ formatShares(account.positionQuantity) }}
          <span>/ {{ formatShares(account.availableQuantity) }} 股</span>
        </dd>
      </div>
      <div class="replay-account__metric">
        <dt>T+1 锁定</dt>
        <dd>{{ formatShares(account.lockedQuantity) }} 股</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.replay-account {
  display: grid;
  grid-template-columns: minmax(200px, 1.1fr) minmax(0, 4fr);
  align-items: center;
  gap: 20px;
  padding: 14px 18px;
  border-block: 1px solid var(--ql-line-strong);
  font-variant-numeric: tabular-nums;
}
.replay-account__primary { min-width: 0; }
.replay-account__label { color: var(--ql-color-text-muted); font-size: 12px; }
.replay-account__hero { display: block; margin-top: 3px; font-size: 23px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
.replay-account__hero small { margin-right: 3px; font-size: 14px; font-weight: 400; }
.replay-account__progress { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; color: var(--ql-color-text-muted); font-size: 11px; }
.replay-account__status { color: var(--ql-color-info); }
.replay-account__status--done { color: color-mix(in srgb, var(--ql-color-success) 45%, var(--ql-ink)); }
.replay-account__metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: start; gap: 12px; margin: 0; }
.replay-account__metric { min-width: 0; }
.replay-account__metric dt { color: var(--ql-color-text-muted); font-size: 12px; }
.replay-account__metric dd { margin: 6px 0 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.replay-account__metric dd span { color: var(--ql-color-text-muted); font-size: 12px; font-weight: 400; }
.replay-account__value--rise { color: var(--ql-rise); }
.replay-account__value--fall { color: var(--ql-fall); }
@media (max-width: 1100px) {
  .replay-account { grid-template-columns: 1fr; gap: 12px; }
  .replay-account__primary { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; }
  .replay-account__hero { margin: 0; }
  .replay-account__progress { margin: 0 0 0 auto; }
}
@media (max-width: 600px) {
  .replay-account { padding: 12px 0; }
  .replay-account__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .replay-account__progress { flex-basis: 100%; margin: 0; }
  .replay-account__metric dd { margin-top: 3px; }
}
</style>
