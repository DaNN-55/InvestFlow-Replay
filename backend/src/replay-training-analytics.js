import { isSyntheticReplay, replayBoardRules } from "./replay-board-rules.js";
import { calculateObjectiveMetrics } from "./replay-comparison.js";
import { detectTrainingConditionEvents } from "./replay-training-events.js";

export const REPLAY_ISSUE_TAGS = Object.freeze([
  "提前入场",
  "追涨",
  "仓位过大",
  "退出犹豫",
  "偏离计划",
  "无明确依据",
]);

const ISSUE_TAG_SET = new Set(REPLAY_ISSUE_TAGS);

function finite(value) {
  if (value == null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finiteOrZero(value) {
  const result = finite(value);
  return result == null ? 0 : result;
}

function beijingDate(value) {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(4));
}

function rounded(value) {
  return value == null ? null : Number(Number(value).toFixed(4));
}

function issueTagsFor(session) {
  let review = session.review?.postReview;
  const corrections = (session.corrections ?? [])
    .filter((correction) => correction.stage === "post" && correction.fullReviewSnapshot && typeof correction.fullReviewSnapshot === "object")
    .sort((left, right) => Number(left.revisionNumber ?? 0) - Number(right.revisionNumber ?? 0));
  if (corrections.length) review = corrections.at(-1).fullReviewSnapshot;
  const tags = Array.isArray(review?.issueTags) ? review.issueTags : [];
  return [...new Set(tags.filter((tag) => ISSUE_TAG_SET.has(tag)))];
}

function boardFor(session) {
  return replayBoardRules(session.snapshot)?.board ?? null;
}

function inDateWindow(session, from, to) {
  const date = beijingDate(session.createdAt);
  return Boolean(date && (!from || date >= from) && (!to || date <= to));
}

function usableSession(session) {
  if (session.status !== "completed" || !session.revealedAt) return false;
  const metrics = calculateObjectiveMetrics(session);
  const bars = Array.isArray(session.snapshot?.bars) ? session.snapshot.bars : [];
  return bars.length >= Number(session.observationBars ?? 0) + Number(session.revealedFutureBars ?? 0)
    && Number(session.revealedFutureBars ?? 0) > 0
    && Number(session.account?.initialCapital) > 0
    && metrics.totalReturnPct != null;
}

function allOrdersFor(session) {
  return [...(session.pendingOrders ?? []), ...(session.executions ?? [])];
}

function hasFrozenEvaluableCondition(session) {
  const observationBars = finiteOrZero(session.observationBars);
  const revealedBars = finiteOrZero(session.revealedFutureBars);
  const bars = Array.isArray(session.snapshot?.bars) ? session.snapshot.bars : [];
  if (revealedBars <= 0 || bars.length < observationBars + revealedBars) return false;
  const orders = allOrdersFor(session);
  const filledBuys = orders.filter((order) => order.side === "buy" && order.status === "filled" && finiteOrZero(order.quantity) > 0);
  if (!filledBuys.length) return false;
  const filledBuyIds = new Set(filledBuys.map((order) => String(order.orderId ?? order.id ?? "")));
  return filledBuys.some((order) => Boolean(order.decision?.stopLossPrice || order.decision?.invalidationRule?.basis === "close"))
    || orders.some((order) => {
      if (order.side !== "sell" || String(order.orderType ?? "").toLowerCase() !== "stop" || finiteOrZero(order.stopPrice ?? order.decision?.stopLossPrice) <= 0) return false;
      if (order.sourceOrderId && filledBuyIds.has(String(order.sourceOrderId))) return true;
      const submitted = finite(order.submittedSequence);
      return submitted != null && filledBuys.some((buy) => {
        const buySequence = finite(buy.sequence ?? buy.submittedSequence);
        return buySequence != null && submitted > buySequence;
      });
    });
}

function detectorEventsFor(session) {
  if (!session?.revealedAt || session.status !== "completed" || !hasFrozenEvaluableCondition(session)) return [];
  return detectTrainingConditionEvents({
    session,
    orders: allOrdersFor(session),
    throughSequence: Number(session.observationBars ?? 0) + Number(session.revealedFutureBars ?? 0),
  });
}

function classifyEvent(row) {
  const type = String(row?.eventType ?? row?.event_type ?? "").toLowerCase();
  let payload = row?.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  if (type === "training_condition_triggered") {
    const ruleKey = String(payload?.ruleKey ?? payload?.rule?.kind ?? "").toLowerCase();
    return {
      triggered: true,
      stopTriggered: ruleKey === "stop_touch",
      invalidationTriggered: ruleKey === "invalidation_close",
      protected: false,
      autoExit: false,
      stopCancelled: false,
      exitOrder: false,
      restricted: false,
      partialFill: false,
    };
  }
  if (type !== "training_execution_observed") return null;
  const observations = Array.isArray(payload?.observations) ? payload.observations : [];
  const restrictedCodes = new Set(["volume_capacity", "insufficient_sellable", "one_price_limit_up", "one_price_limit_down", "suspended", "invalid_market_data"]);
  return {
    triggered: false,
    stopTriggered: false,
    invalidationTriggered: false,
    protected: false,
    autoExit: observations.some((item) => item.side === "sell" && item.orderType === "stop" && item.status === "filled" && finiteOrZero(item.filledThisStep) > 0),
    stopCancelled: observations.some((item) => item.side === "sell" && item.orderType === "stop" && item.reasonCode === "cancelled_by_user"),
    exitOrder: observations.some((item) => item.side === "sell"),
    restricted: observations.some((item) => restrictedCodes.has(String(item.reasonCode ?? "")) || item.restricted === true),
    partialFill: observations.some((item) => finiteOrZero(item.filledQuantity) > 0 && finiteOrZero(item.remainingQuantity) > 0),
  };
}

function emptyDistribution() {
  return { n: 0, median: null, min: null, max: null, buckets: [] };
}

function distribution(values, kind) {
  if (!values.length) return emptyDistribution();
  const labels = kind === "return"
    ? [["<-5%", -Infinity, -5], ["-5%–0%", -5, 0], ["0%–5%", 0, 5], [">=5%", 5, Infinity]]
    : [["<1%", -Infinity, 1], ["1%–3%", 1, 3], ["3%–5%", 3, 5], [">=5%", 5, Infinity]];
  return {
    n: values.length,
    median: median(values),
    min: rounded(Math.min(...values)),
    max: rounded(Math.max(...values)),
    buckets: labels.map(([label, min, max]) => ({ label, count: values.filter((value) => value >= min && value < max).length })),
  };
}

function eventSummary(sessions, eventsBySession) {
  const completedRevealed = sessions.filter((session) => session.status === "completed" && session.revealedAt);
  const eligible = completedRevealed.filter(hasFrozenEvaluableCondition);
  const flags = new Map();
  for (const session of completedRevealed) {
    const rawRows = eventsBySession.get(session.id) ?? [];
    const rows = [
      ...rawRows.map(classifyEvent).filter(Boolean),
      ...(hasFrozenEvaluableCondition(session) ? detectorEventsFor(session).map((event) => classifyEvent({ eventType: "training_condition_triggered", payload: { ruleKey: event.kind } })) : []),
    ];
    const aggregate = { triggered: false, stopTriggered: false, invalidationTriggered: false, protected: false, autoExit: false, stopCancelled: false, exitOrder: false, restricted: false, partialFill: false };
    for (const event of rows) for (const key of Object.keys(aggregate)) aggregate[key] ||= Boolean(event[key]);
    const orders = allOrdersFor(session);
    aggregate.protected = orders.some((order) => order.side === "sell" && String(order.orderType ?? "").toLowerCase() === "stop" && finiteOrZero(order.stopPrice) > 0);
    aggregate.exitOrder ||= orders.some((order) => order.side === "sell");
    aggregate.autoExit ||= orders.some((order) => order.side === "sell" && order.orderType === "stop" && order.status === "filled" && finiteOrZero(order.quantity) > 0);
    aggregate.partialFill ||= orders.some((order) => finiteOrZero(order.filledQuantity) > 0 && finiteOrZero(order.remainingQuantity) > 0);
    const restrictedCodes = new Set(["volume_capacity", "insufficient_sellable", "one_price_limit_up", "one_price_limit_down", "suspended", "invalid_market_data"]);
    aggregate.restricted ||= orders.some((order) => restrictedCodes.has(String(order.reasonCode ?? "")));
    const orderById = new Map(orders.map((order) => [String(order.orderId ?? order.id ?? ""), order]));
    if (rawRows.some((row) => row.eventType === "order_cancelled" && orderById.get(String(row.payload?.orderId ?? ""))?.orderType === "stop")) {
      aggregate.stopCancelled = true;
    }
    aggregate.stopCancelled ||= orders.some((order) => order.side === "sell" && order.orderType === "stop" && order.status === "cancelled" && order.reasonCode === "cancelled_by_user");
    flags.set(session.id, aggregate);
  }
  const count = (key) => [...flags.values()].filter((flags) => flags[key]).length;
  return {
    evaluableSessions: eligible.length,
    triggeredSessions: count("triggered"),
    stopTriggeredSessions: count("stopTriggered"),
    invalidationTriggeredSessions: count("invalidationTriggered"),
    protectedSessions: count("protected"),
    autoExitSessions: count("autoExit"),
    stopCancelledSessions: count("stopCancelled"),
    exitOrderSessions: count("exitOrder"),
    restrictedSessions: count("restricted"),
    partialFillSessions: count("partialFill"),
  };
}

function cohort(sessions, eventsBySession) {
  const ordered = sessions.filter(usableSession).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const groups = { earlier: ordered.length < 21 ? [] : ordered.slice(-40, -20), recent: ordered.slice(-20) };
  return Object.fromEntries(Object.entries(groups).map(([key, items]) => {
    const metrics = items.map((session) => calculateObjectiveMetrics(session));
    const dates = items.map((session) => beijingDate(session.createdAt)).filter(Boolean).sort();
    return [key, {
      n: items.length,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      returnMedian: median(metrics.map((metric) => metric.totalReturnPct).filter((value) => value != null)),
      drawdownMedian: median(metrics.map((metric) => metric.maxDrawdownPct).filter((value) => value != null)),
      taggedSessions: items.filter((session) => issueTagsFor(session).length > 0).length,
      triggeredSessions: items.filter((session) => eventSummary([session], eventsBySession).triggeredSessions > 0).length,
    }];
  }));
}

function breakdown(items, mapper) {
  const counts = new Map();
  for (const session of items) {
    const label = mapper(session);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => left.label.localeCompare(right.label));
}

function groupAnalytics(items, eventsBySession) {
  const completed = items.filter((session) => session.status === "completed");
  const revealed = completed.filter((session) => session.revealedAt);
  const computed = revealed.filter(usableSession);
  const metrics = computed.map((session) => calculateObjectiveMetrics(session));
  const issues = new Map();
  for (const session of revealed) for (const tag of issueTagsFor(session)) {
    const entry = issues.get(tag) ?? { tag, count: 0, samples: [] };
    entry.count += 1;
    entry.samples.push({ sessionId: session.id, createdAt: session.createdAt, interval: session.snapshot?.interval ?? "1d", gameLength: Number(session.gameLength), attemptNumber: Number(session.attemptInfo?.attemptNumber ?? 1) });
    issues.set(tag, entry);
  }
  return {
    counts: {
      sessions: items.length,
      active: items.filter((session) => session.status === "active").length,
      completed: completed.length,
      unrevealed: items.filter((session) => !session.revealedAt).length,
      analysed: revealed.length,
      scored: revealed.filter((session) => session.review?.scoreCard).length,
      skipped: items.filter((session) => session.completionReason === "no_opportunity").length,
      tagged: revealed.filter((session) => issueTagsFor(session).length > 0).length,
      uncomputable: revealed.filter((session) => !hasFrozenEvaluableCondition(session)).length,
      metricsUncomputable: revealed.filter((session) => !usableSession(session)).length,
    },
    distributions: {
      returns: distribution(metrics.map((metric) => metric.totalReturnPct).filter((value) => value != null), "return"),
      drawdowns: distribution(metrics.map((metric) => metric.maxDrawdownPct).filter((value) => value != null), "drawdown"),
    },
    feesTotal: rounded(metrics.reduce((sum, metric) => sum + Number(metric.totalTradingCosts ?? 0), 0)),
    issues: [...issues.values()],
    events: eventSummary(items, eventsBySession),
    cohorts: cohort(items, eventsBySession),
    breakdowns: {
      intervals: breakdown(items, (session) => session.snapshot?.interval ?? "1d"),
      boards: breakdown(items, boardFor),
      executionModels: breakdown(items, (session) => session.executionModelVersion ?? "unknown"),
    },
  };
}

export function buildReplayTrainingAnalytics({ sessions = [], eventsBySession = new Map(), filters = {} }) {
  const normalized = {
    from: filters.from ?? null,
    to: filters.to ?? null,
    interval: filters.interval ?? "all",
    gameLength: filters.gameLength == null || filters.gameLength === "all" ? "all" : Number(filters.gameLength),
    board: filters.board ?? "all",
  };
  const selected = sessions.filter((session) => {
    if (isSyntheticReplay(session.snapshot)) return false;
    const interval = session.snapshot?.interval ?? "1d";
    if (normalized.interval !== "all" && interval !== normalized.interval) return false;
    if (normalized.gameLength !== "all" && Number(session.gameLength) !== normalized.gameLength) return false;
    if (normalized.board !== "all" && boardFor(session) !== normalized.board) return false;
    return inDateWindow(session, normalized.from, normalized.to);
  });
  const first = selected.filter((session) => session.attemptInfo?.kind !== "retrain");
  const retrain = selected.filter((session) => session.attemptInfo?.kind === "retrain");
  return { filters: normalized, groups: { first: groupAnalytics(first, eventsBySession), retrain: groupAnalytics(retrain, eventsBySession) } };
}
