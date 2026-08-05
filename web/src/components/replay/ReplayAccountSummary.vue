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
  grid-template-columns: minmax(260px, 1.1fr) minmax(0, 2.4fr);
  gap: 26px;
  padding: 22px 24px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 12px;
  background:
    linear-gradient(105deg, rgba(235, 242, 255, 0.76), transparent 34%),
    var(--ql-color-bg-surface-strong);
  box-shadow: var(--ql-shadow-xs);
}

.replay-account__primary {
  min-width: 0;
}

.replay-account__label {
  display: block;
  color: var(--ql-color-text-muted);
  font-size: 12px;
  font-weight: 650;
}

.replay-account__hero {
  display: block;
  margin-top: 4px;
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: clamp(28px, 3vw, 38px);
  font-weight: 700;
  letter-spacing: -0.055em;
}

.replay-account__hero small {
  margin-right: 3px;
  color: var(--ql-color-text-muted);
  font-size: 16px;
}

.replay-account__progress {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 7px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
}

.replay-account__status {
  padding: 3px 7px;
  border-radius: 999px;
  color: #0369a1;
  background: var(--ql-color-info-soft);
  font-weight: 700;
}

.replay-account__status--done {
  color: #047857;
  background: var(--ql-color-success-soft);
}

.replay-account__metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  align-items: center;
  margin: 0;
}

.replay-account__metric {
  min-width: 0;
  padding: 4px 16px;
  border-left: 1px solid var(--ql-line);
}

.replay-account__metric dt {
  color: var(--ql-color-text-muted);
  font-size: 11px;
}

.replay-account__metric dd {
  overflow: hidden;
  margin: 7px 0 0;
  font-family: "SF Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-account__metric dd span {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 500;
}

.replay-account__value--rise {
  color: var(--ql-rise);
}

.replay-account__value--fall {
  color: var(--ql-fall);
}

@media (max-width: 1280px) {
  .replay-account {
    grid-template-columns: 1fr;
  }

  .replay-account__metrics {
    border-top: 1px solid var(--ql-line);
    padding-top: 14px;
  }

  .replay-account__metric:first-child {
    border-left: 0;
  }
}

@media (max-width: 760px) {
  .replay-account__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 0;
  }

  .replay-account__metric:nth-child(odd) {
    border-left: 0;
  }
}
</style>
