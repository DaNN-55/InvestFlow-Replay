import { computed, shallowRef, toValue, watch } from "vue";

import {
  aggregateReplayBars,
  mapReplayExecutionsToTrades,
} from "../utils/replayMarket.js";

function formatPrice(value) {
  return Number(value ?? 0).toFixed(2);
}

function formatAmount(value) {
  const amount = Number(value ?? 0);
  if (amount >= 100000000) {
    return `${(amount / 100000000).toFixed(2)} 亿`;
  }
  if (amount >= 10000) {
    return `${(amount / 10000).toFixed(2)} 万`;
  }
  return amount.toFixed(0);
}

function defaultPeriod(interval) {
  return interval === "1m" ? "minute" : "day";
}

export function useReplayChartPresentation({
  bars,
  executions,
  sessionInterval,
  observationBars,
  stepMinutes,
}) {
  const period = shallowRef(defaultPeriod(toValue(sessionInterval)));
  const indicators = shallowRef({
    builtins: { main: ["MA"], panes: ["MACD", "RSI"] },
    custom: [],
  });

  watch(sessionInterval, (interval) => {
    period.value = defaultPeriod(interval);
  });

  const periodOptions = computed(() =>
    toValue(sessionInterval) === "1m"
      ? [{ value: "minute", label: "分" }]
      : [
          { value: "day", label: "日" },
          { value: "week", label: "周" },
          { value: "month", label: "月" },
        ],
  );
  const chartBars = computed(() =>
    aggregateReplayBars(toValue(bars) ?? [], period.value),
  );
  const chartTrades = computed(() =>
    mapReplayExecutionsToTrades(
      toValue(executions) ?? [],
      chartBars.value,
      {
        sessionInterval: toValue(sessionInterval),
        observationBars: toValue(observationBars),
        stepMinutes: toValue(stepMinutes),
      },
    ),
  );
  const latestQuote = computed(() => {
    const latest = (toValue(bars) ?? []).at(-1);
    if (!latest) {
      return null;
    }
    return {
      label: latest.displayLabel,
      open: formatPrice(latest.open),
      high: formatPrice(latest.high),
      low: formatPrice(latest.low),
      close: formatPrice(latest.close),
      amount: formatAmount(latest.amount),
    };
  });
  const chart = computed(() => ({
    key: `${period.value}-chart`,
    bars: chartBars.value,
    trades: chartTrades.value,
    indicators: indicators.value,
  }));

  function selectPeriod(nextPeriod) {
    if (periodOptions.value.some((option) => option.value === nextPeriod)) {
      period.value = nextPeriod;
    }
  }

  function setIndicators(nextIndicators) {
    indicators.value = nextIndicators;
  }

  return {
    period,
    periodOptions,
    latestQuote,
    chart,
    selectPeriod,
    setIndicators,
  };
}
