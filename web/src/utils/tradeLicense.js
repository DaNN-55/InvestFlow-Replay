function toFiniteNumber(value) {
  if (value === "" || value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function floorPrice(value) {
  return Math.floor((value + Number.EPSILON) * 100) / 100;
}

function error(code, message, fields = []) {
  return { code, message, fields };
}

const TRADE_RECORD_DRAFT_FIELDS = [
  "accountType",
  "tradeType",
  "manualMaxAccountRiskPct",
  "manualMaxPositionPct",
  "validForTradeDate",
  "triggerPrice",
  "failurePrice",
  "targetPrice",
  "entryNotes",
];

export function buildTradeRecordDraftSavePayload(form = {}, options = {}) {
  const legacyPositionCap = options.legacyPositionCap === true;
  return Object.fromEntries(TRADE_RECORD_DRAFT_FIELDS.flatMap((field) => {
    const value = form[field];
    if (field === "manualMaxPositionPct" && legacyPositionCap && (value === "" || value == null)) {
      return [];
    }
    return [[field, value === "" || value == null ? null : String(value)]];
  }));
}

export function resolveLegacyTradeRecordPlan(record = {}) {
  return record.tradingPlanSummary
    ?? record.frozenSnapshot?.tradingPlan
    ?? record.evaluationSnapshot?.tradingPlan
    ?? {};
}

export function calculateTradeLicense(input = {}) {
  const triggerPrice = toFiniteNumber(input.triggerPrice);
  const failurePrice = toFiniteNumber(input.failurePrice);
  const targetPrice = toFiniteNumber(input.targetPrice);
  const accountEquity = toFiniteNumber(input.accountEquity);
  const minRewardRiskRatio = toFiniteNumber(input.minRewardRiskRatio);
  const maxAccountRiskPct = toFiniteNumber(input.maxAccountRiskPct);
  const maxPositionPct = toFiniteNumber(input.maxPositionPct);
  const lotSize = Math.floor(toFiniteNumber(input.lotSize) ?? 100);
  const errors = [];

  if ([triggerPrice, failurePrice, targetPrice].some((value) => value == null || value <= 0)) {
    errors.push(error("MISSING_PRICE_ANCHORS", "请完整填写大于 0 的触发价、失败价和目标价。", ["triggerPrice", "failurePrice", "targetPrice"]));
  } else if (!(failurePrice < triggerPrice && triggerPrice < targetPrice)) {
    errors.push(error("INVALID_PRICE_ORDER", "价格必须满足：失败价 < 触发价 < 目标价。", ["failurePrice", "triggerPrice", "targetPrice"]));
  }
  if (accountEquity == null || accountEquity <= 0) {
    errors.push(error("MISSING_ACCOUNT_EQUITY", "请先配置大于 0 的账户本金。", ["accountEquity"]));
  }
  if (minRewardRiskRatio == null || minRewardRiskRatio <= 0) {
    errors.push(error("INVALID_MIN_REWARD_RISK", "最低盈亏比必须大于 0。", ["minRewardRiskRatio"]));
  }
  if (maxAccountRiskPct == null || maxAccountRiskPct <= 0 || maxAccountRiskPct > 100) {
    errors.push(error("INVALID_ACCOUNT_RISK", "单笔风险预算必须大于 0 且不超过 100%。", ["maxAccountRiskPct"]));
  }
  if (maxPositionPct == null || maxPositionPct <= 0 || maxPositionPct > 100) {
    errors.push(error("INVALID_POSITION_CAP", "单票最大仓位必须大于 0 且不超过 100%。", ["maxPositionPct"]));
  }
  if (lotSize <= 0) {
    errors.push(error("INVALID_LOT_SIZE", "每手股数必须大于 0。", ["lotSize"]));
  }
  if (errors.length) {
    return { valid: false, errors };
  }

  const noChasePrice = floorPrice(
    (targetPrice + minRewardRiskRatio * failurePrice) / (1 + minRewardRiskRatio),
  );
  if (noChasePrice < triggerPrice) {
    return {
      valid: false,
      errors: [error("REWARD_RISK_BELOW_MINIMUM", "触发价对应的盈亏比低于系统最低要求。", ["triggerPrice", "failurePrice", "targetPrice"])],
      noChasePrice,
    };
  }

  const riskPerShare = roundMoney(noChasePrice - failurePrice);
  const riskBudgetAmount = roundMoney(accountEquity * maxAccountRiskPct / 100);
  const riskLimitedQuantity = Math.floor(riskBudgetAmount / riskPerShare / lotSize) * lotSize;
  const positionCapAmount = roundMoney(accountEquity * maxPositionPct / 100);
  const positionLimitedQuantity = Math.floor(positionCapAmount / noChasePrice / lotSize) * lotSize;
  const plannedQuantity = Math.min(riskLimitedQuantity, positionLimitedQuantity);
  if (plannedQuantity < lotSize) {
    return {
      valid: false,
      errors: [error("QUANTITY_BELOW_LOT", `风险预算和仓位上限不足以买入 ${lotSize} 股。`, ["accountEquity", "maxAccountRiskPct", "maxPositionPct"])],
      noChasePrice,
      riskBudgetAmount,
      positionCapAmount,
    };
  }

  const plannedAmount = roundMoney(plannedQuantity * noChasePrice);
  const estimatedMaxLossAmount = roundMoney(plannedQuantity * riskPerShare);
  return {
    valid: true,
    errors: [],
    triggerPrice: roundMoney(triggerPrice),
    failurePrice: roundMoney(failurePrice),
    targetPrice: roundMoney(targetPrice),
    plannedEntryLow: roundMoney(triggerPrice),
    plannedEntryHigh: noChasePrice,
    noChasePrice,
    stopLossPrice: roundMoney(failurePrice),
    takeProfitPrice: roundMoney(targetPrice),
    rewardRiskRatioAtTrigger: (targetPrice - triggerPrice) / (triggerPrice - failurePrice),
    rewardRiskRatioAtWorstEntry: (targetPrice - noChasePrice) / (noChasePrice - failurePrice),
    riskPerShare,
    riskBudgetAmount,
    positionCapAmount,
    plannedQuantity,
    plannedAmount,
    estimatedMaxLossAmount,
    plannedPositionPct: plannedAmount / accountEquity * 100,
  };
}
