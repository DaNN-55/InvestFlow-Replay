import Decimal from "decimal.js";

// Pure value calculations only. Scheduling, cancellation and persistence belong to later stages.
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
export const CRYPTO_RULE_VERSION = "okx-usdt-swap-training-2026-10-19-v1";
export const TEACHING_LIQUIDATION_VERSION = "isolated-full-loss-teaching-v1";
const money = (value) => {
  const rounded = new D(value).toDecimalPlaces(8);
  return rounded.isZero() ? "0.00000000" : rounded.toFixed(8);
};
const roundedMoney = (value) => new D(money(value));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function decimal(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
    || value.replace(/[-.]/g, "").length > 32) {
    fail("INVALID_DECIMAL", `${label} must be a plain decimal string (at most 32 digits) or a safe integer`);
  }
  return new D(value);
}
function positive(value, label) {
  const result = decimal(value, label);
  if (result.lte(0)) fail("NON_POSITIVE", `${label} must be positive`);
  return result;
}
function cash(value, label) {
  const result = decimal(value, label);
  if (result.decimalPlaces() > 8) fail("MONEY_PRECISION", `${label} must have at most 8 decimal places`);
  return result;
}
function oneOf(value, choices, label) {
  if (!choices.includes(value)) fail("INVALID_ENUM", `${label} must be one of ${choices.join(", ")}`);
  return value;
}

/**
 * Pass a frozen rule manifest explicitly; this module never loads files or accesses a ledger.
 * Decimal inputs are strings; all cash outputs are 8-place strings. Inputs are never mutated.
 * This P1 calculator does not execute orders, schedule funding or provide retry/idempotency.
 */
export function createCryptoCalculator({ rules, instrumentId }) {
  const snapshot = structuredClone(rules);
  if (snapshot?.ruleVersion !== CRYPTO_RULE_VERSION
    || snapshot.scope?.exchange !== "OKX" || snapshot.scope?.instType !== "SWAP"
    || snapshot.scope?.marginMode !== "isolated" || snapshot.scope?.positionMode !== "net_mode") {
    fail("UNSUPPORTED_RULES", "Expected the confirmed OKX isolated one-way rule version");
  }
  oneOf(instrumentId, ["BTC-USDT-SWAP", "ETH-USDT-SWAP"], "instrumentId");
  const instrument = snapshot.instruments?.[instrumentId];
  const spec = instrument?.spec;
  const execution = snapshot.executionAssumptions;
  if (!spec || spec.instId !== instrumentId || spec.ctType !== "linear" || spec.settleCcy !== "USDT"
    || execution?.moneyScale !== 8 || execution.moneyRounding !== "ROUND_HALF_UP"
    || execution.liquidationSettlementDecision?.version !== TEACHING_LIQUIDATION_VERSION) {
    fail("UNSUPPORTED_RULES", "Missing confirmed contract, precision or liquidation model");
  }
  const face = positive(spec.ctVal, "ctVal").times(positive(spec.ctMult, "ctMult"));
  const tick = positive(spec.tickSz, "tickSz");
  const lot = positive(spec.lotSz, "lotSz");
  const minimum = positive(spec.minSz, "minSz");
  const rates = {
    maker: decimal(snapshot.feeBaseline?.makerRate, "makerRate"),
    taker: decimal(snapshot.feeBaseline?.takerRate, "takerRate"),
  };
  if (rates.maker.isNegative() || rates.taker.isNegative() || rates.taker.gte(1)) {
    fail("INVALID_RULES", "Invalid fixed training fee rates");
  }
  if (!Array.isArray(instrument.isolatedPositionTiers) || !instrument.isolatedPositionTiers.length) {
    fail("INVALID_RULES", "Position tiers are required");
  }
  const tiers = instrument.isolatedPositionTiers.map((t, i) => ({
    tier: String(t.tier), min: decimal(t.minSz, "tier min"), max: positive(t.maxSz, "tier max"),
    mmr: positive(t.mmr, "tier mmr"), maxLever: positive(t.maxLever, "tier max leverage"),
    index: i,
  }));
  for (const t of tiers) {
    const previous = tiers[t.index - 1];
    if (t.min.gt(t.max) || t.mmr.plus(rates.taker).gte(1)
      || (!previous && !t.min.isZero()) || (previous && !t.min.eq(previous.max.plus(lot)))) {
      fail("INVALID_RULES", "Position tiers must be ordered, contiguous and usable for liquidation");
    }
  }
  const versions = Object.freeze({ ruleVersion: snapshot.ruleVersion,
    liquidationModelVersion: TEACHING_LIQUIDATION_VERSION, instrumentId });

  function quantity(value) {
    const result = positive(value, "contracts");
    if (result.lt(minimum) || !result.mod(lot).isZero()) fail("INVALID_QUANTITY", "Contracts violate minSz/lotSz");
    return result;
  }
  function tierFor(contracts) {
    const tier = tiers.find((t) => contracts.gte(t.min) && contracts.lte(t.max));
    if (!tier) fail("POSITION_TOO_LARGE", "Contracts exceed the frozen position tiers");
    return tier;
  }
  function price(value) {
    const result = positive(value, "fillPrice");
    if (!result.mod(tick).isZero()) fail("INVALID_PRICE_TICK", "Fill price must match the contract tick");
    return result;
  }
  function readPosition(value) {
    if (!value || value.instrumentId !== instrumentId) fail("INVALID_POSITION", "A position for this instrument is required");
    const contracts = quantity(value.contracts);
    if (value.entryNotional != null && cash(value.entryNotional, "entryNotional").lte(0)) fail("INVALID_POSITION", "Remaining entry cost must be positive");
    return { side: oneOf(value.side, ["long", "short"], "position side"), contracts,
      entry: positive(value.entryPrice, "entryPrice"), margin: cash(value.marginBalance, "marginBalance"),
      hasCost: value.entryNotional != null,
      cost: value.entryNotional == null ? contracts.times(face).times(positive(value.entryPrice, "entryPrice")) : cash(value.entryNotional, "entryNotional"),
      base: contracts.times(face), tier: tierFor(contracts) };
  }
  function positionValue(p, { contracts = p.contracts, margin = p.margin, cost = p.cost } = {}) {
    return { instrumentId, side: p.side, contracts: contracts.toFixed(), entryPrice: p.entry.toFixed(), marginBalance: money(margin),
      ...(p.hasCost ? { entryNotional: money(cost) } : {}) };
  }
  function accountValue(available, position) {
    return { availableBalance: money(available), position };
  }
  function pnl(p, mark) {
    return p.base.times(mark).minus(p.cost).times(p.side === "long" ? 1 : -1);
  }
  function assessPosition(position, markPrice) {
    const p = readPosition(position);
    const mark = positive(markPrice, "markPrice");
    const notional = p.base.times(mark);
    const unrealized = pnl(p, mark);
    const equity = p.margin.plus(unrealized);
    const maintenance = notional.times(p.tier.mmr);
    const requirement = notional.times(p.tier.mmr.plus(rates.taker));
    const denominator = p.base.times(p.side === "long"
      ? p.tier.mmr.plus(rates.taker).minus(1) : p.tier.mmr.plus(rates.taker).plus(1));
    const threshold = (p.side === "long" ? p.margin.minus(p.cost)
      : p.margin.plus(p.cost)).div(denominator);
    return { baseQuantity: p.base.toFixed(), notional: money(notional), tier: p.tier.tier,
      tierMmr: p.tier.mmr.toFixed(), maintenanceMargin: money(maintenance),
      unrealizedPnl: money(unrealized), marginBalance: money(p.margin), positionEquity: money(equity),
      riskRequirement: money(requirement), riskRatio: equity.div(requirement).toFixed(24),
      // Compare unrounded values, never a displayed risk ratio or rounded threshold.
      liquidationRequired: equity.lte(requirement),
      estimatedLiquidationPrice: threshold.gt(0) ? threshold.toFixed(40) : null,
      thresholdStatus: threshold.gt(0) ? "positive-threshold" : "no-positive-threshold" };
  }

  function quoteFill({ contracts: value, fillPrice, liquidityRole, leverage = null }) {
    const contracts = quantity(value);
    const fill = price(fillPrice);
    const role = oneOf(liquidityRole, ["maker", "taker"], "liquidityRole");
    const tier = tierFor(contracts);
    const base = contracts.times(face);
    const notional = base.times(fill);
    let margin = null;
    if (leverage !== null) {
      const ratio = positive(leverage, "leverage");
      if (ratio.lt(1) || ratio.gt(tier.maxLever) || ratio.gt(positive(spec.lever, "spec leverage"))) {
        fail("INVALID_LEVERAGE", "Leverage exceeds the frozen tier or contract limit");
      }
      margin = money(notional.div(ratio));
    }
    return { contracts: contracts.toFixed(), baseQuantity: base.toFixed(), fillPrice: fill.toFixed(tick.decimalPlaces()),
      notional: money(notional), liquidityRole: role, feeRate: rates[role].toFixed(),
      fee: money(notional.times(rates[role])), initialMargin: margin, tier: tier.tier };
  }
  function quoteMarketFill({ action, referencePrice, slippageBps = execution.slippageBps.default, ...args }) {
    oneOf(action, ["buy", "sell"], "action");
    const reference = positive(referencePrice, "referencePrice");
    const bps = decimal(slippageBps, "slippageBps");
    if (!Object.values(execution.slippageBps).some((x) => bps.eq(x))) {
      fail("UNSUPPORTED_SLIPPAGE", "Use the frozen control/default/stress slippage group");
    }
    const raw = reference.times(new D(1).plus(bps.div(10000).times(action === "buy" ? 1 : -1)));
    const fill = raw.toNearest(tick, action === "buy" ? D.ROUND_CEIL : D.ROUND_FLOOR);
    const quoted = quoteFill({ ...args, fillPrice: fill.toFixed(), liquidityRole: "taker" });
    return { ...quoted, slippageBps: bps.toFixed(), slippageAttribution: money(new D(quoted.baseQuantity).times(fill.minus(reference)).abs()) };
  }
  function openPosition(account, { side, leverage, ...fill }) {
    if (account.position != null) fail("POSITION_EXISTS", "Opening requires a flat account; one-way reversal must close first");
    oneOf(side, ["long", "short"], "side");
    if (leverage == null) fail("INVALID_LEVERAGE", "Opening requires explicit leverage");
    const quoted = quoteFill({ ...fill, leverage });
    const available = cash(account.availableBalance, "availableBalance");
    const required = new D(quoted.initialMargin).plus(quoted.fee);
    if (available.lt(required)) fail("INSUFFICIENT_CASH", "Available cash must cover margin and opening fee");
    return { account: accountValue(available.minus(required), { instrumentId, side, contracts: quoted.contracts,
      entryPrice: quoted.fillPrice, marginBalance: quoted.initialMargin }), quote: quoted };
  }
  // P3b: preserve an 8-place remaining entry cost rather than relying on a repeating average.
  function addPosition(account, { side, leverage, ...fill }) {
    const p = readPosition(account.position);
    if (side !== p.side) fail("POSITION_SIDE_MISMATCH", "One-way additions must match the held side");
    if (leverage == null) fail("INVALID_LEVERAGE", "An addition requires explicit leverage");
    const quoted = quoteFill({ ...fill, leverage });
    const total = p.contracts.plus(quoted.contracts);
    quoteFill({ contracts: total.toFixed(), fillPrice: quoted.fillPrice, liquidityRole: fill.liquidityRole, leverage });
    const required = new D(quoted.initialMargin).plus(quoted.fee);
    const available = cash(account.availableBalance, "availableBalance");
    if (available.lt(required)) fail("INSUFFICIENT_CASH", "Available cash must cover the added margin and fee");
    const cost = p.cost.plus(quoted.notional);
    const entry = cost.div(total.times(face)).toSignificantDigits(24);
    return { account: accountValue(available.minus(required), positionValue({ ...p, hasCost: true, entry },
      { contracts: total, margin: p.margin.plus(quoted.initialMargin), cost })), quote: quoted };
  }
  function addMargin(account, amount) {
    const p = readPosition(account.position);
    const available = cash(account.availableBalance, "availableBalance");
    const addition = cash(amount, "amount");
    if (addition.lte(0) || addition.gt(available)) fail("INVALID_TOPUP", "Top-up must be positive and covered by available cash");
    return { account: accountValue(available.minus(addition), positionValue(p, { margin: p.margin.plus(addition) })), amount: money(addition) };
  }
  function settleFunding(account, { markPrice, settledRate }) {
    const p = readPosition(account.position);
    const available = cash(account.availableBalance, "availableBalance");
    const mark = positive(markPrice, "funding markPrice");
    const rate = decimal(settledRate, "settledRate");
    // Positive payment is an expense; funding never consumes outside available cash.
    const payment = roundedMoney(p.base.times(mark).times(rate).times(p.side === "long" ? 1 : -1));
    const position = positionValue(p, { margin: p.margin.minus(payment) });
    return { account: accountValue(available, position), fundingPayment: money(payment),
      risk: assessPosition(position, mark.toFixed()) };
  }
  function reducePosition(account, { contracts, fillPrice, liquidityRole }) {
    const p = readPosition(account.position);
    const closed = quantity(contracts);
    if (closed.gt(p.contracts)) fail("OVER_REDUCTION", "Reduction cannot reverse the position");
    const quote = quoteFill({ contracts, fillPrice, liquidityRole });
    const fraction = closed.div(p.contracts);
    const released = closed.eq(p.contracts) ? p.margin : roundedMoney(p.margin.times(fraction));
    const closedCost = closed.eq(p.contracts) ? p.cost : (p.hasCost ? roundedMoney(p.cost.times(fraction)) : p.cost.times(fraction));
    const realized = roundedMoney((p.hasCost ? closed.times(face).times(fillPrice).minus(closedCost)
      : closed.times(face).times(new D(fillPrice).minus(p.entry))).times(p.side === "long" ? 1 : -1));
    const available = cash(account.availableBalance, "availableBalance").plus(released).plus(realized).minus(quote.fee);
    const remaining = p.contracts.minus(closed);
    // Never invent an insurance credit for a normal exit. Surface a mathematical cash deficit.
    return { account: accountValue(available, remaining.isZero() ? null
      : positionValue(p, { contracts: remaining, margin: p.margin.minus(released), cost: p.cost.minus(closedCost) })),
    releasedMargin: money(released), realizedPnl: money(realized), fee: quote.fee,
    cashDeficit: money(D.max(available.negated(), 0)) };
  }
  function liquidateAfterCancellation(account, { markPrice, modelVersion, ordersCancelled }) {
    if (modelVersion !== TEACHING_LIQUIDATION_VERSION) fail("UNSUPPORTED_LIQUIDATION_MODEL", "An explicit supported liquidation model is required");
    if (ordersCancelled !== true) fail("CANCELLATION_REQUIRED", "Cancel/release related orders before the risk recheck");
    const p = readPosition(account.position);
    const available = cash(account.availableBalance, "availableBalance");
    const risk = assessPosition(account.position, markPrice);
    if (!risk.liquidationRequired) {
      return { status: "not-required", account: accountValue(available, positionValue(p)), risk, settlement: null };
    }
    const mark = positive(markPrice, "markPrice");
    const unrealized = roundedMoney(pnl(p, mark));
    const feeMemo = roundedMoney(p.base.times(mark).times(rates.taker));
    const residual = p.margin.plus(unrealized).minus(feeMemo);
    return { status: "liquidated", account: accountValue(available, null), risk,
      settlement: { ...versions, aggregateSettlementPnl: money(p.margin.negated()),
        equityDelta: money(p.margin.plus(unrealized).negated()), actualLiquidationFillPrice: null,
        officialClearanceFee: null, waiverExcludedFromTradingProfitMetrics: true,
        referenceAmountsAreNonPosting: true,
        reference: { markPrice: mark.toFixed(), pricePnl: money(unrealized), takerFee: money(feeMemo),
          remainingEquityWriteoff: money(D.max(residual, 0)), deficitWaiver: money(D.max(residual.negated(), 0)) } } };
  }
  return Object.freeze({ versions, quoteFill, quoteMarketFill, openPosition, addPosition, reducePosition, addMargin,
    settleFunding, assessPosition, liquidateAfterCancellation,
    floorContracts(value) {
      const requested = decimal(value, "contracts");
      if (requested.isNegative()) fail("INVALID_QUANTITY", "Sizing amount cannot be negative");
      const floored = requested.toNearest(lot, D.ROUND_FLOOR);
      return floored.lt(minimum) ? "0" : floored.toFixed();
    } });
}
