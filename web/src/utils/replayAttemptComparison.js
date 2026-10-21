const METRICS = [
  { key: "scoreTotal", label: "原始评分", type: "score" },
  { key: "totalReturnPct", label: "收益率", type: "percent" },
  { key: "maxDrawdownPct", label: "最大回撤", type: "percent" },
  { key: "totalTradingCosts", label: "交易费用", type: "money" },
  { key: "averageCapitalUtilizationPct", label: "平均仓位", type: "percent" },
  { key: "maxCapitalUtilizationPct", label: "最高仓位", type: "percent" },
  { key: "buyFillCount", label: "买入成交笔数", type: "count" },
  { key: "sellFillCount", label: "卖出成交笔数", type: "count" },
];

export function formatComparisonValue(value, type, delta = false) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const sign = delta && number > 0 ? "+" : "";
  if (type === "count") return `${sign}${number}`;
  if (type === "money") return `${sign}${number < 0 ? "−" : ""}¥${Math.abs(number).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const suffix = type === "percent" ? delta ? " 个百分点" : "%" : " 分";
  return `${sign}${number.toFixed(2)}${suffix}`;
}

export function buildAttemptComparisonRows(first, attempt) {
  return METRICS.map((metric) => {
    const value = (item) => item?.available
      ? metric.key === "scoreTotal" ? item.scoreCard?.total : item.metrics?.[metric.key]
      : null;
    return { ...metric,
      first: formatComparisonValue(value(first), metric.type),
      attempt: formatComparisonValue(value(attempt), metric.type),
      delta: formatComparisonValue(first?.available && attempt?.available && attempt?.comparison?.comparable === true && value(first) != null && value(attempt) != null
        ? attempt.comparison.delta?.[metric.key] : null, metric.type, true),
    };
  });
}

export function selectComparisonAttempt(attempts, selectedSessionId) {
  const retrains = attempts.filter((attempt) => attempt.kind === "retrain");
  return retrains.find((attempt) => attempt.id === selectedSessionId)?.id
    ?? retrains.filter((attempt) => attempt.available).at(-1)?.id
    ?? retrains.at(-1)?.id ?? "";
}

export function formatComparisonExecution(execution) {
  const step = execution.step ?? execution.sequence;
  const when = execution.tradeTime || execution.tradeDate || (step == null ? "时点未记录" : `第 ${step} 步`);
  const action = execution.side === "sell" ? "卖出" : "买入";
  const status = { rejected: "未成交", cancelled: "已撤销", expired: "已到期" }[execution.status] ?? "未成交";
  if (execution.status !== "filled") return `${when} · ${action} ${status}`;
  return `${when} · ${action} ${execution.quantity} 股 · ${formatComparisonValue(execution.price, "money")} · 费用 ${formatComparisonValue(execution.totalFee, "money")}`;
}
