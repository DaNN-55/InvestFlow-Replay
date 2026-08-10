<script setup>
import { ChevronDown, ChevronUp, Ellipsis, Pencil, Trash2 } from "lucide-vue-next";
import { reactive, shallowRef } from "vue";

import UiButton from "./ui/UiButton.vue";
import UiActionMenu from "./ui/UiActionMenu.vue";
import UiInput from "./ui/UiInput.vue";
import UiSelect from "./ui/UiSelect.vue";
import UiTextarea from "./ui/UiTextarea.vue";

defineProps({
  events: {
    type: Array,
    default: () => [],
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  saving: {
    type: Boolean,
    default: false,
  },
  ledger: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits(["add", "edit", "delete"]);
const collapsed = shallowRef(false);

const ACTION_OPTIONS = [
  { value: "buy", label: "买入" },
  { value: "add", label: "加仓" },
  { value: "reduce", label: "减仓" },
  { value: "sell", label: "卖出" },
  { value: "hold", label: "持有" },
  { value: "note", label: "备注" },
];

const form = reactive({
  eventAt: "",
  action: "buy",
  price: "",
  quantity: "",
  fee: "",
  planStatus: "unknown",
  source: "",
  note: "",
});

function resetForm() {
  form.eventAt = "";
  form.action = "buy";
  form.price = "";
  form.quantity = "";
  form.fee = "";
  form.planStatus = "unknown";
  form.source = "";
  form.note = "";
}

function submit() {
  if (!form.eventAt || !form.action) {
    return;
  }
  emit("add", {
    eventAt: form.eventAt,
    action: form.action,
    price: form.price === "" ? null : Number(form.price),
    quantity: form.quantity === "" ? null : Number(form.quantity),
    fee: form.fee === "" ? 0 : Number(form.fee),
    planStatus: form.planStatus,
    source: form.source.trim(),
    note: form.note.trim(),
  });
  resetForm();
}

function actionLabel(value) {
  return ACTION_OPTIONS.find((option) => option.value === value)?.label ?? value ?? "--";
}

function eventTone(action) {
  if (["buy", "add"].includes(action)) return "buy";
  if (["sell", "reduce"].includes(action)) return "sell";
  return "neutral";
}

function formatEvent(event) {
  const parts = [actionLabel(event?.action)];
  if (event?.price != null) {
    parts.push(`价 ${event.price}`);
  }
  if (event?.quantity != null) {
    parts.push(`${event.quantity} 股`);
  }
  if (Number(event?.fee) > 0) {
    parts.push(`费用 ${event.fee}`);
  }
  return parts.join(" · ");
}

function planStatusLabel(value) {
  return { planned: "计划内", unplanned: "计划外", unknown: "未标记" }[value] ?? "未标记";
}

function formatNumber(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  return parsed.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatSigned(value, suffix = "") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${formatNumber(parsed)}${suffix}`;
}
</script>

<template>
  <section class="trade-execution-events">
    <div class="trade-execution-events__heading">
      <div>
        <h3>成交与动作记录</h3>
        <p>买入、加仓、减仓、卖出可以记录多次，不再被一个买入价和一个卖出价限制。</p>
      </div>
      <button class="trade-execution-events__collapse" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        {{ events.length }} 条 <ChevronDown v-if="collapsed" :size="14" /><ChevronUp v-else :size="14" />
      </button>
    </div>

    <template v-if="!collapsed">
    <dl class="trade-execution-events__ledger">
      <div><dt>当前持仓</dt><dd>{{ formatNumber(ledger.positionQuantity, 0) }} 股</dd></div>
      <div><dt>持仓成本</dt><dd>{{ formatNumber(ledger.averageCost) }}</dd></div>
      <div><dt>已实现盈亏</dt><dd>{{ formatSigned(ledger.realizedPnl) }}</dd></div>
      <div><dt>浮动盈亏</dt><dd>{{ formatSigned(ledger.unrealizedPnl) }}</dd></div>
      <div><dt>总盈亏</dt><dd>{{ formatSigned(ledger.totalPnl) }}</dd></div>
      <div><dt>总收益率</dt><dd>{{ formatSigned(ledger.returnPct, '%') }}</dd></div>
      <div><dt>累计费用</dt><dd>{{ formatNumber(ledger.totalFees) }}</dd></div>
      <div><dt>计划外动作</dt><dd>{{ ledger.unplannedEventCount ?? 0 }} 次</dd></div>
    </dl>

    <div v-if="events.length" class="trade-execution-events__list">
      <article v-for="event in events" :key="event.id || `${event.eventAt}-${event.action}`" :class="`trade-execution-events__event--${eventTone(event.action)}`">
        <div class="trade-execution-events__event-row">
          <div class="trade-execution-events__event-main">
            <strong>{{ formatEvent(event) }}</strong>
            <small>{{ event.eventAt }} · {{ planStatusLabel(event.planStatus) }}<span v-if="event.source"> · {{ event.source }}</span></small>
          </div>
          <UiActionMenu
            class="trade-execution-events__event-actions"
            label="成交记录操作"
            :disabled="saving"
            :min-width="104"
            :trigger-size="24"
          >
            <template #trigger><Ellipsis :size="15" /></template>
            <button class="ui-action-menu__item" type="button" :disabled="saving" @click="emit('edit', event)"><Pencil :size="14" />修改</button>
            <button class="ui-action-menu__item ui-action-menu__item--danger" type="button" :disabled="saving" @click="emit('delete', event)"><Trash2 :size="14" />删除</button>
          </UiActionMenu>
        </div>
        <p v-if="event.note">{{ event.note }}</p>
      </article>
    </div>
    <p v-else class="trade-execution-events__empty">还没有动作记录。你可以先记录计划外观察，也可以在实际发生时逐笔补录。</p>

    <form class="trade-execution-events__form" @submit.prevent="submit">
      <label>
        <span>时间</span>
        <UiInput v-model="form.eventAt" size="sm" type="text" placeholder="如 2026-08-03 09:45" :disabled="disabled" />
      </label>
      <label>
        <span>动作</span>
        <UiSelect v-model="form.action" size="sm" :disabled="disabled">
          <option v-for="option in ACTION_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </UiSelect>
      </label>
      <label>
        <span>价格</span>
        <UiInput v-model="form.price" size="sm" type="number" min="0" step="0.01" :disabled="disabled" />
      </label>
      <label>
        <span>数量</span>
        <UiInput v-model="form.quantity" size="sm" type="number" min="0" step="100" :disabled="disabled" />
      </label>
      <label>
        <span>费用</span>
        <UiInput v-model="form.fee" size="sm" type="number" min="0" step="0.01" :disabled="disabled" />
      </label>
      <label>
        <span>是否按计划</span>
        <UiSelect v-model="form.planStatus" size="sm" :disabled="disabled">
          <option value="unknown">未标记</option>
          <option value="planned">计划内</option>
          <option value="unplanned">计划外</option>
        </UiSelect>
      </label>
      <label>
        <span>来源</span>
        <UiInput v-model="form.source" size="sm" type="text" placeholder="盘中 / 复盘 / 外部记录" :disabled="disabled" />
      </label>
      <label class="trade-execution-events__note">
        <span>备注</span>
        <UiTextarea v-model="form.note" :disabled="disabled" placeholder="为什么做这个动作，或当时观察到什么" />
      </label>
      <UiButton type="submit" size="sm" variant="secondary" :loading="saving" :disabled="disabled || !form.eventAt">
        添加动作
      </UiButton>
    </form>
    </template>
  </section>
</template>

<style scoped>
.trade-execution-events {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--ql-color-border-soft);
  border-radius: var(--ql-radius-card);
  background: var(--ql-color-bg-muted);
}

.trade-execution-events__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.trade-execution-events__heading h3 {
  margin: 0;
  color: var(--ql-color-text-strong);
  font-size: 13px;
}

.trade-execution-events__heading p,
.trade-execution-events__empty,
.trade-execution-events__event-main small,
.trade-execution-events__list article p {
  margin: 4px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.trade-execution-events__heading > span {
  flex: 0 0 auto;
  color: var(--ql-color-text-muted);
  font-size: 11px;
}

.trade-execution-events__collapse { display: flex; align-items: center; gap: 4px; border: 0; color: var(--ql-color-text-muted); background: transparent; cursor: pointer; font-size: 11px; }

.trade-execution-events__list {
  display: grid;
  gap: 6px;
  max-height: 280px;
  overflow: auto;
}

.trade-execution-events__ledger {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ql-color-border-soft);
  background: var(--ql-color-border-soft);
}

.trade-execution-events__ledger > div {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  background: var(--ql-color-bg-surface-strong);
}

.trade-execution-events__ledger dt {
  color: var(--ql-color-text-muted);
  font-size: 10px;
}

.trade-execution-events__ledger dd {
  margin: 0;
  color: var(--ql-color-text-strong);
  font-size: 12px;
  font-weight: 700;
}

.trade-execution-events__list article {
  padding: 9px 10px;
  border: 1px solid var(--ql-color-border-soft);
  background: var(--ql-color-bg-surface-strong);
}

.trade-execution-events__event--buy { border-left: 3px solid var(--ql-rise) !important; background: color-mix(in srgb, var(--ql-rise) 5%, var(--ql-color-bg-surface-strong)) !important; }
.trade-execution-events__event--sell { border-left: 3px solid var(--ql-fall) !important; background: color-mix(in srgb, var(--ql-fall) 5%, var(--ql-color-bg-surface-strong)) !important; }
.trade-execution-events__event--buy .trade-execution-events__event-main strong { color: var(--ql-rise); }
.trade-execution-events__event--sell .trade-execution-events__event-main strong { color: var(--ql-fall); }

.trade-execution-events__event-main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.trade-execution-events__event-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.trade-execution-events__event-main strong {
  color: var(--ql-color-text-strong);
  font-size: 12px;
}

.trade-execution-events__event-main small {
  flex: 0 0 auto;
  margin: 0;
  font-family: var(--ql-font-mono, monospace);
  font-size: 10px;
}

.trade-execution-events__event-actions {
  flex: 0 0 auto;
}

.trade-execution-events__list article p {
  margin-bottom: 0;
  white-space: pre-wrap;
}

.trade-execution-events__form {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  align-items: end;
}

.trade-execution-events__form label {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.trade-execution-events__form label > span {
  color: var(--ql-color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.trade-execution-events__note {
  grid-column: 1 / -1;
}

.trade-execution-events__form > .ql-ui-button {
  min-height: 40px;
  grid-column: 1 / -1;
  justify-self: end;
}

@media (max-width: 900px) {
  .trade-execution-events__ledger {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .trade-execution-events__form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .trade-execution-events__note {
    grid-column: 1 / -1;
  }
}

@media (max-width: 560px) {
  .trade-execution-events__ledger {
    grid-template-columns: 1fr;
  }
  .trade-execution-events__form {
    grid-template-columns: 1fr;
  }
}
</style>
