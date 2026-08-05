export const REPLAY_BUY_REASON_TAG_OPTIONS = Object.freeze([
  "趋势",
  "突破",
  "回踩",
  "量价",
  "情绪",
  "基本面",
  "风险",
]);

export const REPLAY_SELL_REASON_TAG_OPTIONS = Object.freeze([
  "触发止损",
  "触发止盈",
  "逻辑失效",
  "趋势转弱",
  "量价异常",
  "仓位调整",
  "纪律退出",
]);

export const REPLAY_REASON_TAG_OPTIONS = REPLAY_BUY_REASON_TAG_OPTIONS;

export function formatReplayReasonTags(value) {
  return Array.isArray(value) && value.length > 0
    ? value.join("、")
    : "未记录";
}

export function formatReplayInvalidationRule(rule) {
  if (
    rule?.basis !== "close" ||
    !["lte", "gte"].includes(rule.operator) ||
    !(Number(rule.threshold) > 0)
  ) {
    return "未记录";
  }
  const operator = rule.operator === "lte" ? "≤" : "≥";
  const note = String(rule.note ?? "").trim();
  return `收盘价 ${operator} ${Number(rule.threshold)}${note ? `；${note}` : ""}`;
}

export function getReplayReviewEntryState(session = {}) {
  const available = Boolean(session.revealed);
  return {
    available,
    label: available ? "查看复盘" : "揭晓后查看复盘",
  };
}

export function buildReplayBlindReviewPrefill(session = {}) {
  const records = [
    ...(Array.isArray(session.executions) ? session.executions : []),
    ...(Array.isArray(session.pendingOrders) ? session.pendingOrders : []),
  ];
  const latestBuy = records
    .filter((record) => record?.side === "buy" && record.decision)
    .sort(
      (left, right) =>
        Number(right.sequence ?? right.scheduledSequence ?? 0) -
        Number(left.sequence ?? left.scheduledSequence ?? 0),
    )[0];

  if (!latestBuy) {
    return null;
  }

  return {
    thesis: String(latestBuy.decision.thesis ?? "").trim(),
    tradePlan: String(latestBuy.decision.plan ?? "").trim(),
    riskPlan: String(latestBuy.decision.riskPlan ?? "").trim(),
    confidence: Number(latestBuy.decision.confidence) || 3,
    reasonTags: Array.isArray(latestBuy.decision.reasonTags)
      ? [...new Set(latestBuy.decision.reasonTags.map(String))].slice(0, 8)
      : [],
  };
}

export function buildReplayBlindReviewPayload(input) {
  const payload = {
    strategyName: String(input.strategyName ?? "").trim(),
    thesis: String(input.thesis ?? "").trim(),
    tradePlan: String(input.tradePlan ?? "").trim(),
    riskPlan: String(input.riskPlan ?? "").trim(),
    confidence: Number(input.confidence),
    reasonTags: Array.isArray(input.reasonTags)
      ? [...new Set(input.reasonTags.map(String))].slice(0, 8)
      : [],
    stopLossPrice:
      Number(input.stopLossPrice) > 0 ? Number(input.stopLossPrice) : null,
    invalidationRule: input.invalidationRule
      ? {
          basis: "close",
          operator: input.invalidationRule.operator,
          ...(Number(input.invalidationRule.threshold) > 0
            ? { threshold: Number(input.invalidationRule.threshold) }
            : {}),
          note: String(input.invalidationRule.note ?? "").trim(),
        }
      : null,
  };
  if (input.playbookId) {
    payload.playbookId = input.playbookId;
  }
  if (input.playbookVersionId) {
    payload.playbookVersionId = input.playbookVersionId;
  }
  return payload;
}

export function buildReplayOrderSubmission(input = {}) {
  const side = input.side === "sell" ? "sell" : "buy";
  const reasonTags = Array.isArray(input.reasonTags)
    ? [...new Set(input.reasonTags.map(String))].slice(0, 8)
    : [];
  const sizing = input.inputMode === "ratio"
    ? side === "buy"
      ? { cashRatio: Number(input.ratio) }
      : { positionRatio: Number(input.ratio) }
    : { quantity: Number(input.quantity) };
  const common = {
    reasonTags,
    confidence: Number(input.confidence),
    thesis: String(input.thesis ?? "").trim(),
    plan: String(input.plan ?? "").trim(),
  };
  const decision = side === "buy"
    ? {
        ...common,
        riskPlan: String(input.riskPlan ?? "").trim(),
        stopLossPrice: Number(input.stopLossPrice) > 0
          ? Number(input.stopLossPrice)
          : null,
        invalidationRule: input.invalidationEnabled
          ? {
              basis: "close",
              operator: input.invalidationOperator,
              threshold: Number(input.invalidationThreshold),
              note: String(input.invalidationNote ?? "").trim(),
            }
          : null,
      }
    : {
        ...common,
        exitType: String(input.exitType ?? ""),
        remainingPositionPlan: String(input.remainingPositionPlan ?? "").trim(),
      };
  return { side, ...sizing, decision };
}
