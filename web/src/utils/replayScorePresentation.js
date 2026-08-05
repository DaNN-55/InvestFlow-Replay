const V2_DIMENSIONS = [
  { key: "executionDiscipline", label: "执行纪律", maximum: 30, description: "是否按买入、卖出与仓位计划执行。" },
  { key: "riskControl", label: "风险控制", maximum: 25, description: "止损、仓位和风险边界的执行情况。" },
  { key: "playbookCompliance", label: "战法符合度", maximum: 20, description: "本局操作与所关联战法规则的吻合程度；自由演练不参与此项评分。" },
  { key: "returnPerformance", label: "收益表现", maximum: 15, description: "本局最终收益在评分区间中的表现。" },
  { key: "reviewQuality", label: "复盘质量", maximum: 10, description: "揭晓前判断与揭晓后总结是否完整、具体。" },
];

const LEGACY_DIMENSIONS = [
  { key: "return", label: "收益表现", maximum: 25, description: "本局最终收益在旧版评分区间中的表现。" },
  { key: "benchmark", label: "基准表现", maximum: 15, description: "本局收益相对基准收益的表现。" },
  { key: "drawdown", label: "回撤控制", maximum: 20, description: "账户净值回撤的控制情况。" },
  { key: "discipline", label: "执行纪律", maximum: 25, description: "是否按既定交易计划执行。" },
  {
    key: "reviewCompleteness",
    label: "复盘完整度",
    maximum: 15,
    description: "旧版复盘字段的填写完整程度。",
  },
];

const APPLICABILITY_REASONS = {
  free_training: "自由演练不评价战法符合度",
  blank_playbook: "战法版本内容为空，不评价战法符合度",
  legacy_missing_input: "旧记录缺少该评分输入",
};

const METRIC_DESCRIPTIONS = {
  totalReturnPct: "初始资金到演练结束时总资产的涨跌幅。",
  benchmarkReturnPct: "首次买入后一直持有到演练结束的收益率。",
  excessReturnPct: "实际总收益率减去个股买入持有收益率。",
  stockBuyAndHoldReturnPct: "首次买入后一直持有到演练结束的收益率。",
  strategyVsStockBuyAndHoldPct: "实际总收益率减去个股买入持有收益率。",
  maxDrawdownPct: "账户净值从阶段高点到随后低点的最大跌幅。",
  realizedPnl: "已卖出仓位最终确认的盈亏。",
  unrealizedPnl: "结束时尚未卖出持仓按最新价格计算的浮动盈亏。",
  totalTradingCosts: "本局全部成交产生的费用总和。",
  endingCapitalUtilizationPct: "演练结束时持仓市值占总资产的比例。",
  averageCapitalUtilizationPct: "演练期间各时点资金使用率的平均值。",
  maxCapitalUtilizationPct: "演练期间出现过的最高资金使用率。",
  indexBenchmarkReturnPct: "同期所选指数基准的涨跌幅。",
  indexExcessReturnPct: "实际总收益率减去同期指数基准收益率。",
};

function withMetricDescriptions(metrics) {
  return metrics.map((metric) => ({
    ...metric,
    description: METRIC_DESCRIPTIONS[metric.key] ?? "本局评分使用的统计指标。",
  }));
}

function isV2ScoreCard(scoreCard) {
  return (
    scoreCard?.algorithmVersion === "replay-score-v2" ||
    Object.hasOwn(scoreCard?.breakdown ?? {}, "executionDiscipline")
  );
}

export function buildReplayScoreDimensions(scoreCard) {
  if (!scoreCard?.breakdown) {
    return [];
  }
  const definitions = isV2ScoreCard(scoreCard)
    ? V2_DIMENSIONS
    : LEGACY_DIMENSIONS;
  return definitions.map((dimension) => {
    const applicability = scoreCard.applicability?.[dimension.key];
    const value = scoreCard.breakdown[dimension.key];
    return {
      ...dimension,
      value,
      applicable:
        applicability?.applicable ?? value != null,
      reason: applicability?.reason
        ? APPLICABILITY_REASONS[applicability.reason] ?? "该维度不适用"
        : null,
    };
  });
}

export function isReplayPlaybookComplianceApplicable(item) {
  const applicability =
    item?.scoreCard?.applicability?.playbookCompliance?.applicable;
  if (typeof applicability === "boolean") {
    return applicability;
  }
  return item?.postReview?.playbookFitScore != null;
}

export function buildReplayScoreMetrics(scoreCard) {
  const metrics = scoreCard?.metrics;
  if (!metrics) {
    return [];
  }
  if (!isV2ScoreCard(scoreCard)) {
    return withMetricDescriptions([
      {
        key: "totalReturnPct",
        label: "总收益率",
        value: metrics.totalReturnPct,
        format: "percent",
        signed: true,
      },
      {
        key: "benchmarkReturnPct",
        label: "个股买入持有基准",
        value: metrics.benchmarkReturnPct,
        format: "percent",
        signed: true,
      },
      {
        key: "excessReturnPct",
        label: "相对个股超额",
        value: metrics.excessReturnPct,
        format: "percent",
        signed: true,
      },
      {
        key: "maxDrawdownPct",
        label: "最大回撤",
        value: metrics.maxDrawdownPct,
        format: "percent",
      },
    ]);
  }
  return withMetricDescriptions([
    {
      key: "totalReturnPct",
      label: "总收益率",
      value: metrics.totalReturnPct,
      format: "percent",
      signed: true,
    },
    {
      key: "stockBuyAndHoldReturnPct",
      label: "个股买入持有基准",
      value: metrics.stockBuyAndHoldReturnPct,
      format: "percent",
      signed: true,
    },
    {
      key: "strategyVsStockBuyAndHoldPct",
      label: "相对个股超额",
      value: metrics.strategyVsStockBuyAndHoldPct,
      format: "percent",
      signed: true,
    },
    {
      key: "maxDrawdownPct",
      label: "最大回撤",
      value: metrics.maxDrawdownPct,
      format: "percent",
    },
    {
      key: "realizedPnl",
      label: "已实现盈亏",
      value: metrics.realizedPnl,
      format: "money",
      signed: true,
    },
    {
      key: "unrealizedPnl",
      label: "未实现盈亏",
      value: metrics.unrealizedPnl,
      format: "money",
      signed: true,
    },
    {
      key: "totalTradingCosts",
      label: "交易成本",
      value: metrics.totalTradingCosts,
      format: "money",
    },
    {
      key: "endingCapitalUtilizationPct",
      label: "期末资金使用率",
      value: metrics.endingCapitalUtilizationPct,
      format: "percent",
    },
    {
      key: "averageCapitalUtilizationPct",
      label: "平均资金使用率",
      value: metrics.averageCapitalUtilizationPct,
      format: "percent",
    },
    {
      key: "maxCapitalUtilizationPct",
      label: "最高资金使用率",
      value: metrics.maxCapitalUtilizationPct,
      format: "percent",
    },
    {
      key: "indexBenchmarkReturnPct",
      label: "指数基准收益率",
      value: metrics.indexBenchmarkReturnPct,
      format: "percent",
      signed: true,
      unavailable:
        metrics.indexBenchmarkStatus === "unavailable" ||
        metrics.indexBenchmarkReturnPct == null,
    },
    {
      key: "indexExcessReturnPct",
      label: "相对指数超额",
      value: metrics.indexExcessReturnPct,
      format: "percent",
      signed: true,
      unavailable:
        metrics.indexBenchmarkStatus === "unavailable" ||
        metrics.indexExcessReturnPct == null,
    },
  ]);
}

export function buildReplayScoreWeightSnapshot(scoreCard) {
  const dimensions = buildReplayScoreDimensions(scoreCard);
  const weights = scoreCard?.weights ?? {};
  return dimensions.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    weight: Number(weights[dimension.key] ?? dimension.maximum),
    applicable: dimension.applicable,
    description: dimension.description,
  }));
}

export function formatReplayScoreMetric(metric) {
  if (metric.unavailable) {
    return "暂无指数数据";
  }
  const number = Number(metric.value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  if (metric.format === "money") {
    const sign = number < 0 ? "-" : metric.signed && number > 0 ? "+" : "";
    return `${sign}¥${Math.abs(number).toFixed(2)}`;
  }
  const sign = metric.signed && number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}
