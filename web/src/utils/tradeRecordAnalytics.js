const MARKET_PHASE_LABELS = {
  down: "下跌环境",
  weak_flat: "震荡偏弱",
  flat: "震荡",
  strong_flat: "震荡偏强",
  up_continuation: "上涨延续",
  overheated: "上涨过热",
};

function numberValue(value) {
  if (value == null || value === "") return null;
  const valueText = String(value).replace(/,/gu, "");
  const matched = valueText.match(/[-+]?\d+(?:\.\d+)?/u);
  const number = matched ? Number(matched[0]) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function completedTrade(record) {
  const ledgerReturnPct = numberValue(record?.ledger?.returnPct);
  const hasClosedLedger = record?.ledger?.state === "closed" && ledgerReturnPct != null;
  if (!hasClosedLedger && !["exited", "reviewed"].includes(String(record?.status ?? ""))) return null;
  let profitPct = ledgerReturnPct;
  if (!hasClosedLedger) {
    const entryPrice = numberValue(record?.actualEntryPrice);
    const exitPrice = numberValue(record?.actualExitPrice);
    if (entryPrice == null || exitPrice == null || entryPrice === 0) return null;
    profitPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  }
  return {
    profitPct,
    deviates: Array.isArray(record?.violations) && record.violations.length > 0,
    context: record?.frozenSnapshot?.candidateContext
      ?? record?.evaluationSnapshot?.candidateContext
      ?? record?.diagnosisSnapshot?.candidateContext
      ?? {},
  };
}

function summarize(trades) {
  const completedCount = trades.length;
  if (!completedCount) {
    return { completedCount: 0, winRatePct: null, averageProfitPct: null, profitLossRatio: null, deviationRatePct: null };
  }
  const wins = trades.filter((item) => item.profitPct > 0).length;
  const averageProfitPct = trades.reduce((sum, item) => sum + item.profitPct, 0) / completedCount;
  const profits = trades.filter((item) => item.profitPct > 0).map((item) => item.profitPct);
  const losses = trades.filter((item) => item.profitPct < 0).map((item) => Math.abs(item.profitPct));
  const averageWinPct = profits.reduce((sum, value) => sum + value, 0) / (profits.length || 1);
  const averageLossPct = losses.reduce((sum, value) => sum + value, 0) / (losses.length || 1);
  const profitLossRatio = losses.length
    ? Math.round((averageWinPct / averageLossPct) * 100) / 100
    : profits.length ? Number.POSITIVE_INFINITY : 0;
  const deviations = trades.filter((item) => item.deviates).length;
  return {
    completedCount,
    winRatePct: Math.round((wins / completedCount) * 10000) / 100,
    averageProfitPct: Math.round(averageProfitPct * 100) / 100,
    profitLossRatio,
    deviationRatePct: Math.round((deviations / completedCount) * 10000) / 100,
  };
}

function groupTrades(trades, getLabel) {
  const groups = new Map();
  for (const trade of trades) {
    const label = String(getLabel(trade) ?? "").trim();
    if (!label) continue;
    const group = groups.get(label) ?? [];
    group.push(trade);
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, ...summarize(rows) }));
}

export function buildTradeRecordAnalytics(records = []) {
  const trades = records.map(completedTrade).filter(Boolean);
  return {
    summary: summarize(trades),
    groups: {
      marketPhase: groupTrades(trades, (item) => MARKET_PHASE_LABELS[item.context?.marketPhase] ?? item.context?.marketPhase),
      mainline: groupTrades(trades, (item) => item.context?.sectorName),
      role: groupTrades(trades, (item) => item.context?.candidateRole ?? item.context?.role),
    },
  };
}
