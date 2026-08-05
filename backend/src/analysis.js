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
  if (first.length < 2 || first.length !== second.length) {
    return 0;
  }
  const firstMean = average(first);
  const secondMean = average(second);
  return average(first.map((value, index) => (value - firstMean) * (second[index] - secondMean)));
}

export function buildMetricSnapshot(run) {
  const summary = run?.summary ?? {};
  const daily = run?.artifacts?.daily ?? [];
  const trades = run?.artifacts?.trades ?? [];
  const initialCapital = toNumber(summary.capital ?? run?.capital ?? 0);
  const endBalance = toNumber(summary.endBalance ?? daily.at(-1)?.balance ?? initialCapital);
  const totalReturn = toNumber(summary.totalReturn) * 100;
  const annualReturn = toNumber(summary.annualReturn) * 100;
  const maxDrawdown = Math.abs(toNumber(summary.maxDrawdown) * 100);
  const sharpeRatio = toNumber(summary.sharpeRatio);
  const benchmarkSeries = [];
  const strategySeries = [];
  const excessSeries = [];
  const downsideSeries = [];
  let prevBalance = null;
  let prevBenchmark = null;
  let totalFee = 0;
  let turnover = 0;
  let peak = initialCapital;
  let drawdownDuration = 0;
  let maxDrawdownDuration = 0;

  const pnlValues = daily.map((item) => toNumber(item.netPnl));
  daily.forEach((row) => {
    const balance = toNumber(row.balance, prevBalance ?? initialCapital);
    const benchmark = row.benchmark == null ? null : toNumber(row.benchmark);
    if (prevBalance != null && prevBalance > 0) {
      const dailyReturn = (balance - prevBalance) / prevBalance;
      strategySeries.push(dailyReturn);
      if (dailyReturn < 0) {
        downsideSeries.push(dailyReturn);
      }
      if (benchmark != null && prevBenchmark != null && prevBenchmark > 0) {
        const benchmarkReturn = (benchmark - prevBenchmark) / prevBenchmark;
        benchmarkSeries.push(benchmarkReturn);
        excessSeries.push(dailyReturn - benchmarkReturn);
      }
    }
    peak = Math.max(peak, balance);
    const drawdown = peak ? (balance - peak) / peak : 0;
    if (drawdown < 0) {
      drawdownDuration += 1;
      maxDrawdownDuration = Math.max(maxDrawdownDuration, drawdownDuration);
    } else {
      drawdownDuration = 0;
    }
    prevBalance = balance;
    prevBenchmark = benchmark;
  });

  trades.forEach((trade) => {
    const price = Math.abs(toNumber(trade.price));
    const volume = Math.abs(toNumber(trade.volume));
    turnover += price * volume;
    totalFee += Math.abs(toNumber(trade.transactionCost ?? trade.commission ?? 0));
  });

  const positivePnls = pnlValues.filter((item) => item > 0);
  const negativePnls = pnlValues.filter((item) => item < 0);
  const nonZeroPnls = pnlValues.filter((item) => item !== 0);
  const winRate = nonZeroPnls.length ? (positivePnls.length / nonZeroPnls.length) * 100 : 0;
  const profitFactor = negativePnls.length
    ? positivePnls.reduce((sum, item) => sum + item, 0) / Math.abs(negativePnls.reduce((sum, item) => sum + item, 0))
    : 0;
  const volatility = standardDeviation(strategySeries) * Math.sqrt(252) * 100;
  const sortino = downsideSeries.length
    ? (average(strategySeries) / (standardDeviation(downsideSeries) || 1e-9)) * Math.sqrt(252)
    : 0;
  const rfAnnual = 0.02;
  const rfDaily = rfAnnual / 252;
  const benchmarkVariance = variance(benchmarkSeries);
  const beta = benchmarkVariance > 0 ? covariance(strategySeries.slice(-benchmarkSeries.length), benchmarkSeries) / benchmarkVariance : null;
  const alpha = beta == null
    ? null
    : ((average(strategySeries.slice(-benchmarkSeries.length)) - rfDaily) - beta * (average(benchmarkSeries) - rfDaily)) * 252 * 100;
  const infoRatio = excessSeries.length && standardDeviation(excessSeries) > 0
    ? (average(excessSeries) / standardDeviation(excessSeries)) * Math.sqrt(252)
    : null;

  return {
    totalReturn,
    annualReturn,
    maxDrawdown,
    sharpeRatio,
    winRate,
    profitFactor,
    volatility,
    sortino,
    alpha,
    beta,
    infoRatio,
    cumulativePnl: endBalance - initialCapital,
    endBalance,
    initialCapital,
    totalFee,
    turnover,
    tradeCount: trades.length,
    tradeDays: daily.length,
    avgProfit: positivePnls.length ? average(positivePnls) : 0,
    avgLoss: negativePnls.length ? Math.abs(average(negativePnls)) : 0,
    expectancy: pnlValues.length ? average(pnlValues) : 0,
    maxDrawdownDuration,
  };
}

export function enumerateParameterCombos(parameters, ranges) {
  const active = parameters
    .map((param) => {
      const range = ranges?.[param.name];
      if (!range) {
        return null;
      }
      const start = Math.floor(toNumber(range.start, param.min ?? 1));
      const end = Math.floor(toNumber(range.end, param.max ?? start));
      const step = Math.max(1, Math.floor(toNumber(range.step, param.step ?? 1)));
      const values = [];
      for (let value = start; value <= end; value += step) {
        values.push(value);
      }
      return {
        name: param.name,
        values,
      };
    })
    .filter(Boolean);

  if (!active.length) {
    return [];
  }

  const results = [];
  function walk(index, current) {
    if (index >= active.length) {
      results.push({ ...current });
      return;
    }
    const item = active[index];
    item.values.forEach((value) => {
      current[item.name] = value;
      walk(index + 1, current);
    });
  }
  walk(0, {});
  return results;
}

function hashStringToSeed(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash || 1;
}

function createDeterministicRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function enumerateRandomParameterCombos(parameters, ranges, options = {}) {
  const allCombos = enumerateParameterCombos(parameters, ranges);
  if (!allCombos.length) {
    return {
      combos: [],
      seed: null,
      candidateCombos: 0,
    };
  }

  const requestedCount = Math.max(1, Math.floor(toNumber(options.count, 20)));
  const count = Math.min(requestedCount, allCombos.length, 80);
  const seedInput = options.seed == null ? JSON.stringify(ranges ?? {}) : String(options.seed);
  const seed = hashStringToSeed(seedInput);
  const random = createDeterministicRandom(seed);

  const shuffled = allCombos.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  return {
    combos: shuffled.slice(0, count),
    seed,
    candidateCombos: allCombos.length,
  };
}

export function buildSampleRanges(startDate, endDate, splitRatio = 0.7) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const totalDays = Math.max(Math.round((end - start) / 86400000), 1);
  const inSampleDays = Math.max(30, Math.min(totalDays - 10, Math.floor(totalDays * splitRatio)));
  const split = new Date(start.getTime() + inSampleDays * 86400000);
  const outSampleStart = new Date(split.getTime() + 86400000);
  return {
    inSample: {
      startDate,
      endDate: split.toISOString().slice(0, 10),
    },
    outSample: {
      startDate: outSampleStart.toISOString().slice(0, 10),
      endDate,
    },
  };
}

export function buildRollingRanges(startDate, endDate, windowDays = 120, stepDays = 40) {
  const ranges = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let cursor = new Date(start);
  let index = 0;

  while (cursor < end) {
    const segmentStart = new Date(cursor);
    const segmentEnd = new Date(Math.min(end.getTime(), segmentStart.getTime() + windowDays * 86400000));
    if (segmentEnd <= segmentStart) {
      break;
    }
    ranges.push({
      label: `窗口 ${index + 1}`,
      startDate: segmentStart.toISOString().slice(0, 10),
      endDate: segmentEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(cursor.getTime() + stepDays * 86400000);
    index += 1;
    if (ranges.length > 24) {
      break;
    }
  }

  return ranges;
}

export function createIntegrityReport({ bars = [], run = null, startDate = "", endDate = "", adjustComparisons = [] }) {
  const issues = [];
  const normalizedStart = startDate || run?.summary?.startDate || run?.startDate || "";
  const normalizedEnd = endDate || run?.summary?.endDate || run?.endDate || "";
  const suspensionDates = [];
  const longGapRanges = [];
  let duplicateCount = 0;
  let invalidPriceCount = 0;
  let unorderedCount = 0;
  let longGapCount = 0;

  function shiftIsoDate(value, offsetDays) {
    if (!value) {
      return "";
    }
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  if (!bars.length) {
    issues.push({
      severity: "error",
      code: "missing_bars",
      message: "当前区间没有可用行情数据。",
    });
  } else {
    const firstBar = String(bars[0]?.datetime ?? "").slice(0, 10);
    const lastBar = String(bars.at(-1)?.datetime ?? "").slice(0, 10);
    const seenDates = new Set();

    if (normalizedStart && firstBar > normalizedStart) {
      issues.push({
        severity: "error",
        code: "start_gap",
        message: `行情起点晚于回测开始时间，当前从 ${firstBar} 才开始。`,
        details: {
          ranges: [
            {
              missingStartDate: normalizedStart,
              missingEndDate: shiftIsoDate(firstBar, -1),
              nextBarDate: firstBar,
            },
          ],
        },
      });
    }
    if (normalizedEnd && lastBar < normalizedEnd) {
      issues.push({
        severity: "error",
        code: "end_gap",
        message: `行情终点早于回测结束时间，当前只到 ${lastBar}。`,
        details: {
          ranges: [
            {
              previousBarDate: lastBar,
              missingStartDate: shiftIsoDate(lastBar, 1),
              missingEndDate: normalizedEnd,
            },
          ],
        },
      });
    }

    for (let index = 0; index < bars.length; index += 1) {
      const current = bars[index] ?? {};
      const currentDate = String(current.datetime ?? "").slice(0, 10);
      const open = Number(current.open ?? 0);
      const high = Number(current.high ?? 0);
      const low = Number(current.low ?? 0);
      const close = Number(current.close ?? 0);
      const volume = Number(current.volume ?? 0);

      if (seenDates.has(currentDate)) {
        duplicateCount += 1;
      }
      seenDates.add(currentDate);

      if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || high < low || high < open || high < close || low > open || low > close) {
        invalidPriceCount += 1;
      }
      if (volume <= 0) {
        suspensionDates.push(currentDate);
      }

      if (index > 0) {
        const prevDate = String(bars[index - 1]?.datetime ?? "").slice(0, 10);
        if (currentDate <= prevDate) {
          unorderedCount += 1;
        }
        const gapDays = Math.round((new Date(`${currentDate}T00:00:00Z`) - new Date(`${prevDate}T00:00:00Z`)) / 86400000);
        if (gapDays > 5) {
          longGapCount += 1;
          longGapRanges.push({
            previousBarDate: prevDate,
            nextBarDate: currentDate,
            missingStartDate: shiftIsoDate(prevDate, 1),
            missingEndDate: shiftIsoDate(currentDate, -1),
            gapDays,
            missingCalendarDays: Math.max(gapDays - 1, 0),
          });
        }
      }
    }

    if (unorderedCount > 0) {
      issues.push({
        severity: "warn",
        code: "unordered_bars",
        message: `发现 ${unorderedCount} 处时间顺序异常。`,
      });
    }
    if (duplicateCount > 0) {
      issues.push({
        severity: "warn",
        code: "duplicate_dates",
        message: `发现 ${duplicateCount} 条重复日期的 K 线记录。`,
      });
    }
    if (longGapCount > 0) {
      issues.push({
        severity: "warn",
        code: "long_gaps",
        message: `发现 ${longGapCount} 处超过 5 天的时间断档，建议确认是否存在缺失交易日。`,
        details: {
          ranges: longGapRanges,
        },
      });
    }
    if (invalidPriceCount > 0) {
      issues.push({
        severity: "error",
        code: "invalid_prices",
        message: `发现 ${invalidPriceCount} 条价格字段异常的 K 线。`,
      });
    }
    if (suspensionDates.length > 0) {
      issues.push({
        severity: "warn",
        code: "zero_volume_days",
        message: `发现 ${suspensionDates.length} 个疑似停牌或无成交日期。`,
      });
    }
  }

  if (adjustComparisons.length > 1) {
    const comparisonErrors = adjustComparisons.filter((item) => item.error);
    if (comparisonErrors.length) {
      issues.push({
        severity: "warn",
        code: "adjust_check_failed",
        message: `有 ${comparisonErrors.length} 种复权口径的数据检查失败，当前完整性结果已按可用数据继续生成。`,
      });
    }
    const counts = [...new Set(adjustComparisons.map((item) => Number(item.bars ?? 0)))];
    const firstDates = [...new Set(adjustComparisons.map((item) => item.firstBarDate ?? ""))];
    const lastDates = [...new Set(adjustComparisons.map((item) => item.lastBarDate ?? ""))];
    if (counts.length > 1 || firstDates.length > 1 || lastDates.length > 1) {
      issues.push({
        severity: "warn",
        code: "adjust_mismatch",
        message: "不同复权口径下的数据覆盖范围不一致，建议确认同步口径是否完整。",
      });
    }
  }

  const trades = run?.artifacts?.trades ?? [];
  if (trades.length && bars.length) {
    const firstTrade = String(trades[0]?.datetime ?? "").slice(0, 10);
    const firstBar = String(bars[0]?.datetime ?? "").slice(0, 10);
    const lastBar = String(bars.at(-1)?.datetime ?? "").slice(0, 10);
    if (firstTrade < firstBar || firstTrade > lastBar) {
      issues.push({
        severity: "error",
        code: "trade_outside_bars",
        message: `成交记录最早日期 ${firstTrade} 不在当前 K 线区间内。`,
      });
    }
  }

  return {
    ok: !issues.some((item) => item.severity === "error"),
    issues,
    summary: {
      bars: bars.length,
      startDate: normalizedStart,
      endDate: normalizedEnd,
      firstBarDate: bars.length ? String(bars[0].datetime).slice(0, 10) : null,
      lastBarDate: bars.length ? String(bars.at(-1).datetime).slice(0, 10) : null,
      tradeCount: trades.length,
      suspensionDays: suspensionDates.length,
      adjustComparisons,
    },
  };
}
