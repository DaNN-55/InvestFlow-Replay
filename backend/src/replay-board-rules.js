// Frozen rules for bar-orders-v2. Old execution models must not call this policy.
export const BOARD_ORDER_MODEL = "bar-orders-v2";
export const isSyntheticReplay = (snapshot) => snapshot?.exchange === "DEMO" && /^DEMO\d{3}\.SYN$/.test(String(snapshot.tsCode)) && snapshot.priceAdjustment?.factorSource === "fixture-generator";
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function replayBoardRules(snapshot, sequence = snapshot?.observationBars) {
  const code = String(snapshot?.tsCode ?? "").toUpperCase();
  const board = /^(600|601|603|605)\d{3}\.SH$|^(000|001|002|003)\d{3}\.SZ$/.test(code) ? "main"
    : /^30[01]\d{3}\.SZ$/.test(code) ? "chinext"
      : /^688\d{3}\.SH$/.test(code) ? "star" : null;
  if (!board) return null;
  const date = snapshot?.bars?.[Number(sequence) - 1]?.tradeDate;
  const oldChiNext = board === "chinext" && date && date < "2020-08-24";
  return { version: "ashare-board-v1", board, label: { main: "主板", chinext: "创业板", star: "科创板" }[board],
    minimumBuy: board === "star" ? 200 : 100, quantityStep: board === "star" ? 1 : 100,
    minimumSell: board === "star" ? 200 : 100,
    maxLimitQuantity: board === "star" ? 100000 : board === "chinext" && !oldChiNext ? 300000 : 1000000,
    maxMarketQuantity: board === "star" ? 50000 : board === "chinext" && !oldChiNext ? 150000 : 1000000 };
}

export function maximumOrderQuantity(rules, type) {
  return type === "limit" ? rules.maxLimitQuantity : rules.maxMarketQuantity;
}

export function quantityError(rules, side, quantity, holding = 0, type = "market", available = holding) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return "委托股数必须为正整数";
  if (quantity > maximumOrderQuantity(rules, type)) return `超过${rules.label}该类单笔申报数量上限`;
  if (side === "buy") {
    if (quantity < rules.minimumBuy || (rules.quantityStep > 1 && quantity % rules.quantityStep)) {
      return rules.board === "star" ? "科创板买入至少200股，超过部分可逐股递增" : `${rules.label}买入须为100股或其整数倍`;
    }
  } else if (rules.board === "star") {
    if (quantity < 200 && quantity !== holding && quantity !== available) return "科创板卖出至少200股；余额不足200股须一次性卖出";
  } else if (quantity % 100 && quantity % 100 !== holding % 100 && quantity % 100 !== available % 100) {
    return "不足100股的零股余额须一次性卖出，不能拆分";
  }
  return "";
}

export function resolveBoardQuantity(order, account, price, costConfig, rules, calculateFees) {
  if (order.quantityType === "shares") return Number(order.requestedQuantity);
  const maximum = maximumOrderQuantity(rules, order.orderType ?? order.state?.orderType);
  if (order.quantityType === "cash_ratio") {
    const budget = Number(account.cash) * Number(order.ratio);
    let quantity = Math.min(maximum, Math.floor(budget / price / rules.quantityStep) * rules.quantityStep);
    while (quantity >= rules.minimumBuy) {
      const notional = quantity * price;
      if (notional + calculateFees(notional, "buy", costConfig).totalFee <= budget) return quantity;
      quantity -= rules.quantityStep;
    }
    return 0;
  }
  const available = Math.floor(account.availableQuantity);
  if (Number(order.ratio) === 1) {
    // A whole-position intent can be executed in capped children; preserve any odd tail.
    return available;
  }
  const quantity = Math.min(maximum, Math.floor(available * order.ratio / rules.quantityStep) * rules.quantityStep);
  return quantity >= rules.minimumSell ? quantity : 0;
}

export function inspectBoardBar(snapshot, bars, sequence) {
  const rules = replayBoardRules(snapshot);
  const bar = bars[sequence - 1];
  if (!bar || ![bar.open, bar.high, bar.low, bar.close].every(positive)) return { status: "invalid_market_data" };
  if (!positive(bar.volume)) return { status: "suspended" };
  const unknown = { status: "rule_unavailable" };
  if (!rules || bar.priceLimitStatus === "unknown") return unknown;
  const date = String(bar.tradeDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return unknown;
  if (bar.noPriceLimit === true) return { status: "normal" };
  const onePrice = [bar.open, bar.high, bar.low, bar.close].every((p) => Number(p) === Number(bar.open));
  // Daily source flags describe the entire daily bar, never all intraday bars of that day.
  const flag = String(bar.limitType ?? "").trim().toUpperCase();
  if (onePrice && String(snapshot.interval ?? "1d") === "1d" && ["U", "D"].includes(flag)) {
    return { status: flag === "U" ? "limit_up" : "limit_down", onePrice: true };
  }
  const multiplier = positive(bar.adjustmentMultiplier) ? Number(bar.adjustmentMultiplier) : 1;
  let reference = Number(bar.rawDailyPreClose ?? bar.rawPreClose);
  if (!positive(reference)) {
    if (snapshot.priceAdjustment) return unknown;
    if (snapshot.interval === "hybrid" || snapshot.interval === "1m") {
      let start = sequence - 1;
      while (start > 0 && bars[start - 1].tradeDate === bar.tradeDate) start -= 1;
      reference = Number(bar.dailyPreClose ?? bars[start - 1]?.close);
    } else reference = Number(bar.preClose ?? bars[sequence - 2]?.close);
  }
  if (!positive(reference)) return unknown;
  const ratio = rules.board === "star" || (rules.board === "chinext" && date >= "2020-08-24") ? 0.2 : 0.1;
  if ((rules.board === "star" && date < "2019-07-22") || date < "1996-12-16") return unknown;
  const upper = positive(bar.rawUpperLimit) ? Number(bar.rawUpperLimit) : Math.max(cents(reference * (1 + ratio)), cents(reference + 0.01));
  const lower = positive(bar.rawLowerLimit) ? Number(bar.rawLowerLimit) : Math.max(0.01, Math.min(cents(reference * (1 - ratio)), cents(reference - 0.01)));
  const rawHigh = Number(bar.rawHigh ?? Number(bar.high) / multiplier);
  const rawLow = Number(bar.rawLow ?? Number(bar.low) / multiplier);
  const rawClose = Number(bar.rawClose ?? Number(bar.close) / multiplier);
  // Do not silently treat exceptional/unlimited sessions as ordinary 10%/20% sessions.
  if (rawHigh > upper + 1e-7 || rawLow < lower - 1e-7) return unknown;
  const missingHistoricRisk = (rules.board === "main" && date < "2026-07-06") || (rules.board === "chinext" && date < "2020-08-24");
  if (missingHistoricRisk && !positive(bar.rawUpperLimit) && !positive(bar.rawLowerLimit) &&
    [cents(reference * 1.05), cents(reference * 0.95)].some((p) => Math.abs(p - upper) > 1e-7 && Math.abs(p - lower) > 1e-7 && rawHigh >= p - 1e-7 && rawLow <= p + 1e-7)) {
    // Only a bar confined to the uncertain 5% boundary is ambiguous; crossing it establishes
    // that it was not locked at that boundary. A current security name cannot establish past ST status.
    if (onePrice) return unknown;
  }
  return { status: Math.abs(rawClose - upper) < 1e-7 ? "limit_up" : Math.abs(rawClose - lower) < 1e-7 ? "limit_down" : "normal", onePrice };
}
