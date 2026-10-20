const METRIC_KEYS = [
  "totalReturnPct",
  "maxDrawdownPct",
  "totalTradingCosts",
  "averageCapitalUtilizationPct",
  "maxCapitalUtilizationPct",
  "buyFillCount",
  "sellFillCount",
];

function numberOrNull(value) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

function roundMetric(value) {
  return Number(Number(value).toFixed(4));
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function actualCompletionSteps(session) {
  const observationBars = Number(session.observationBars ?? 0);
  const completed = Number(session.revealedFutureBars ?? 0);
  const total = Number(session.gameLength ?? 0);
  return Math.max(0, Math.min(total, completed)) + observationBars;
}

export function calculateObjectiveMetrics(session) {
  const bars = Array.isArray(session.snapshot?.bars) ? session.snapshot.bars : [];
  const observationBars = Number(session.observationBars ?? 0);
  const completionSequence = actualCompletionSteps(session);
  const initialCapital = Number(session.account?.initialCapital ?? 0);
  const fills = (session.executions ?? []).filter((execution) => execution.status === "filled");
  const fillsBySequence = new Map();
  for (const fill of fills) {
    const sequence = Number(fill.sequence);
    if (!Number.isFinite(sequence)) continue;
    const items = fillsBySequence.get(sequence) ?? [];
    items.push(fill);
    fillsBySequence.set(sequence, items);
  }
  let cash = initialCapital;
  let position = 0;
  const equityCurve = [initialCapital];
  const utilization = [];
  for (let sequence = observationBars + 1; sequence <= completionSequence; sequence += 1) {
    for (const fill of fillsBySequence.get(sequence) ?? []) {
      const quantity = Number(fill.quantity ?? 0);
      const notional = Number(fill.notional ?? 0);
      const fee = Number(fill.totalFee ?? 0);
      if (fill.side === "buy") {
        cash -= notional + fee;
        position += quantity;
      } else if (fill.side === "sell") {
        cash += notional - fee;
        position -= quantity;
      }
    }
    const close = Number(bars[sequence - 1]?.close ?? 0);
    const marketValue = position * close;
    const equity = cash + marketValue;
    equityCurve.push(equity);
    utilization.push(equity > 0 ? (marketValue / equity) * 100 : 0);
  }
  const finalEquity = equityCurve.at(-1) ?? initialCapital;
  let peak = equityCurve[0] ?? initialCapital;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }
  const frozen = session.review?.scoreCard?.metrics;
  const metric = (key, fallback) => numberOrNull(frozen?.[key]) ?? roundMetric(fallback);
  return {
    totalReturnPct: metric("totalReturnPct", initialCapital > 0 ? ((finalEquity / initialCapital) - 1) * 100 : 0),
    maxDrawdownPct: metric("maxDrawdownPct", maxDrawdown),
    totalTradingCosts: metric("totalTradingCosts", fills.reduce((sum, fill) => sum + Number(fill.totalFee ?? 0), 0)),
    averageCapitalUtilizationPct: metric("averageCapitalUtilizationPct", utilization.length ? utilization.reduce((sum, value) => sum + value, 0) / utilization.length : 0),
    maxCapitalUtilizationPct: metric("maxCapitalUtilizationPct", utilization.length ? Math.max(...utilization) : 0),
    buyFillCount: fills.filter((fill) => fill.side === "buy").length,
    sellFillCount: fills.filter((fill) => fill.side === "sell").length,
  };
}

function conditionsFor(session) {
  return {
    initialCapital: Number(session.account?.initialCapital ?? 0),
    costConfig: session.costConfig ?? {},
    executionModelVersion: session.executionModelVersion ?? null,
    scoringAlgorithmVersion: session.scoringConfig?.algorithmVersion ?? null,
    completedSteps: actualCompletionSteps(session) - Number(session.observationBars ?? 0),
    totalSteps: Number(session.gameLength ?? 0),
  };
}

function publicExecution(session, execution) {
  const sequence = Number(execution.sequence);
  const bar = Array.isArray(session.snapshot?.bars) ? session.snapshot.bars[sequence - 1] : null;
  return {
    orderId: execution.orderId,
    executionId: execution.executionId ?? execution.orderId,
    step: Number.isFinite(sequence) ? sequence - Number(session.observationBars ?? 0) : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
    tradeDate: bar?.tradeDate ?? null,
    tradeTime: bar?.tradeTime ?? null,
    side: execution.side ?? null,
    orderType: execution.orderType ?? null,
    quantity: execution.quantity == null ? null : Number(execution.quantity),
    price: execution.price == null ? null : Number(execution.price),
    fee: execution.totalFee == null ? null : Number(execution.totalFee),
    totalFee: execution.totalFee == null ? null : Number(execution.totalFee),
    decision: execution.decision ?? null,
    status: execution.status ?? null,
    reasonCode: execution.reasonCode ?? null,
    reasonMessage: execution.reasonMessage ?? null,
  };
}

function reasonsBetween(first, current) {
  const firstConditions = conditionsFor(first);
  const currentConditions = conditionsFor(current);
  const reasons = [];
  if (firstConditions.initialCapital !== currentConditions.initialCapital) reasons.push("初始资金不同");
  if (!sameJson(firstConditions.costConfig, currentConditions.costConfig)) reasons.push("费用设置不同");
  if (firstConditions.executionModelVersion !== currentConditions.executionModelVersion) reasons.push("成交规则不同");
  if (firstConditions.scoringAlgorithmVersion !== currentConditions.scoringAlgorithmVersion) reasons.push("评分规则不同");
  if (!sameJson(first.scoringConfig, current.scoringConfig) && !reasons.includes("评分规则不同")) reasons.push("评分规则不同");
  const firstScoreVersion = first.review?.scoreCard?.algorithmVersion;
  const currentScoreVersion = current.review?.scoreCard?.algorithmVersion;
  if (first.review?.scoreCard && current.review?.scoreCard && (firstScoreVersion ?? null) !== (currentScoreVersion ?? null) && !reasons.includes("评分规则不同")) reasons.push("评分规则不同");
  if (firstConditions.completedSteps !== currentConditions.completedSteps || firstConditions.totalSteps !== currentConditions.totalSteps) reasons.push("结束进度不同");
  return reasons;
}

function buildDelta(firstMetrics, metrics, comparable) {
  if (!comparable) return null;
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, roundMetric(Number(metrics[key] ?? 0) - Number(firstMetrics[key] ?? 0))]).concat([["scoreTotal", null]]));
}

function buildAttempt(session, first) {
  const revealed = Boolean(session.revealedAt);
  const base = {
    id: session.id,
    attemptNumber: Number(session.attemptInfo?.attemptNumber ?? 1),
    kind: session.attemptInfo?.kind === "retrain" ? "retrain" : "first",
    countsTowardFirstScore: Boolean(session.attemptInfo?.countsTowardFirstScore),
    sourceSessionId: session.attemptInfo?.sourceSessionId ?? null,
    createdAt: session.createdAt,
    status: session.status,
    completionReason: session.completionReason ?? null,
    available: revealed,
  };
  if (!revealed) return base;
  const metrics = calculateObjectiveMetrics(session);
  const conditions = conditionsFor(session);
  const reasons = first
    ? (first.revealedAt ? reasonsBetween(first, session) : ["首次记录尚未揭晓"])
    : ["首次记录不可用"];
  const comparable = Boolean(first && first.revealedAt && reasons.length === 0);
  const scoreCard = session.review?.scoreCard ?? null;
  const firstScoreCard = first?.review?.scoreCard ?? null;
  const scoreComparable = comparable && scoreCard && firstScoreCard && sameJson(session.scoringConfig, first.scoringConfig);
  const delta = buildDelta(calculateObjectiveMetrics(first ?? session), metrics, comparable);
  if (scoreComparable && numberOrNull(scoreCard.total) != null && numberOrNull(firstScoreCard.total) != null) {
    delta.scoreTotal = roundMetric(Number(scoreCard.total) - Number(firstScoreCard.total));
  }
  return {
    ...base,
    scoreCard,
    metrics,
    conditions,
    originalReview: {
      blindReview: session.review?.blindReview ?? null,
      postReview: session.review?.postReview ?? null,
    },
    corrections: (session.corrections ?? []).map((correction) => ({
      id: correction.id,
      stage: correction.stage,
      revisionNumber: correction.revisionNumber,
      fullReviewSnapshot: correction.fullReviewSnapshot,
      changeNote: correction.changeNote,
      createdAt: correction.createdAt,
    })),
    executions: (session.executions ?? []).map((execution) => publicExecution(session, execution)),
    comparison: {
      comparable,
      reasons,
      delta,
    },
  };
}

export function buildReplayComparison({ selectedSession, attempts, firstUnavailable = null }) {
  const first = attempts.find((session) => session.attemptInfo?.kind === "first") ?? null;
  const selected = attempts.find((session) => session.id === selectedSession.id) ?? selectedSession;
  const visibleAttempts = attempts.map((session) => buildAttempt(session, first));
  return {
    selectedSessionId: selected.id,
    firstSessionId: first?.id ?? null,
    firstUnavailable: first ? null : firstUnavailable ?? "missing",
    counts: {
      first: first ? 1 : 0,
      retrain: attempts.filter((session) => session.attemptInfo?.kind === "retrain").length,
    },
    attempts: visibleAttempts,
  };
}
