export const REPLAY_AUTOPLAY_SPEEDS = Object.freeze([
  { value: "slow", label: "慢速", delayMs: 2200 },
  { value: "normal", label: "正常", delayMs: 1100 },
  { value: "fast", label: "快速", delayMs: 450 },
]);

export function getReplayAutoplayDelay(speed) {
  return (
    REPLAY_AUTOPLAY_SPEEDS.find((item) => item.value === speed)?.delayMs ??
    REPLAY_AUTOPLAY_SPEEDS[1].delayMs
  );
}

function formatPrice(value) {
  return Number(value).toFixed(2);
}

export function getReplayDraftRiskStopReason(session, blindDraft) {
  const close = Number(session?.bars?.at(-1)?.close);
  if (!Number.isFinite(close) || !blindDraft) {
    return "";
  }
  const stopLossPrice = Number(blindDraft.stopLossPrice);
  if (Number.isFinite(stopLossPrice) && stopLossPrice > 0 && close <= stopLossPrice) {
    return `最新已揭示日线收盘价 ${formatPrice(close)} 已触及盲评止损价 ${formatPrice(stopLossPrice)}。自动播放已暂停；仅作提醒，不会自动平仓，也不代表盘中成交。`;
  }
  const rule = blindDraft.invalidationRule;
  const threshold = Number(rule?.threshold);
  const triggered =
    rule?.basis === "close" &&
    Number.isFinite(threshold) &&
    threshold > 0 &&
    ((rule.operator === "lte" && close <= threshold) ||
      (rule.operator === "gte" && close >= threshold));
  if (!triggered) {
    return "";
  }
  const operatorLabel = rule.operator === "lte" ? "≤" : "≥";
  const note = String(rule.note ?? "").trim();
  return `最新已揭示日线收盘价 ${formatPrice(close)} 已满足失效条件（收盘价 ${operatorLabel} ${formatPrice(threshold)}）${note ? `：${note}` : ""}。自动播放已暂停；仅作提醒，不会自动平仓，也不代表盘中成交。`;
}

export function getReplayAutoplayStopReason(
  session,
  { executionStartIndex = null, blindDraft = null } = {},
) {
  if (!session?.id) {
    return "当前没有可播放的演练会话。";
  }
  if (session.status === "completed") {
    return "本局演练已完成，自动播放已暂停，请填写揭晓前盲评。";
  }
  if (session.status !== "active") {
    return `会话状态异常（${session.status || "未知"}），自动播放已暂停。`;
  }
  const pendingCount = session.pendingOrders?.length ?? 0;
  if (pendingCount > 0) {
    return `检测到 ${pendingCount} 笔待处理委托，自动播放已暂停，请手动确认推进。`;
  }
  const draftRiskReason = getReplayDraftRiskStopReason(session, blindDraft);
  if (draftRiskReason) {
    return draftRiskReason;
  }
  const marketEventMessages = {
    suspended: "当前交易日停牌，自动播放已暂停，请确认后手动推进。",
    limit_up: "当前交易日触及涨停状态，自动播放已暂停。",
    limit_down: "当前交易日触及跌停状态，自动播放已暂停。",
    invalid_market_data: "当前交易日行情数据异常，自动播放已暂停。",
  };
  const marketEventStatus = session.marketEvent?.status;
  if (
    marketEventStatus &&
    marketEventStatus !== "normal"
  ) {
    return (
      marketEventMessages[marketEventStatus] ??
      `行情状态异常（${marketEventStatus}），自动播放已暂停。`
    );
  }
  if (executionStartIndex != null) {
    const newExecutions = (session.executions ?? []).slice(executionStartIndex);
    const rejected = newExecutions.find(
      (execution) => execution.status !== "filled",
    );
    if (rejected) {
      return `${rejected.reasonMessage || "委托被拒绝或行情状态异常"}，自动播放已暂停。`;
    }
  }
  return "";
}
