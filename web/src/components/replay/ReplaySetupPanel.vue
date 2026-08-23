<script setup>
import {
  ChevronDown,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-vue-next";
import { computed, reactive, watch } from "vue";

import UiButton from "../ui/UiButton.vue";
import UiCard from "../ui/UiCard.vue";
import UiInput from "../ui/UiInput.vue";
import { formatReplayBenchmarkLabel } from "../../utils/replayMarket.js";
import ReplayPortfolioJourney from "./ReplayPortfolioJourney.vue";

const props = defineProps({
  loading: {
    type: Boolean,
    default: false,
  },
  benchmarks: {
    type: Array,
    default: () => [],
  },
  benchmarksLoading: {
    type: Boolean,
    default: false,
  },
  benchmarksError: {
    type: String,
    default: "",
  },
  benchmarkInitialization: {
    type: Object,
    default: null,
  },
  marketProvider: {
    type: String,
    default: "tdx",
  },
});

const emit = defineEmits([
  "create",
  "retryBenchmarks",
]);

const form = reactive({
  barInterval: "1d",
  benchmarkCode: "",
  gameLength: 60,
  initialCapital: 100000,
  costConfig: {
    commissionRate: 0.0003,
    minCommission: 5,
    stampTaxRate: 0.0005,
    transferFeeRate: 0.00001,
    slippageBps: 5,
  },
});
const lengthOptions = computed(() =>
  form.barInterval === "hybrid"
    ? [20, 60, 120]
    : [20, 60, 120],
);
const isFixtureMarket = computed(() => props.marketProvider === "fixture");
const compatibleBenchmarks = computed(() =>
  props.benchmarks.filter((benchmark) =>
    form.barInterval === "hybrid" ||
    (benchmark.supportedGameLengths ?? [])
      .map(Number)
      .includes(Number(form.gameLength)),
  ),
);
const selectedBenchmark = computed(
  () =>
    compatibleBenchmarks.value.find(
      (benchmark) => benchmark.code === form.benchmarkCode,
    ) ?? null,
);
const canSubmit = computed(
  () =>
    lengthOptions.value.includes(Number(form.gameLength)) &&
    Number(form.initialCapital) > 0 &&
    (!props.benchmarksLoading || compatibleBenchmarks.value.length > 0) &&
    Boolean(selectedBenchmark.value),
);
const benchmarkProgressText = computed(() => {
  const status = props.benchmarkInitialization;
  if (!status || status.state !== "running") {
    return "正在读取本地指数缓存…";
  }
  const completed = Math.max(Number(status.completed) || 0, 0);
  const total = Math.max(Number(status.total) || 0, completed);
  const countText = total > 0 ? `（${completed}/${total}）` : "";
  const phase = status.ready
    ? "演练数据已就绪，正在补齐完整历史"
    : "首次初始化通达信行情缓存";
  return `${phase}${countText}：${status.message || "正在连接通达信"}`;
});

watch(
  isFixtureMarket,
  (fixture) => {
    if (fixture && form.barInterval !== "1d") {
      form.barInterval = "1d";
    }
  },
  { immediate: true },
);

watch(
  () => form.barInterval,
  (interval) => {
    form.gameLength = interval === "hybrid" ? 20 : 60;
  },
);

watch(
  compatibleBenchmarks,
  (items) => {
    if (
      !items.some((benchmark) => benchmark.code === form.benchmarkCode)
    ) {
      form.benchmarkCode = items[0]?.code ?? "";
    }
  },
  { immediate: true },
);

function submit() {
  if (!canSubmit.value || props.loading) {
    return;
  }
  const payload = {
    interval: form.barInterval,
    gameLength: Number(form.gameLength),
    benchmarkCode: selectedBenchmark.value.code,
    initialCapital: Number(form.initialCapital),
    costConfig: Object.fromEntries(
      Object.entries(form.costConfig).map(([key, value]) => [
        key,
        Number(value),
      ]),
    ),
    trainingMode: "free",
  };
  emit("create", payload);
}
</script>

<template>
  <div class="replay-setup">
    <div class="replay-setup__hero">
      <div class="replay-setup__intro">
        <span class="replay-setup__eyebrow">
          <ShieldCheck :size="15" />
          严格盲测
        </span>
        <h1 class="replay-setup__title">用未知行情验证一条交易规则</h1>
        <p class="replay-setup__description">
          {{ isFixtureMarket
            ? "从研究假设出发，在确定性的离线合成 K 线上完成演练、模拟执行与复盘。"
            : "从研究假设出发，在随机匿名历史行情中完成演练、模拟执行与复盘。" }}
        </p>
        <p v-if="isFixtureMarket" class="replay-setup__fixture-note" role="status">
          离线合成数据 · 不对应真实证券，也不代表真实市场
        </p>
      </div>

      <UiCard class="replay-setup__card" overflow-visible>
        <form class="replay-setup__form" @submit.prevent="submit">
          <div class="replay-setup__choice-heading">
            <span class="replay-setup__eyebrow">推荐开局</span>
            <h2>这次怎么练？</h2>
            <p>先选好演练边界，再进入未知行情。</p>
          </div>

          <fieldset class="replay-setup__choice-card">
            <legend class="replay-setup__choice-label">01 · 行情精度</legend>
            <div class="replay-setup__intervals">
              <button
                type="button"
                class="replay-setup__interval"
                :class="{ 'replay-setup__interval--active': form.barInterval === '1d' }"
                :aria-pressed="form.barInterval === '1d'"
                @click="form.barInterval = '1d'"
              >
                <strong>日线演练</strong>
                <small>按收盘决策、次日开盘执行</small>
              </button>
              <button
                v-if="!isFixtureMarket"
                type="button"
                class="replay-setup__interval"
                :class="{ 'replay-setup__interval--active': form.barInterval === 'hybrid' }"
                :aria-pressed="form.barInterval === 'hybrid'"
                @click="form.barInterval = 'hybrid'"
              >
                <strong>日内模拟</strong>
                <small>逐 5 分钟观察当天走势与成交</small>
              </button>
            </div>
          </fieldset>

          <fieldset class="replay-setup__choice-card">
            <legend class="replay-setup__choice-label">02 · 演练长度</legend>
            <div class="replay-setup__lengths">
              <button
                v-for="length in lengthOptions"
                :key="length"
                type="button"
                class="replay-setup__length"
                :class="{ 'replay-setup__length--active': form.gameLength === length }"
                :aria-pressed="form.gameLength === length"
                @click="form.gameLength = length"
              >
                <strong>{{ length }}</strong>
                <span>交易日</span>
              </button>
            </div>
          </fieldset>

          <section class="replay-setup__choice-card replay-setup__benchmark" aria-label="指数基准设置">
            <label class="replay-setup__field">
              <span class="replay-setup__choice-label">03 · 指数基准</span>
              <select
                v-model="form.benchmarkCode"
                class="replay-setup__select"
                :disabled="compatibleBenchmarks.length === 0"
              >
                <option value="">
                  {{ isFixtureMarket ? "请选择 Demo 合成基准" : "请选择真实指数基准" }}
                </option>
                <option
                  v-for="benchmark in compatibleBenchmarks"
                  :key="benchmark.code"
                  :value="benchmark.code"
                >
                  {{ formatReplayBenchmarkLabel(benchmark) }}
                </option>
              </select>
            </label>
            <div
              v-if="benchmarksLoading || benchmarkInitialization?.state === 'running'"
              class="replay-setup__playbook-state"
            >
              <RefreshCw :size="14" class="replay-setup__spinner" />
              {{ benchmarkProgressText }}
            </div>
            <div
              v-else-if="benchmarksError"
              class="replay-setup__playbook-state replay-setup__playbook-state--error"
            >
              <span>{{ benchmarksError }}</span>
              <button type="button" @click="emit('retryBenchmarks')">重新加载</button>
            </div>
            <div v-else-if="compatibleBenchmarks.length === 0" class="replay-setup__playbook-state">
              当前没有支持该演练模式的{{ isFixtureMarket ? "合成" : "真实" }}指数基准。
            </div>
            <small v-else class="replay-setup__benchmark-note">
              {{ isFixtureMarket
                ? "合成指数与合成标的按同一固定日历对齐，仅用于演示结算流程。"
                : "指数与抽中的股票会按同一时间对齐，用于结算真实超额收益。" }}
            </small>
          </section>

          <UiButton
            type="submit"
            block
            class="replay-setup__submit"
            :loading="loading"
            :disabled="!canSubmit"
          >
            <template #prefix>
              <Play :size="16" />
            </template>
            开始{{ form.barInterval === "hybrid" ? "日内模拟" : "日线盲测" }}
          </UiButton>
          <p class="replay-setup__submit-note">
            开局会固定账户与成本配置，上一局持仓不会带入。
          </p>

          <details class="replay-setup__configuration" :open="Boolean(benchmarksError)">
            <summary class="replay-setup__configuration-trigger">
              <span>调整资金与成本</span>
              <ChevronDown :size="16" />
            </summary>
            <div class="replay-setup__configuration-body">
              <label class="replay-setup__field">
                <span class="replay-setup__label">初始资金</span>
                <span class="replay-setup__input-wrap">
                  <span class="replay-setup__currency">¥</span>
                  <UiInput
                    v-model="form.initialCapital"
                    type="number"
                    min="10000"
                    step="10000"
                    inputmode="decimal"
                  />
                </span>
              </label>

              <details class="replay-setup__advanced">
                <summary class="replay-setup__advanced-trigger">
                  <span>高级成本设置</span>
                  <ChevronDown :size="16" />
                </summary>
                <div class="replay-setup__cost-grid">
                  <label class="replay-setup__field">
                    <span class="replay-setup__label">佣金率</span>
                    <UiInput v-model="form.costConfig.commissionRate" type="number" min="0" max="0.999999" step="0.0001" />
                  </label>
                  <label class="replay-setup__field">
                    <span class="replay-setup__label">最低佣金</span>
                    <UiInput v-model="form.costConfig.minCommission" type="number" min="0" step="1" />
                  </label>
                  <label class="replay-setup__field">
                    <span class="replay-setup__label">卖出印花税率</span>
                    <UiInput v-model="form.costConfig.stampTaxRate" type="number" min="0" max="0.999999" step="0.0001" />
                  </label>
                  <label class="replay-setup__field">
                    <span class="replay-setup__label">双向过户费率</span>
                    <UiInput v-model="form.costConfig.transferFeeRate" type="number" min="0" max="0.999999" step="0.00001" />
                  </label>
                  <label class="replay-setup__field">
                    <span class="replay-setup__label">滑点（bps）</span>
                    <UiInput v-model="form.costConfig.slippageBps" type="number" min="0" max="9999" step="1" />
                  </label>
                </div>
              </details>
            </div>
          </details>
        </form>
      </UiCard>
    </div>

    <ReplayPortfolioJourney :market-provider="marketProvider" />
  </div>
</template>

<style scoped>
.replay-setup {
  width: min(1040px, 100%);
  margin: 0 auto;
}

.replay-setup__hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 430px);
  align-items: center;
  gap: clamp(32px, 6vw, 76px);
  min-height: min(620px, calc(100dvh - 92px));
}

.replay-setup__intro {
  max-width: 540px;
}

.replay-setup__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  color: var(--ql-accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.replay-setup__title {
  margin: 0;
  font-size: clamp(34px, 4.4vw, 52px);
  line-height: 1.04;
  letter-spacing: -0.055em;
}

.replay-setup__description {
  max-width: 480px;
  margin: 16px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 15px;
  line-height: 1.8;
}

.replay-setup__fixture-note {
  display: inline-flex;
  margin: 12px 0 0;
  padding: 5px 9px;
  border: 1px solid var(--ql-color-warning);
  border-radius: 7px;
  color: var(--ql-color-warning);
  font-size: 12px;
  font-weight: 650;
}

.replay-setup__card {
  border-color: var(--ql-color-border-soft);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--ql-ink) 9%, transparent);
}

.replay-setup__form {
  display: grid;
  gap: 14px;
}

.replay-setup__choice-heading h2 {
  margin: 0;
  color: var(--ql-ink);
  font-size: 24px;
  letter-spacing: -0.035em;
}

.replay-setup__choice-heading p,
.replay-setup__submit-note {
  margin: 5px 0 0;
  color: var(--ql-color-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.replay-setup__choice-card {
  min-width: 0;
  margin: 0;
  padding: 13px;
  border: 1px solid var(--ql-line);
  border-radius: 11px;
  background: var(--ql-paper-soft);
}

.replay-setup__choice-label,
.replay-setup__label {
  display: block;
  margin-bottom: 9px;
  color: var(--ql-color-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.replay-setup__intervals,
.replay-setup__lengths {
  display: grid;
  gap: 9px;
}

.replay-setup__intervals {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.replay-setup__lengths {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.replay-setup__interval,
.replay-setup__length {
  min-width: 0;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-color-text-muted);
  background: var(--ql-color-bg-surface-strong);
  cursor: pointer;
}

.replay-setup__interval {
  display: grid;
  gap: 4px;
  min-height: 72px;
  padding: 10px;
  text-align: left;
}

.replay-setup__interval strong {
  color: var(--ql-ink);
  font-size: 13px;
}

.replay-setup__interval small {
  font-size: 10px;
  line-height: 1.45;
}

.replay-setup__length {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.replay-setup__length strong {
  color: var(--ql-ink);
  font-family: var(--ql-font-mono, monospace);
  font-size: 20px;
}

.replay-setup__length span {
  font-size: 10px;
}

.replay-setup__interval--active,
.replay-setup__length--active {
  border-color: var(--ql-accent);
  color: var(--ql-accent);
  background: var(--ql-color-primary-soft);
  box-shadow: 0 0 0 3px var(--ql-color-primary-ring);
}

.replay-setup__benchmark {
  display: grid;
  gap: 9px;
}

.replay-setup__select {
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--ql-line-strong);
  border-radius: 8px;
  color: var(--ql-ink);
  background: var(--ql-color-bg-surface-strong);
  font: inherit;
  font-size: 12px;
}

.replay-setup__benchmark-note,
.replay-setup__playbook-state {
  color: var(--ql-color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.replay-setup__playbook-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.replay-setup__playbook-state--error {
  color: #b91c1c;
}

.replay-setup__playbook-state button {
  flex: 0 0 auto;
  border: 0;
  color: var(--ql-accent);
  background: transparent;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.replay-setup__spinner {
  flex: 0 0 auto;
  animation: replay-setup-spin 0.9s linear infinite;
}

.replay-setup__submit {
  min-height: 48px;
  border-color: var(--ql-color-primary);
  color: #fff;
  background: var(--ql-color-primary);
}

.replay-setup__submit:hover,
.replay-setup__submit:focus-visible {
  border-color: var(--ql-color-primary-strong);
  background: var(--ql-color-primary-strong);
}

.replay-setup__submit-note {
  margin-top: -6px;
  text-align: center;
}

.replay-setup__configuration {
  border-top: 1px solid var(--ql-line);
}

.replay-setup__configuration-trigger,
.replay-setup__advanced-trigger {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  color: var(--ql-color-text-body);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  list-style: none;
}

.replay-setup__configuration[open] .replay-setup__configuration-trigger svg,
.replay-setup__advanced[open] .replay-setup__advanced-trigger svg {
  transform: rotate(180deg);
}

.replay-setup__configuration-body {
  display: grid;
  gap: 12px;
  padding: 1px 0 16px;
}

.replay-setup__input-wrap {
  position: relative;
  display: block;
}

.replay-setup__currency {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 14px;
  color: var(--ql-color-text-muted);
  transform: translateY(-50%);
}

.replay-setup__input-wrap :deep(input) {
  padding-left: 32px;
  font-family: var(--ql-font-mono, monospace);
  font-size: 17px;
  font-weight: 650;
}

.replay-setup__advanced {
  border-top: 1px solid var(--ql-line);
  border-bottom: 1px solid var(--ql-line);
}

.replay-setup__advanced-trigger {
  min-height: 40px;
}

.replay-setup__cost-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 2px 0 15px;
}

@media (max-width: 780px) {
  .replay-setup__hero {
    grid-template-columns: 1fr;
    gap: 26px;
    min-height: auto;
    padding: 20px 0 34px;
  }

  .replay-setup__intro {
    max-width: 620px;
  }

  .replay-setup__card {
    width: min(100%, 500px);
    justify-self: center;
  }
}

@media (max-width: 480px) {
  .replay-setup__title {
    font-size: 34px;
  }

  .replay-setup__intervals,
  .replay-setup__cost-grid {
    grid-template-columns: 1fr;
  }
}

@keyframes replay-setup-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
