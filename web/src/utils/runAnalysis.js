function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((item) => (item - mean) ** 2));
  return Math.sqrt(variance);
}

function variance(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  return average(values.map((item) => (item - mean) ** 2));
}

function covariance(first, second) {
  if (first.length < 2 || second.length < 2 || first.length !== second.length) {
    return 0;
  }
  const firstMean = average(first);
  const secondMean = average(second);
  return average(
    first.map(
      (value, index) => (value - firstMean) * (second[index] - secondMean),
    ),
  );
}

function toDateString(value) {
  return String(value ?? "").slice(0, 10);
}

function diffDays(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return 0;
  }
  return Math.max(0, Math.round((endTime - startTime) / 86400000));
}

function summarizeRange(values) {
  if (!values.length) {
    return {
      count: 0,
      average: 0,
      max: 0,
      min: 0,
    };
  }
  return {
    count: values.length,
    average: average(values),
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

export function formatCurrency(value) {
  return `¥${toNumber(value).toFixed(2)}`;
}

export function formatRatio(value) {
  return toNumber(value).toFixed(2);
}

export function formatPercent(value) {
  return `${toNumber(value).toFixed(2)}%`;
}

export function formatSignedPercent(value) {
  const number = toNumber(value);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}

export function formatAdjustLabel(value) {
  const normalized = String(value ?? "qfq")
    .trim()
    .toLowerCase();
  if (normalized === "hfq") {
    return "后复权";
  }
  if (normalized === "none") {
    return "不复权";
  }
  return "前复权";
}

export function resolveBenchmarkLabel(value) {
  const labels = {
    "000300.XSHG": "沪深300",
    "000001.XSHG": "上证指数",
    "399001.XSHE": "深证成指",
    "399006.XSHE": "创业板指",
    "000905.XSHG": "中证500",
    "000016.XSHG": "上证50",
    "000906.XSHG": "中证800",
    "000688.XSHG": "科创50",
    "399673.XSHE": "创业板50",
    "399330.XSHE": "深证100",
    "399303.XSHE": "国证2000",
  };
  const code = String(value ?? "").trim();
  return labels[code] ?? (code || "无基准");
}

export function formatOrderBookId(symbol, exchange) {
  const normalizedSymbol = String(symbol ?? "").trim();
  const normalizedExchange = String(exchange ?? "")
    .trim()
    .toUpperCase();
  if (!normalizedSymbol || !normalizedExchange) {
    return "";
  }
  const suffix =
    normalizedExchange === "SSE"
      ? "XSHG"
      : normalizedExchange === "SZSE"
        ? "XSHE"
        : normalizedExchange;
  return `${normalizedSymbol}.${suffix}`;
}

function formatPercentParameter(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }
  return `${parsed.toFixed(digits)}%`;
}

function formatPlainParameter(value, digits = 4) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed.toFixed(digits).replace(/\.?0+$/, "");
  }
  const text = String(value ?? "").trim();
  return text || "--";
}

function formatSizingMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "percent") {
    return "按资金比例";
  }
  if (normalized === "fixed") {
    return "固定股数";
  }
  return normalized || "--";
}

function formatSlippageMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "ratio") {
    return "按比例";
  }
  if (normalized === "absolute" || normalized === "fixed") {
    return "按固定价差";
  }
  return normalized || "--";
}

function formatStrategyParameterValue(value) {
  if (typeof value === "number") {
    return formatPlainParameter(value);
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  const text = String(value ?? "").trim();
  return text || "--";
}

function hasMeaningfulParameterValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return true;
  }
  return String(value ?? "").trim() !== "";
}

function buildParameterSnapshot(run) {
  const summary = run?.summary ?? {};
  const summaryParameters = summary.parameters ?? {};
  const request = run?.request ?? {};
  const requestParameters = request.parameters ?? {};
  const costModel =
    summary.costModel ?? summaryParameters.costModel ?? request.costModel ?? {};

  const mergedParameters = {
    ...requestParameters,
    ...summaryParameters,
  };

  const genericParameterKeys = new Set([
    "benchmark",
    "sourcePath",
    "adjust",
    "slippage",
    "rate",
    "costModel",
    "sizing_mode",
    "fixed_size",
    "position_pct",
    "cash_reserve_pct",
    "stop_loss_pct",
    "take_profit_pct",
    "trailing_stop_pct",
  ]);

  const strategyParams = Object.entries(mergedParameters)
    .filter(
      ([key, value]) =>
        !genericParameterKeys.has(key) && hasMeaningfulParameterValue(value),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatStrategyParameterValue(value)}`);

  return {
    period:
      summary.startDate && summary.endDate
        ? `${summary.startDate} → ${summary.endDate}`
        : request.startDate && request.endDate
          ? `${request.startDate} → ${request.endDate}`
          : "--",
    benchmark:
      (summary.benchmark ?? request.benchmark)
        ? `${resolveBenchmarkLabel(summary.benchmark ?? request.benchmark)} (${summary.benchmark ?? request.benchmark})`
        : "--",
    adjust: formatAdjustLabel(summary.adjust ?? request.adjust),
    sizingMode: formatSizingMode(
      mergedParameters.sizing_mode ?? request.sizingMode,
    ),
    fixedSize: Number.isFinite(
      Number(mergedParameters.fixed_size ?? request.fixedSize),
    )
      ? `${formatPlainParameter(mergedParameters.fixed_size ?? request.fixedSize, 0)} 股`
      : "--",
    positionPct: formatPercentParameter(
      mergedParameters.position_pct ?? request.positionPct,
    ),
    cashReservePct: formatPercentParameter(
      mergedParameters.cash_reserve_pct ?? request.cashReservePct,
    ),
    stopLossPct: formatPercentParameter(
      mergedParameters.stop_loss_pct ?? request.stopLossPct,
    ),
    takeProfitPct: formatPercentParameter(
      mergedParameters.take_profit_pct ?? request.takeProfitPct,
    ),
    trailingStopPct: formatPercentParameter(
      mergedParameters.trailing_stop_pct ?? request.trailingStopPct,
    ),
    slippageMode: formatSlippageMode(
      costModel.slippageMode ?? request.slippageMode,
    ),
    slippageValue: formatPlainParameter(
      costModel.slippageValue ?? request.slippageValue,
    ),
    openCommissionRate: formatPlainParameter(
      costModel.openCommissionRate ?? request.openCommissionRate,
    ),
    closeCommissionRate: formatPlainParameter(
      costModel.closeCommissionRate ?? request.closeCommissionRate,
    ),
    minCommission: formatCurrency(
      costModel.minCommission ?? request.minCommission ?? 0,
    ),
    stampDutyRate: formatPlainParameter(
      costModel.stampDutyRate ?? request.stampDutyRate,
    ),
    impactCostBps: Number.isFinite(
      Number(costModel.impactCostBps ?? request.impactCostBps),
    )
      ? `${formatPlainParameter(costModel.impactCostBps ?? request.impactCostBps)} bps`
      : "--",
    strategyParams: strategyParams.length ? strategyParams.join(" | ") : "--",
  };
}

function cleanLogMessage(value) {
  const message = String(value ?? "").trim();
  if (!message) {
    return "";
  }
  return message
    .replace(/^\[[^\]]+\]\s*\w+:\s*(?:user_system_log:\s*)?/i, "")
    .trim();
}

export function buildNoTradeHint(run) {
  const summary = run?.summary ?? null;
  if (!summary) {
    return "";
  }

  const trades = run?.artifacts?.trades ?? [];
  if (trades.length || toNumber(summary.totalTradeCount) > 0) {
    return "";
  }

  const logs = run?.artifacts?.logs ?? [];
  const zeroQuantityLog = logs.find((item) =>
    /0 order quantity/i.test(String(item?.message ?? "")),
  );
  if (zeroQuantityLog) {
    const parameters = summary.parameters ?? run?.request?.parameters ?? {};
    const sizingMode = String(
      parameters.sizing_mode ?? run?.request?.sizingMode ?? "",
    )
      .trim()
      .toLowerCase();
    const positionPct = toNumber(
      parameters.position_pct ?? run?.request?.positionPct,
      0,
    );
    const reservePct = toNumber(
      parameters.cash_reserve_pct ?? run?.request?.cashReservePct,
      0,
    );
    const sizingModeLabel = sizingMode === "fixed" ? "固定股数" : "资金占比";
    const budgetText =
      sizingMode === "percent"
        ? `按当前资金占比 ${positionPct}% 和现金保留 ${reservePct}% 的设置`
        : "按当前资金和固定股数的设置";
    return `这次回测其实出现过下单尝试，但 ${budgetText} 折算后，实际买入数量不足一手（100 股），所以没有成交。当前仓位模式：${sizingModeLabel}。`;
  }

  const rejectedLog = logs.find((item) =>
    /order creation failed|rejected|insufficient/i.test(
      String(item?.message ?? ""),
    ),
  );
  if (rejectedLog) {
    const detail = cleanLogMessage(rejectedLog.message);
    return detail
      ? `这次回测没有生成成交记录，日志里提示下单失败：${detail}。`
      : "这次回测没有生成成交记录，日志里出现了下单失败提示。";
  }

  return "这次回测没有生成成交记录，更可能是这段时间没有触发买卖信号。";
}

export function createRunAnalysis(run) {
  const summary = run?.summary ?? null;
  const rows = run?.artifacts?.daily ?? [];
  const trades = run?.artifacts?.trades ?? [];

  const initialCapital = toNumber(
    summary?.capital ?? run?.capital ?? rows[0]?.balance ?? 1,
    1,
  );
  const endBalance = toNumber(
    summary?.endBalance ?? rows.at(-1)?.balance ?? initialCapital,
    initialCapital,
  );
  const totalReturnPct = toNumber(summary?.totalReturn) * 100;
  const annualReturnPct = toNumber(summary?.annualReturn) * 100;
  const maxDrawdownPct = Math.abs(toNumber(summary?.maxDrawdown) * 100);

  const performancePoints = [];
  const returnRatePoints = [];
  const drawdownPoints = [];
  const dailyReturns = [];
  const strategyDailyWithBenchmark = [];
  const benchmarkDailyReturns = [];
  const excessDailyReturns = [];
  const negativeReturns = [];
  const pnlValues = [];
  let prevBalance = initialCapital;
  let prevBenchmark = null;
  let benchmarkBase = null;
  let benchmarkPeak = null;
  let strategyPeak = initialCapital;
  let drawdownDuration = 0;
  let maxDrawdownDuration = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  rows.forEach((row, index) => {
    const balance = toNumber(row.balance, prevBalance);
    const pnl = toNumber(row.netPnl);
    const benchmarkValue =
      row.benchmark == null ? null : toNumber(row.benchmark);

    strategyPeak = Math.max(strategyPeak, balance);
    const strategyDrawdown = strategyPeak
      ? ((balance - strategyPeak) / strategyPeak) * 100
      : 0;
    if (strategyDrawdown < 0) {
      drawdownDuration += 1;
      maxDrawdownDuration = Math.max(maxDrawdownDuration, drawdownDuration);
    } else {
      drawdownDuration = 0;
    }

    const strategyRate = prevBalance
      ? ((balance - prevBalance) / prevBalance) * 100
      : 0;
    const strategyReturn = initialCapital
      ? ((balance - initialCapital) / initialCapital) * 100
      : 0;

    let benchmarkReturn = 0;
    let benchmarkRate = 0;
    let benchmarkDrawdown = 0;

    if (benchmarkValue != null) {
      if (benchmarkBase == null) {
        benchmarkBase = benchmarkValue || 1;
      }
      benchmarkPeak =
        benchmarkPeak == null
          ? benchmarkValue
          : Math.max(benchmarkPeak, benchmarkValue);
      benchmarkReturn = benchmarkBase
        ? ((benchmarkValue - benchmarkBase) / benchmarkBase) * 100
        : 0;
      benchmarkRate = prevBenchmark
        ? ((benchmarkValue - prevBenchmark) / prevBenchmark) * 100
        : 0;
      benchmarkDrawdown = benchmarkPeak
        ? ((benchmarkValue - benchmarkPeak) / benchmarkPeak) * 100
        : 0;
      prevBenchmark = benchmarkValue;
    }

    performancePoints.push({
      date: row.date ?? `${index + 1}`,
      strategyReturn,
      benchmarkReturn,
      excessReturn: strategyReturn - benchmarkReturn,
    });
    returnRatePoints.push({
      date: row.date ?? `${index + 1}`,
      strategyRate,
      benchmarkRate,
    });
    drawdownPoints.push({
      date: row.date ?? `${index + 1}`,
      strategyDrawdown,
      benchmarkDrawdown,
    });

    if (index > 0) {
      dailyReturns.push(strategyRate / 100);
      if (benchmarkValue != null) {
        const benchmarkDailyRate = benchmarkRate / 100;
        strategyDailyWithBenchmark.push(strategyRate / 100);
        benchmarkDailyReturns.push(benchmarkDailyRate);
        excessDailyReturns.push(strategyRate / 100 - benchmarkDailyRate);
      }
      if (strategyRate < 0) {
        negativeReturns.push(strategyRate / 100);
      }
    }

    pnlValues.push(pnl);
    if (pnl > 0) {
      currentWins += 1;
      currentLosses = 0;
    } else if (pnl < 0) {
      currentLosses += 1;
      currentWins = 0;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
    maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    prevBalance = balance;
  });

  const positivePnls = pnlValues.filter((item) => item > 0);
  const negativePnls = pnlValues.filter((item) => item < 0);
  const nonZeroTradeCount = pnlValues.filter((item) => item !== 0).length;
  const winRate = nonZeroTradeCount
    ? (positivePnls.length / nonZeroTradeCount) * 100
    : 0;
  const profitFactor = negativePnls.length
    ? positivePnls.reduce((sum, item) => sum + item, 0) /
      Math.abs(negativePnls.reduce((sum, item) => sum + item, 0))
    : 0;
  const volatility = standardDeviation(dailyReturns) * Math.sqrt(252) * 100;
  const sortino = negativeReturns.length
    ? (average(dailyReturns) / (standardDeviation(negativeReturns) || 1e-9)) *
      Math.sqrt(252)
    : 0;
  const recoveryFactor = maxDrawdownPct
    ? Math.abs(totalReturnPct / maxDrawdownPct)
    : 0;
  const calmar = maxDrawdownPct
    ? Math.abs(annualReturnPct / maxDrawdownPct)
    : 0;
  const avgProfit = positivePnls.length ? average(positivePnls) : 0;
  const avgLoss = negativePnls.length ? Math.abs(average(negativePnls)) : 0;
  const expectancy = pnlValues.length ? average(pnlValues) : 0;
  const cumulativePnl = endBalance - initialCapital;
  const feeRate = toNumber(
    summary?.rate ?? run?.rate ?? summary?.parameters?.rate ?? 0,
  );
  const totalTurnover = trades.reduce(
    (sum, trade) =>
      sum + Math.abs(toNumber(trade.price) * toNumber(trade.volume)),
    0,
  );
  const totalCommission = trades.reduce(
    (sum, trade) => sum + Math.abs(toNumber(trade.commission)),
    0,
  );
  const totalTax = trades.reduce(
    (sum, trade) => sum + Math.abs(toNumber(trade.tax ?? trade.stampDuty)),
    0,
  );
  const totalImpactCost = trades.reduce(
    (sum, trade) => sum + Math.abs(toNumber(trade.impactCost)),
    0,
  );
  const totalSlippageCost = trades.reduce(
    (sum, trade) => sum + Math.abs(toNumber(trade.slippageCost)),
    0,
  );
  const totalFeeFromTrades = trades.reduce((sum, trade) => {
    const transactionCost = trade.transactionCost;
    if (transactionCost == null) {
      return sum;
    }
    return sum + Math.abs(toNumber(transactionCost));
  }, 0);
  const totalFee =
    totalFeeFromTrades > 0 ? totalFeeFromTrades : totalTurnover * feeRate;
  const tradeDays = rows.length;
  const hasBenchmarkSeries = benchmarkBase != null;
  const benchmarkTotalReturn = hasBenchmarkSeries
    ? toNumber(performancePoints.at(-1)?.benchmarkReturn)
    : null;
  const excessTotalReturn =
    benchmarkTotalReturn == null ? null : totalReturnPct - benchmarkTotalReturn;
  const marketContributionPnl =
    benchmarkTotalReturn == null
      ? null
      : initialCapital * (benchmarkTotalReturn / 100);
  const excessContributionPnl =
    marketContributionPnl == null
      ? null
      : cumulativePnl - marketContributionPnl;

  const rfAnnual = 0.02;
  const rfDaily = rfAnnual / 252;
  const benchmarkVariance = variance(benchmarkDailyReturns);
  const beta =
    benchmarkVariance > 0
      ? covariance(strategyDailyWithBenchmark, benchmarkDailyReturns) /
        benchmarkVariance
      : null;
  const alpha =
    beta == null
      ? null
      : (average(strategyDailyWithBenchmark) -
          rfDaily -
          beta * (average(benchmarkDailyReturns) - rfDaily)) *
        252 *
        100;
  const infoRatio =
    standardDeviation(excessDailyReturns) > 0
      ? (average(excessDailyReturns) / standardDeviation(excessDailyReturns)) *
        Math.sqrt(252)
      : null;
  const treynor =
    beta == null || Math.abs(beta) < 1e-9
      ? null
      : (annualReturnPct / 100 - rfAnnual) / beta;

  return {
    endBalance,
    initialCapital,
    totalReturnPct,
    annualReturnPct,
    maxDrawdownPct,
    performancePoints,
    returnRatePoints,
    drawdownPoints,
    winRate,
    profitFactor,
    volatility,
    sortino,
    maxDrawdownDuration,
    recoveryFactor,
    calmar,
    avgProfit,
    avgLoss,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    expectancy,
    cumulativePnl,
    totalTurnover,
    totalFee,
    totalCommission,
    totalTax,
    totalImpactCost,
    totalSlippageCost,
    tradeDays,
    benchmarkTotalReturn,
    excessTotalReturn,
    marketContributionPnl,
    excessContributionPnl,
    alpha,
    beta,
    infoRatio,
    treynor,
    riskFreeRate: rfAnnual * 100,
  };
}

export const detailMetadata = {
  标的: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "回测使用的股票代码，用来确认不同结果是否在比较同一只标的。",
  },
  回测区间: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测实际使用的开始日期和结束日期。",
  },
  基准配置: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测使用的对比基准指数。",
  },
  复权方式: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description:
      "当前回测使用的复权口径（前复权/后复权/不复权）。当前项目里的前复权默认以当次取数时点作为锚点，用来避免未来函数。",
  },
  仓位模式: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测使用固定股数还是按资金比例下单。",
  },
  固定股数: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "固定股数模式下，每次计划买入的股数。",
  },
  资金占比: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "按资金比例模式下，每次计划使用的资金比例。",
  },
  现金保留: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "账户中保留不参与建仓的现金比例。",
  },
  止损: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "单笔持仓触发止损时使用的阈值。",
  },
  止盈: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "单笔持仓触发止盈时使用的阈值。",
  },
  移动止损: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "单笔持仓达到高点后回撤触发平仓的阈值。",
  },
  滑点模式: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测使用按比例还是按固定价差模拟滑点。",
  },
  滑点值: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测使用的滑点数值。",
  },
  开仓佣金率: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "买入成交时使用的佣金费率。",
  },
  平仓佣金率: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "卖出成交时使用的佣金费率。",
  },
  最低佣金: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "单笔成交至少收取的佣金。",
  },
  印花税率: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "卖出时使用的印花税费率。",
  },
  冲击成本设定: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "本次回测配置里的冲击成本设定值。",
  },
  策略参数: {
    section: "实验配置",
    surfaces: ["backtest", "comparison"],
    description: "策略自身附加参数的快照，便于横向比较不同配置。",
  },
  累计收益率: {
    section: "收益表现",
    surfaces: ["comparison"],
    description: "回测区间内策略累计收益百分比。",
  },
  年化收益率: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "将区间收益折算为年化后的收益率。",
  },
  超额收益率: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "策略累计收益率减去基准收益率。",
  },
  基准收益率: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "同一时期所选基准指数的累计收益百分比。",
  },
  市场贡献金额: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "按基准收益率折算到期初资金后的收益贡献金额。",
  },
  超额贡献金额: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "策略累计盈亏中，扣除市场贡献后剩余的超额贡献金额。",
  },
  累计盈亏: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "期末资金减去期初资金后的绝对盈亏金额。",
  },
  期初资金: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "回测开始时账户可用的初始资金规模。",
  },
  期末资金: {
    section: "收益表现",
    surfaces: ["backtest", "comparison"],
    description: "回测结束时账户总权益（含持仓与现金）。",
  },
  最大回撤: {
    section: "收益表现",
    surfaces: ["comparison"],
    description: "资金从历史高点回落到低点的最大跌幅。",
  },
  夏普比率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "单位总风险对应的超额收益能力，越高越好。",
  },
  卡玛比率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "年化收益率与最大回撤之比，用于衡量回撤效率。",
  },
  索提诺比率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "只考虑下行风险后的风险收益比，越高越好。",
  },
  盈利因子: {
    section: "风险指标",
    surfaces: ["comparison"],
    description: "总盈利与总亏损绝对值之比，大于 1 通常更稳健。",
  },
  胜率: {
    section: "风险指标",
    surfaces: ["comparison"],
    description: "盈利交易日占全部非零收益交易日的比例。",
  },
  年化波动率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "收益率标准差折算到年化后的波动水平。",
  },
  Alpha: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "扣除市场风险后，策略相对基准获得的超额回报能力。",
  },
  Beta: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "策略对市场波动的敏感度，1 表示与市场同幅波动。",
  },
  信息比率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "策略相对基准超额收益的稳定性指标。",
  },
  特雷诺比率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "单位系统性风险对应的超额收益。",
  },
  最大回撤时长: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "从回撤开始到创新高前的最长持续天数。",
  },
  恢复因子: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "累计收益与最大回撤的比值，衡量回撤修复效率。",
  },
  无风险利率: {
    section: "风险指标",
    surfaces: ["backtest", "comparison"],
    description: "用于风险收益指标计算的无风险收益假设。",
  },
  信号命中率: {
    section: "交易表现",
    surfaces: ["comparison"],
    description: "已完成交易对中，最终盈利的比例。",
  },
  总交易次数: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "回测期间完成的交易笔数。",
  },
  交易天数: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "回测区间内参与统计的交易日数量。",
  },
  平均持仓天数: {
    section: "交易表现",
    surfaces: ["comparison"],
    description: "每笔已完成交易从买入到卖出的平均持有时长。",
  },
  最长持仓: {
    section: "交易表现",
    surfaces: ["comparison"],
    description: "单笔已完成交易中持有时间最长的天数。",
  },
  "最好一笔 / 最差一笔": {
    section: "交易表现",
    surfaces: ["comparison"],
    description: "单笔交易中盈利最高与亏损最大的结果对比。",
  },
  累计成交额: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "所有成交金额的累计值，可用来观察策略换手强度。",
  },
  平均盈利: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "所有盈利样本的平均盈利金额。",
  },
  平均亏损: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "所有亏损样本的平均亏损金额绝对值。",
  },
  最大连续盈利: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "连续盈利样本出现的最长长度。",
  },
  最大连续亏损: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "连续亏损样本出现的最长长度。",
  },
  期望收益: {
    section: "交易表现",
    surfaces: ["backtest", "comparison"],
    description: "每个样本的平均收益，反映长期期望值。",
  },
  佣金: {
    section: "交易成本",
    surfaces: ["comparison"],
    description: "所有交易累计支付的佣金。",
  },
  印花税: {
    section: "交易成本",
    surfaces: ["comparison"],
    description: "所有卖出交易累计支付的印花税。",
  },
  冲击成本: {
    section: "交易成本",
    surfaces: ["comparison"],
    description: "成交时因价格冲击造成的累计成本。",
  },
  滑点成本: {
    section: "交易成本",
    surfaces: ["comparison"],
    description: "订单执行价格偏离理想价格造成的累计成本。",
  },
  总成本: {
    section: "交易成本",
    surfaces: ["comparison"],
    description: "按真实成交成本或成交额估算出的总交易成本。",
  },
};

const detailHintOverrides = {
  复权方式:
    "前复权会把历史价格按回测结束时点做连续化处理；当前实现以本次取数时点为锚点，避免未来函数。",
  滑点模式:
    "按比例时，滑点价差 = 成交价 × 滑点比例；按固定价差时，滑点价差直接等于输入值。",
  滑点值:
    "按比例模式填写小数，例如 0.001 = 0.1%；按固定价差模式直接填写每股价差。滑点成本可近似理解为：成交额 × 滑点比例，或成交股数 × 固定价差。",
  冲击成本设定: "1 bps = 0.01%。冲击成本近似按 成交额 × bps / 10000 计算。",
  策略参数: "策略源码里额外参数的快照，用来对照不同实验配置。",
  超额收益率:
    "计算方式：策略累计收益率 - 基准收益率。用于看策略相对市场基准多赚或少赚了多少。",
  市场贡献金额:
    "计算方式：期初资金 × 基准收益率。表示如果只跟随基准，资金大致会贡献多少收益。",
  超额贡献金额:
    "计算方式：累计盈亏 - 市场贡献金额。表示扣除市场整体上涨或下跌后，策略本身带来的额外盈亏。",
  夏普比率:
    "计算方式：(年化收益率 - 无风险利率) / 年化波动率。当前实现中的无风险利率固定为 2%。",
  卡玛比率:
    "计算方式：|年化收益率 / 最大回撤|。数值越高，说明同样回撤下拿到的年化收益越高。",
  索提诺比率:
    "当前实现按 日均收益率 / 下行收益率标准差 × √252 计算，只把收益低于 0 的交易日计入下行风险。",
  盈利因子:
    "计算方式：总盈利 / |总亏损|。大于 1 通常说明盈利总额高于亏损总额。",
  年化波动率: "计算方式：日收益率标准差 × √252。用于衡量收益波动强度。",
  Alpha:
    "当前实现按 CAPM 口径计算：Alpha = (日均策略收益 - 日无风险收益 - Beta × (日均基准收益 - 日无风险收益)) × 252。",
  Beta: "计算方式：协方差(策略日收益, 基准日收益) / 方差(基准日收益)。1 附近通常表示与基准同幅波动。",
  信息比率:
    "计算方式：日均超额收益 / 超额收益标准差 × √252。用于衡量相对基准的稳定超额收益能力。",
  特雷诺比率:
    "计算方式：(年化收益率 - 无风险利率) / Beta。用于衡量单位系统性风险获得的超额收益。",
  恢复因子: "计算方式：|累计收益率 / 最大回撤|。用于看策略修复回撤的效率。",
  信号命中率:
    "计算方式：盈利交易对数量 / 已完成交易对数量。用于观察信号最终转化为盈利交易的比例。",
  期望收益:
    "计算方式：每笔交易净盈亏的平均值。正值通常意味着长期单笔交易期望为正。",
  冲击成本: "计算方式：所有成交的 impactCost 累加值。",
  滑点成本: "计算方式：所有成交的 slippageCost 累加值。",
  总成本:
    "优先累计每笔成交里的 transactionCost；如果成交里没有该字段，则退化为按累计成交额 × 费率估算。",
};

const detailHintLabels = new Set(Object.keys(detailHintOverrides));

export function buildRunDetailItems(run) {
  const summary = run?.summary ?? null;
  if (!summary) {
    return [];
  }

  const analysis = createRunAnalysis(run);
  const parameterSnapshot = buildParameterSnapshot(run);
  const pairs = buildTradePairs(run);
  const holdingSummary = summarizeRange(pairs.map((item) => item.holdingDays));
  const bestPair = pairs.reduce(
    (best, item) =>
      item.netPnl > (best?.netPnl ?? Number.NEGATIVE_INFINITY) ? item : best,
    null,
  );
  const worstPair = pairs.reduce(
    (worst, item) =>
      item.netPnl < (worst?.netPnl ?? Number.POSITIVE_INFINITY) ? item : worst,
    null,
  );
  const signalHitRate = pairs.length
    ? (pairs.filter((item) => item.netPnl > 0).length / pairs.length) * 100
    : 0;

  return [
    {
      label: "标的",
      value:
        formatOrderBookId(
          summary.symbol ?? run?.symbol,
          summary.exchange ?? run?.exchange,
        ) || "--",
    },
    { label: "回测区间", value: parameterSnapshot.period },
    { label: "基准配置", value: parameterSnapshot.benchmark },
    { label: "复权方式", value: parameterSnapshot.adjust },
    { label: "仓位模式", value: parameterSnapshot.sizingMode },
    { label: "固定股数", value: parameterSnapshot.fixedSize },
    { label: "资金占比", value: parameterSnapshot.positionPct },
    { label: "现金保留", value: parameterSnapshot.cashReservePct },
    { label: "止损", value: parameterSnapshot.stopLossPct },
    { label: "止盈", value: parameterSnapshot.takeProfitPct },
    { label: "移动止损", value: parameterSnapshot.trailingStopPct },
    { label: "滑点模式", value: parameterSnapshot.slippageMode },
    { label: "滑点值", value: parameterSnapshot.slippageValue },
    { label: "开仓佣金率", value: parameterSnapshot.openCommissionRate },
    { label: "平仓佣金率", value: parameterSnapshot.closeCommissionRate },
    { label: "最低佣金", value: parameterSnapshot.minCommission },
    { label: "印花税率", value: parameterSnapshot.stampDutyRate },
    { label: "冲击成本设定", value: parameterSnapshot.impactCostBps },
    { label: "策略参数", value: parameterSnapshot.strategyParams },
    {
      label: "累计收益率",
      value: formatSignedPercent(analysis.totalReturnPct),
    },
    {
      label: "年化收益率",
      value: formatSignedPercent(analysis.annualReturnPct),
    },
    {
      label: "超额收益率",
      value:
        analysis.excessTotalReturn == null
          ? "--"
          : formatSignedPercent(analysis.excessTotalReturn),
    },
    {
      label: "基准收益率",
      value:
        analysis.benchmarkTotalReturn == null
          ? "--"
          : formatSignedPercent(analysis.benchmarkTotalReturn),
    },
    {
      label: "市场贡献金额",
      value:
        analysis.marketContributionPnl == null
          ? "--"
          : formatCurrency(analysis.marketContributionPnl),
    },
    {
      label: "超额贡献金额",
      value:
        analysis.excessContributionPnl == null
          ? "--"
          : formatCurrency(analysis.excessContributionPnl),
    },
    { label: "累计盈亏", value: formatCurrency(analysis.cumulativePnl) },
    { label: "期初资金", value: formatCurrency(analysis.initialCapital) },
    { label: "期末资金", value: formatCurrency(analysis.endBalance) },
    { label: "最大回撤", value: formatPercent(analysis.maxDrawdownPct) },
    { label: "夏普比率", value: formatRatio(summary.sharpeRatio) },
    { label: "卡玛比率", value: formatRatio(analysis.calmar) },
    { label: "索提诺比率", value: formatRatio(analysis.sortino) },
    { label: "盈利因子", value: formatRatio(analysis.profitFactor) },
    { label: "胜率", value: formatPercent(analysis.winRate) },
    { label: "信号命中率", value: formatPercent(signalHitRate) },
    {
      label: "总交易次数",
      value: summary.totalTradeCount ?? run?.artifacts?.trades?.length ?? 0,
    },
    { label: "交易天数", value: analysis.tradeDays },
    { label: "平均持仓天数", value: `${holdingSummary.average.toFixed(1)} 天` },
    { label: "最长持仓", value: `${holdingSummary.max} 天` },
    {
      label: "最好一笔 / 最差一笔",
      value: `${formatCurrency(bestPair?.netPnl ?? 0)} / ${formatCurrency(worstPair?.netPnl ?? 0)}`,
    },
    { label: "累计成交额", value: formatCurrency(analysis.totalTurnover) },
    { label: "平均盈利", value: formatCurrency(analysis.avgProfit) },
    { label: "平均亏损", value: formatCurrency(analysis.avgLoss) },
    { label: "最大连续盈利", value: analysis.maxConsecutiveWins },
    { label: "最大连续亏损", value: analysis.maxConsecutiveLosses },
    { label: "期望收益", value: formatCurrency(analysis.expectancy) },
    { label: "佣金", value: formatCurrency(analysis.totalCommission) },
    { label: "印花税", value: formatCurrency(analysis.totalTax) },
    { label: "冲击成本", value: formatCurrency(analysis.totalImpactCost) },
    { label: "滑点成本", value: formatCurrency(analysis.totalSlippageCost) },
    { label: "总成本", value: formatCurrency(analysis.totalFee) },
    { label: "年化波动率", value: formatPercent(analysis.volatility) },
    {
      label: "Alpha",
      value: analysis.alpha == null ? "--" : formatPercent(analysis.alpha),
    },
    {
      label: "Beta",
      value: analysis.beta == null ? "--" : formatRatio(analysis.beta),
    },
    {
      label: "信息比率",
      value:
        analysis.infoRatio == null ? "--" : formatRatio(analysis.infoRatio),
    },
    {
      label: "特雷诺比率",
      value: analysis.treynor == null ? "--" : formatRatio(analysis.treynor),
    },
    { label: "最大回撤时长", value: `${analysis.maxDrawdownDuration} 天` },
    { label: "恢复因子", value: formatRatio(analysis.recoveryFactor) },
    { label: "无风险利率", value: formatPercent(analysis.riskFreeRate) },
  ].map((item) => ({
    ...item,
    section: detailMetadata[item.label]?.section ?? "其他",
    surfaces: detailMetadata[item.label]?.surfaces ?? [
      "backtest",
      "comparison",
    ],
    description: detailHintLabels.has(item.label)
      ? (detailHintOverrides[item.label] ??
        detailMetadata[item.label]?.description ??
        "")
      : "",
  }));
}

export function filterRunDetailItemsBySurface(run, surface) {
  return buildRunDetailItems(run).filter((item) =>
    item.surfaces.includes(surface),
  );
}

export function buildTradePairs(run) {
  const trades = run?.artifacts?.trades ?? [];
  const lots = [];
  const pairs = [];

  trades.forEach((trade) => {
    const direction = String(trade.direction ?? "").toLowerCase();
    const volume = toNumber(trade.volume);
    const price = toNumber(trade.price);
    const tradeDate = toDateString(trade.datetime);
    const totalCost = Math.abs(toNumber(trade.transactionCost));

    if (direction.includes("long") || direction.includes("buy")) {
      lots.push({
        entryDate: tradeDate,
        entryDatetime: trade.datetime,
        entryPrice: price,
        initialVolume: volume,
        remainingVolume: volume,
        entryCost: totalCost,
      });
      return;
    }

    if (!(direction.includes("short") || direction.includes("sell"))) {
      return;
    }

    let remainingToClose = volume;
    while (remainingToClose > 0 && lots.length) {
      const lot = lots[0];
      const matchedVolume = Math.min(lot.remainingVolume, remainingToClose);
      const entryTurnover = lot.entryPrice * matchedVolume;
      const exitTurnover = price * matchedVolume;
      const entryCost =
        lot.entryCost *
        (matchedVolume / Math.max(lot.initialVolume, matchedVolume));
      const exitCost =
        totalCost * (matchedVolume / Math.max(volume, matchedVolume));
      const grossPnl = exitTurnover - entryTurnover;
      const netPnl = grossPnl - entryCost - exitCost;
      pairs.push({
        entryDate: lot.entryDate,
        exitDate: tradeDate,
        entryDatetime: lot.entryDatetime,
        exitDatetime: trade.datetime,
        entryPrice: lot.entryPrice,
        exitPrice: price,
        volume: matchedVolume,
        holdingDays: diffDays(lot.entryDate, tradeDate),
        grossPnl,
        netPnl,
        returnPct: entryTurnover ? (netPnl / entryTurnover) * 100 : 0,
        entryCost,
        exitCost,
        totalCost: entryCost + exitCost,
      });

      lot.remainingVolume -= matchedVolume;
      remainingToClose -= matchedVolume;
      if (lot.remainingVolume <= 0) {
        lots.shift();
      }
    }
  });

  return pairs;
}

export function buildMonthlyReturnRows(run) {
  const monthly = Array.isArray(run?.artifacts?.monthlyReturns)
    ? run.artifacts.monthlyReturns
    : [];
  if (monthly.length) {
    return monthly.map((item) => ({
      month: item.month,
      returnPct: toNumber(item.returnPct) * 100,
    }));
  }

  const daily = run?.artifacts?.daily ?? [];
  const byMonth = new Map();
  daily.forEach((row) => {
    const date = toDateString(row.date ?? row.datetime);
    const monthKey = date.slice(0, 7);
    if (!monthKey) {
      return;
    }
    const balance = toNumber(row.balance);
    const current = byMonth.get(monthKey) ?? { first: balance, last: balance };
    current.first = current.first || balance;
    current.last = balance;
    byMonth.set(monthKey, current);
  });

  return [...byMonth.entries()].map(([month, item]) => ({
    month,
    returnPct: item.first ? ((item.last - item.first) / item.first) * 100 : 0,
  }));
}

export function buildYearlyReturnRows(run) {
  const yearlyMap = new Map();
  buildMonthlyReturnRows(run).forEach((row) => {
    const year = row.month.slice(0, 4);
    const current = yearlyMap.get(year) ?? [];
    current.push(toNumber(row.returnPct));
    yearlyMap.set(year, current);
  });

  return [...yearlyMap.entries()].map(([year, values]) => {
    const compounded = values.reduce(
      (acc, value) => acc * (1 + value / 100),
      1,
    );
    return {
      year,
      returnPct: (compounded - 1) * 100,
      positiveMonths: values.filter((item) => item > 0).length,
      negativeMonths: values.filter((item) => item < 0).length,
    };
  });
}

export function buildPerformanceBreakdown(run) {
  const analysis = createRunAnalysis(run);
  const pairs = buildTradePairs(run);
  const holdingSummary = summarizeRange(pairs.map((item) => item.holdingDays));
  const winningPairs = pairs.filter((item) => item.netPnl > 0);
  const losingPairs = pairs.filter((item) => item.netPnl < 0);
  const monthlyRows = buildMonthlyReturnRows(run);
  const yearlyRows = buildYearlyReturnRows(run);

  return {
    pairs,
    holdingSummary,
    winningPairs: winningPairs.length,
    losingPairs: losingPairs.length,
    signalHitRate: pairs.length
      ? (winningPairs.length / pairs.length) * 100
      : 0,
    bestPair: pairs.reduce(
      (best, item) =>
        item.netPnl > (best?.netPnl ?? Number.NEGATIVE_INFINITY) ? item : best,
      null,
    ),
    worstPair: pairs.reduce(
      (worst, item) =>
        item.netPnl < (worst?.netPnl ?? Number.POSITIVE_INFINITY)
          ? item
          : worst,
      null,
    ),
    monthlyRows,
    yearlyRows,
    costBreakdown: [
      { label: "佣金", value: analysis.totalCommission },
      { label: "印花税", value: analysis.totalTax },
      { label: "冲击成本", value: analysis.totalImpactCost },
      { label: "滑点成本", value: analysis.totalSlippageCost },
      { label: "总成本", value: analysis.totalFee },
    ],
  };
}
