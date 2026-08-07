const PERIOD_META = {
  minute: {
    sourceKey: "sequence",
    label: "分钟",
  },
  day: {
    sourceKey: "sequence",
    label: "日",
  },
  week: {
    sourceKey: "weekIndex",
    label: "周",
  },
  month: {
    sourceKey: "monthIndex",
    label: "月",
  },
};

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function formatReplayBenchmarkLabel(benchmark = {}) {
  const name = String(benchmark.name ?? "").trim();
  const code = String(benchmark.code ?? "").trim();
  const identity = [name, code].filter(Boolean).join(" · ");
  const startDate = String(benchmark.startDate ?? "").trim();
  const endDate = String(benchmark.endDate ?? "").trim();
  return `${identity} · ${startDate} 至 ${endDate}`;
}

export function resolveReplayViewportAfterBarsChange({
  previousTotal,
  nextTotal,
  visibleStart,
  visibleCount,
}) {
  const safePreviousTotal = Math.max(Number(previousTotal) || 0, 0);
  const safeNextTotal = Math.max(Number(nextTotal) || 0, 0);
  if (!safeNextTotal) {
    return { visibleStart: 0, visibleCount: 1 };
  }
  if (!safePreviousTotal || Number(visibleCount) >= safePreviousTotal) {
    return { visibleStart: 0, visibleCount: safeNextTotal };
  }

  const nextVisibleCount = Math.min(
    Math.max(Number(visibleCount) || 1, 1),
    safeNextTotal,
  );
  const wasAtRightEdge =
    Number(visibleStart) + nextVisibleCount >= safePreviousTotal;
  const maxStart = Math.max(safeNextTotal - nextVisibleCount, 0);
  return {
    visibleStart: wasAtRightEdge
      ? maxStart
      : Math.min(Math.max(Number(visibleStart) || 0, 0), maxStart),
    visibleCount: nextVisibleCount,
  };
}

function createAggregateBar(bar, period, periodIndex) {
  const sequence = Number(bar.sequence);
  return {
    datetime:
      period === "day" && bar.tradeDate
        ? String(bar.tradeDate)
        : `第${["minute", "day"].includes(period) ? sequence : periodIndex}${PERIOD_META[period].label}`,
    period,
    periodIndex,
    startSequence: sequence,
    endSequence: sequence,
    open: toFiniteNumber(bar.open),
    high: toFiniteNumber(bar.high),
    low: toFiniteNumber(bar.low),
    close: toFiniteNumber(bar.close),
    volume: toFiniteNumber(bar.volume),
    amount: toFiniteNumber(bar.amount),
  };
}

export function aggregateReplayBars(bars, period = "day") {
  const safeBars = Array.isArray(bars) ? bars : [];
  const normalizedPeriod = PERIOD_META[period] ? period : "day";
  if (["minute", "day"].includes(normalizedPeriod)) {
    return safeBars.map((bar) =>
      createAggregateBar(bar, normalizedPeriod, Number(bar.sequence)),
    );
  }

  const sourceKey = PERIOD_META[normalizedPeriod].sourceKey;
  const result = [];
  let previousGroup = null;
  for (const bar of safeBars) {
    const group = bar[sourceKey];
    if (!result.length || group !== previousGroup) {
      result.push(
        createAggregateBar(bar, normalizedPeriod, result.length + 1),
      );
      previousGroup = group;
      continue;
    }
    const current = result.at(-1);
    current.endSequence = Number(bar.sequence);
    current.high = Math.max(current.high, toFiniteNumber(bar.high));
    current.low = Math.min(current.low, toFiniteNumber(bar.low));
    current.close = toFiniteNumber(bar.close);
    current.volume += toFiniteNumber(bar.volume);
    current.amount += toFiniteNumber(bar.amount);
  }
  return result;
}

export function mapReplayExecutionsToTrades(executions, bars, options = {}) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const observationBars = Number(options.observationBars);
  const barsPerDay = Math.floor(240 / Math.max(1, Number(options.stepMinutes) || 1));
  return (Array.isArray(executions) ? executions : [])
    .filter((execution) => execution?.status === "filled")
    .map((execution) => {
      const sourceSequence = Number(execution.sequence);
      const sequence = options.sessionInterval === "hybrid" &&
          Number.isFinite(observationBars) &&
          sourceSequence > observationBars
        ? observationBars + Math.floor(
            (sourceSequence - observationBars - 1) / barsPerDay,
          ) + 1
        : sourceSequence;
      const bar = safeBars.find(
        (item) =>
          sequence >= Number(item.startSequence) &&
          sequence <= Number(item.endSequence),
      );
      if (!bar) {
        return null;
      }
      return {
        id: execution.orderId,
        datetime: bar.datetime,
        direction: execution.side,
        price: Number(execution.price),
        quantity: Number(execution.quantity),
        sequence: sourceSequence,
      };
    })
    .filter(Boolean);
}
