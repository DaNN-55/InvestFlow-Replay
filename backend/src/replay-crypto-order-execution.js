import Decimal from "decimal.js";
import { createCryptoCalculator, TEACHING_LIQUIDATION_VERSION } from "./replay-crypto-calculations.js";
import { MINUTE_MS, validateCryptoScenario, fundingMarkReference } from "./replay-crypto-scenario.js";

// ADR-0006. New version; P3a snapshots keep their original executor. No IO or business writes.
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
export const CRYPTO_ORDER_EXECUTION_VERSION = "okx-orders-minute-teaching-v1";
const ZERO = "0.00000000";
const money = (v) => { const d = new D(v).toDecimalPlaces(8); return d.isZero() ? ZERO : d.toFixed(8); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function decimal(v) {
  if (typeof v === "number" && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v) || v.replace(/[-.]/g, "").length > 32) fail("INVALID_DECIMAL", "Use a plain decimal string or safe integer");
  return new D(v);
}
function cash(v) { const d = decimal(v); if (d.decimalPlaces() > 8) fail("MONEY_PRECISION", "Use at most 8 money decimals"); return d; }
const TOTALS = ["tradingFees", "fundingPayments", "realizedPricePnl", "liquidationAggregatePnl", "manualTopups", "slippageAttribution", "deficitWaiverMemo"];
const PAUSE = new Set(["order-filled", "order-rejected", "protection-triggered", "protection-filled", "funding-settled", "teaching-liquidation", "end-filled", "training-ended", "end-blocked"]);
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((tail) => [item, ...tail]));
}

export function createCryptoOrderReplay({ rules, scenario: input, dataVersion, slippageBps = null }) {
  if (typeof dataVersion !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(dataVersion)) fail("DATA_VERSION_REQUIRED", "Provide a frozen data version");
  const scenario = structuredClone(input), snapshot = structuredClone(rules);
  validateCryptoScenario(scenario);
  const { instrumentId, window: w } = scenario;
  const calc = createCryptoCalculator({ rules: snapshot, instrumentId });
  const spec = snapshot.instruments[instrumentId].spec, face = new D(spec.ctVal).times(spec.ctMult), tick = new D(spec.tickSz);
  const bps = slippageBps ?? snapshot.executionAssumptions.slippageBps.default;
  const background = (w.replayStartMs - w.backgroundStartMs) / MINUTE_MS;
  const replayMinutes = (w.replayEndMs - w.replayStartMs) / MINUTE_MS, totalMinutes = replayMinutes + 1;
  const bar = (kind, minute) => scenario[kind][background + minute];
  const versions = { ...calc.versions, executionVersion: CRYPTO_ORDER_EXECUTION_VERSION, dataVersion };
  const funding = scenario.funding.filter((f) => f.ts > w.replayStartMs && f.ts <= w.executionEndMs);
  const knownLast = (s) => bar("last", s.elapsedMinutes - 1).close;
  const knownMark = (s) => bar("mark", s.elapsedMinutes - 1).close;
  const direction = (side, reduce) => (side === "long") !== reduce ? "buy" : "sell";
  const marketQuote = (contracts, action, referencePrice, leverage = null) => calc.quoteMarketFill({ contracts, action, referencePrice, leverage, slippageBps: bps });
  marketQuote(spec.minSz, "buy", bar("last", -1).close);
  function quote(contracts, order, price, role, leverage) {
    return role === "taker" ? marketQuote(contracts, direction(order.side, order.intent === "reduce"), price, leverage)
      : { ...calc.quoteFill({ contracts, fillPrice: price, liquidityRole: "maker", leverage }), slippageBps: "0", slippageAttribution: ZERO };
  }
  function emit(events, s, type, values = {}) { events.push({ type, instrumentId, observedAtMinute: s.elapsedMinutes, ...values }); }
  function total(s, key, v) { s.totals[key] = money(new D(s.totals[key]).plus(v)); }
  function equity(s, price) {
    return new D(s.account.availableBalance).plus(s.reservedBalance).plus(s.account.position?.marginBalance ?? 0)
      .plus(s.account.position ? calc.assessPosition(s.account.position, price).unrealizedPnl : 0);
  }
  function summarize(s) {
    s.risk = s.account.position ? calc.assessPosition(s.account.position, knownMark(s)) : null;
    const net = new D(s.totals.realizedPricePnl).minus(s.totals.tradingFees).minus(s.totals.fundingPayments).plus(s.totals.liquidationAggregatePnl);
    const value = equity(s, knownMark(s));
    if (!value.eq(new D(s.startingCash).plus(net).plus(s.risk?.unrealizedPnl ?? 0))) fail("ACCOUNTING_MISMATCH", "Cash/reserve/margin/PnL must reconcile");
    if (!new D(s.reservedBalance).eq(s.orders.reduce((sum, o) => sum.plus(o.reservedBalance), new D(0)))) fail("RESERVE_MISMATCH", "Activity reserves disagree");
    s.summary = { accountEquity: money(value), netPnl: money(value.minus(s.startingCash)), recognizedNetPnl: money(net),
      cashDeficit: money(D.max(new D(s.account.availableBalance).negated(), 0)), waiverExcludedFromTradingProfitMetrics: true };
  }
  function release(s, o) {
    s.account.availableBalance = money(new D(s.account.availableBalance).plus(o.reservedBalance));
    s.reservedBalance = money(new D(s.reservedBalance).minus(o.reservedBalance)); o.reservedBalance = ZERO;
  }
  function cancel(s, events, o, reason) {
    const reserve = o.reservedBalance; release(s, o); s.orders = s.orders.filter((x) => x.id !== o.id);
    emit(events, s, "order-cancelled", { orderId: o.id, reason, unfilledContracts: o.remainingContracts, releasedReserve: reserve });
  }
  function cancelOrders(s, events, reason) { for (const o of [...s.orders]) cancel(s, events, o, reason); }
  function clearProtection(s, events, reason) {
    if (s.protection) emit(events, s, "protection-cancelled", { reason, triggeredLeg: s.protection.triggeredLeg });
    s.protection = null;
  }
  function syncPosition(s, events, positionClosed = false) {
    if (!s.account.position) { if (positionClosed) { cancelOrders(s, events, "position-closed"); clearProtection(s, events, "position-closed"); } return; }
    const quantity = s.account.position.contracts;
    if (s.protection) {
      const before = s.protection.contracts; s.protection.contracts = quantity;
      if (before !== quantity) emit(events, s, "protection-resized", { before, contracts: quantity });
    }
    let remaining = new D(quantity);
    for (const o of [...s.orders].filter((o) => o.intent === "reduce")) {
      const next = D.min(o.remainingContracts, remaining);
      if (next.isZero()) cancel(s, events, o, "reduce-only-position-shrank");
      else if (!next.eq(o.remainingContracts)) {
        emit(events, s, "order-clipped", { orderId: o.id, before: o.remainingContracts, remainingContracts: next.toFixed(), reason: "reduce-only-position-shrank" });
        o.remainingContracts = next.toFixed();
      }
      remaining = remaining.minus(next);
    }
  }
  function risk(s, events, reference) {
    if (!s.account.position || !calc.assessPosition(s.account.position, reference.markPrice).liquidationRequired) return;
    emit(events, s, "risk-triggered", { ...reference, risk: calc.assessPosition(s.account.position, reference.markPrice) });
    cancelOrders(s, events, "risk-cancellation"); clearProtection(s, events, "risk-cancellation");
    const result = calc.liquidateAfterCancellation(s.account, { markPrice: reference.markPrice, modelVersion: TEACHING_LIQUIDATION_VERSION,
      ordersCancelled: !s.orders.length && s.reservedBalance === ZERO && s.protection === null });
    emit(events, s, "risk-rechecked", { ...reference, risk: result.risk, status: result.status });
    if (result.status === "liquidated") {
      s.account = result.account; total(s, "liquidationAggregatePnl", result.settlement.aggregateSettlementPnl);
      total(s, "deficitWaiverMemo", result.settlement.reference.deficitWaiver);
      emit(events, s, "teaching-liquidation", { ...reference, settlement: result.settlement });
    }
  }
  function charge(s, events, f) {
    const relativeTimeMs = f.ts - w.replayStartMs;
    if (!s.account.position) { emit(events, s, "funding-skipped", { relativeTimeMs, reason: "flat-at-source-event-time" }); return; }
    const ref = fundingMarkReference(scenario.mark, f.ts);
    if (!ref) fail("FUNDING_MARK_COVERAGE", "Missing causal mark proxy");
    const result = calc.settleFunding(s.account, { markPrice: ref.price, settledRate: f.settledRate }); s.account = result.account;
    total(s, "fundingPayments", result.fundingPayment);
    emit(events, s, "funding-settled", { relativeTimeMs, settledRate: f.settledRate, payment: result.fundingPayment,
      contracts: s.account.position.contracts, marginAfter: s.account.position.marginBalance,
      markReference: { price: ref.price, approximate: true, type: ref.type, knownAtMinute: (ref.knownAtMs - w.replayStartMs) / MINUTE_MS } });
    risk(s, events, { phase: "funding", markPrice: ref.price, relativeTimeMs, approximateMark: true });
  }
  function reserveEstimate(s, o) {
    if (o.intent === "reduce") return ZERO;
    const q = o.type === "limit" ? calc.quoteFill({ contracts: o.remainingContracts, fillPrice: o.limitPrice, liquidityRole: "taker", leverage: s.leverage })
      : marketQuote(o.remainingContracts, direction(o.side, false), knownLast(s), s.leverage);
    return money(new D(q.initialMargin).plus(q.fee));
  }
  function reserve(s, o) {
    const required = reserveEstimate(s, o);
    if (new D(s.account.availableBalance).lt(required)) return false;
    o.reservedBalance = required; s.account.availableBalance = money(new D(s.account.availableBalance).minus(required));
    s.reservedBalance = money(new D(s.reservedBalance).plus(required)); return true;
  }
  function maxPosition(leverage) {
    const eligible = snapshot.instruments[instrumentId].isolatedPositionTiers.filter((t) => new D(t.maxLever).gte(leverage));
    return eligible.reduce((max, t) => D.max(max, t.maxSz), new D(0));
  }
  function fillQuantity(s, order, context, price, role) {
    let quantity = D.min(order.remainingContracts, context.capacity);
    if (order.intent === "reduce") quantity = D.min(quantity, s.account.position?.contracts ?? 0, spec.maxMktSz && order.type === "market" ? spec.maxMktSz : quantity);
    else quantity = D.min(quantity, maxPosition(s.leverage).minus(s.account.position?.contracts ?? 0));
    quantity = new D(calc.floorContracts(D.max(quantity, 0).toFixed()));
    if (quantity.isZero()) return "0";
    if (order.intent === "increase") {
      const one = quote(spec.minSz, order, price, role, s.leverage);
      const unit = new D(one.fillPrice).times(face).times(new D(1).div(s.leverage).plus(one.feeRate));
      quantity = new D(calc.floorContracts(D.min(quantity, D.max(new D(s.account.availableBalance).div(unit), 0))
        .toNearest(new D(spec.lotSz), D.ROUND_FLOOR).toFixed()));
      while (quantity.gt(0)) {
        const q = quote(quantity.toFixed(), order, price, role, s.leverage);
        if (new D(q.initialMargin).plus(q.fee).lte(s.account.availableBalance)) break;
        quantity = quantity.minus(spec.lotSz);
      }
    }
    return quantity.toFixed();
  }
  function trade(s, events, order, quoted, context, type, phase) {
    const reduce = order.intent === "reduce";
    const result = reduce ? calc.reducePosition(s.account, { contracts: quoted.contracts, fillPrice: quoted.fillPrice, liquidityRole: quoted.liquidityRole })
      : (s.account.position ? calc.addPosition : calc.openPosition)(s.account, { side: order.side, leverage: s.leverage,
        contracts: quoted.contracts, fillPrice: quoted.fillPrice, liquidityRole: quoted.liquidityRole });
    s.account = result.account; total(s, "tradingFees", quoted.fee); total(s, "slippageAttribution", quoted.slippageAttribution);
    if (reduce) total(s, "realizedPricePnl", result.realizedPnl);
    context.capacity = new D(context.capacity).minus(quoted.contracts).toFixed();
    emit(events, s, type, { orderId: order.id ?? null, intent: order.intent, side: order.side, phase, quote: quoted,
      executionMinute: context.minute, relativeTimeMs: phase === "open" ? context.minute * MINUTE_MS : null,
      intraminuteOrderUnknown: phase !== "open", intervalStartMinute: context.minute, intervalEndMinute: context.minute + 1,
      liquidityAssumption: "shared-whole-completed-minute-contract-volume",
      ...(reduce ? { realizedPnl: result.realizedPnl, releasedMargin: result.releasedMargin, cashDeficit: result.cashDeficit } : {}) });
  }
  function fillOrder(s, events, order, context, price, role, phase) {
    if (!s.orders.some((o) => o.id === order.id)) return;
    const hadPosition = Boolean(s.account.position);
    release(s, order);
    const quantity = fillQuantity(s, order, context, price, role);
    if (new D(quantity).gt(0)) {
      const quoted = quote(quantity, order, price, role, order.intent === "increase" ? s.leverage : null);
      const buy = direction(order.side, order.intent === "reduce") === "buy";
      if (order.type === "limit" && (buy ? new D(quoted.fillPrice).gt(order.limitPrice) : new D(quoted.fillPrice).lt(order.limitPrice))) {
        reserve(s, order); emit(events, s, "limit-waiting", { orderId: order.id, reason: "slippage-would-break-limit" }); return;
      }
      trade(s, events, order, quoted, context, "order-filled", phase);
      order.remainingContracts = new D(order.remainingContracts).minus(quantity).toFixed();
      order.filledContracts = new D(order.filledContracts).plus(quantity).toFixed();
      if (order.attachedProtection && !order.protectionApplied) {
        s.protection = { ...structuredClone(order.attachedProtection), contracts: s.account.position.contracts, triggeredLeg: null };
        order.protectionApplied = true; emit(events, s, "protection-armed", { sourceOrderId: order.id, protection: structuredClone(s.protection) });
      }
    } else if (order.type === "market") emit(events, s, "order-rejected", { orderId: order.id, reason: new D(context.capacity).lt(spec.minSz) ? "NO_MINUTE_CAPACITY" : "NO_AFFORDABLE_OR_TIER_CAPACITY" });
    if (new D(order.remainingContracts).isZero()) s.orders = s.orders.filter((o) => o.id !== order.id);
    else if (order.type === "market") cancel(s, events, order, "IOC-unfilled-remainder");
    else if (!reserve(s, order)) cancel(s, events, order, "remaining-reserve-shortfall");
    syncPosition(s, events, hadPosition && !s.account.position);
  }
  function protectionConfig(value) {
    if (!value || typeof value !== "object") fail("INVALID_PROTECTION", "Provide stopLoss and/or takeProfit");
    const result = {};
    for (const key of ["stopLoss", "takeProfit"]) {
      const leg = value[key];
      if (leg == null) { result[key] = null; continue; }
      calc.quoteFill({ contracts: spec.minSz, fillPrice: leg.price, liquidityRole: "maker" });
      const reference = leg.reference ?? "last";
      if (!["last", "mark"].includes(reference)) fail("INVALID_PROTECTION_REFERENCE", "Use last or mark");
      result[key] = { price: decimal(leg.price).toFixed(), reference };
    }
    if (!result.stopLoss && !result.takeProfit) fail("INVALID_PROTECTION", "At least one protective leg is required");
    return result;
  }
  function reached(s, legName, last, mark, openOnly) {
    const leg = s.protection?.[legName];
    if (!s.account.position || !leg || s.protection.triggeredLeg) return false;
    const source = leg.reference === "mark" ? mark : last;
    const down = (s.account.position.side === "long") === (legName === "stopLoss");
    const value = openOnly ? source.open : (down ? source.low : source.high);
    return down ? new D(value).lte(leg.price) : new D(value).gte(leg.price);
  }
  function protectiveExit(s, events, context, reference, phase) {
    if (!s.account.position || !s.protection?.triggeredLeg) return;
    const order = { id: null, type: "market", intent: "reduce", side: s.account.position.side, remainingContracts: s.account.position.contracts };
    const quantity = fillQuantity(s, order, context, reference, "taker");
    if (new D(quantity).gt(0)) trade(s, events, order, quote(quantity, order, reference, "taker", null), context, "protection-filled", phase);
    syncPosition(s, events, !s.account.position);
  }
  function trigger(s, events, legName, context, last, mark, openOnly) {
    if (!reached(s, legName, last, mark, openOnly)) return;
    const leg = structuredClone(s.protection[legName]), sibling = legName === "stopLoss" ? "takeProfit" : "stopLoss";
    const siblingWasArmed = s.protection[sibling] !== null;
    s.protection.triggeredLeg = legName; s.protection[sibling] = null;
    cancelOrders(s, events, "protective-exit-triggered");
    emit(events, s, "protection-triggered", { leg: legName, trigger: leg, siblingCancelled: siblingWasArmed,
      contracts: s.account.position.contracts, relativeTimeMs: openOnly ? context.minute * MINUTE_MS : null,
      intervalStartMinute: context.minute, intervalEndMinute: context.minute + 1, actualTriggerTimeUnknown: !openOnly });
    const reference = openOnly ? last.open : (leg.reference === "last" ? leg.price : (s.account.position.side === "long" ? last.low : last.high));
    protectiveExit(s, events, context, reference, openOnly ? "open" : (leg.reference === "last" ? "intrabar-trigger-price-proxy" : "intrabar-mark-trigger-adverse-last-proxy"));
  }
  function crossed(order, last, openOnly = false) {
    const buy = direction(order.side, order.intent === "reduce") === "buy";
    return buy ? new D(openOnly ? last.open : last.low).lte(new D(order.limitPrice).minus(tick))
      : new D(openOnly ? last.open : last.high).gte(new D(order.limitPrice).plus(tick));
  }
  function processMinute(state) {
    const s = structuredClone(state), events = [];
    const minute = s.elapsedMinutes, start = w.replayStartMs + minute * MINUTE_MS, end = start + MINUTE_MS;
    const last = bar("last", minute), mark = bar("mark", minute);
    const context = { minute, capacity: calc.floorContracts(last.volumeContracts) };
    s.elapsedMinutes++;
    if (minute === replayMinutes && !s.ending) { s.ending = true; s.endReason = "window-expired"; cancelOrders(s, events, "training-end"); clearProtection(s, events, "training-end"); }
    risk(s, events, { phase: "mark-open", markPrice: mark.open, relativeTimeMs: minute * MINUTE_MS });
    if (s.ending) {
      if (s.account.position) {
        const order = { type: "market", intent: "reduce", side: s.account.position.side, remainingContracts: s.account.position.contracts };
        const quantity = fillQuantity(s, order, context, last.open, "taker");
        if (new D(quantity).gt(0)) trade(s, events, order, quote(quantity, order, last.open, "taker", null), context, "end-filled", "open");
      }
    } else {
      if (s.protection?.triggeredLeg) protectiveExit(s, events, context, last.open, "open");
      else { trigger(s, events, "stopLoss", context, last, mark, true); trigger(s, events, "takeProfit", context, last, mark, true); }
      for (const saved of [...s.orders]) {
        const o = s.orders.find((x) => x.id === saved.id); if (!o) continue;
        if (o.type === "market") fillOrder(s, events, o, context, last.open, "taker", "open");
        else if (!o.resting) {
          const buy = direction(o.side, o.intent === "reduce") === "buy";
          const immediate = buy ? new D(last.open).lte(o.limitPrice) : new D(last.open).gte(o.limitPrice);
          o.resting = true;
          if (immediate) { o.blockedAtMinute = minute; fillOrder(s, events, o, context, last.open, "taker", "open"); }
        } else if (crossed(o, last, true)) fillOrder(s, events, o, context, o.limitPrice, "maker", "open");
        risk(s, events, { phase: "post-fill-mark-open", markPrice: mark.open, relativeTimeMs: minute * MINUTE_MS });
        trigger(s, events, "stopLoss", context, last, mark, true); trigger(s, events, "takeProfit", context, last, mark, true);
      }
    }
    const due = funding.filter((f) => f.ts > start && f.ts <= end), interior = due.filter((f) => f.ts < end), boundary = due.filter((f) => f.ts === end);
    const limitReachable = s.orders.some((o) => o.type === "limit" && o.resting && o.blockedAtMinute !== minute && crossed(o, last));
    const stages = [];
    if (s.account.position || limitReachable) stages.push("risk");
    const attached = s.orders.some((o) => o.attachedProtection && !o.protectionApplied && o.type === "limit" && crossed(o, last));
    if (!s.ending && (reached(s, "stopLoss", last, mark, false) || attached)) stages.push("stopLoss");
    if (!s.ending && (reached(s, "takeProfit", last, mark, false) || attached)) stages.push("takeProfit");
    if (!s.ending && limitReachable) stages.push("limits");
    if (interior.length) stages.push("funding");
    const paths = permutations(stages);
    const candidates = paths.map((path) => {
      const candidate = structuredClone(s), trace = [], liquidity = structuredClone(context);
      for (const stage of path) {
        if (stage === "risk" && candidate.account.position) risk(candidate, trace, { phase: "mark-adverse",
          markPrice: candidate.account.position.side === "long" ? mark.low : mark.high, relativeTimeMs: null,
          intervalStartMinute: minute, intervalEndMinute: minute + 1, intraminuteOrderUnknown: true });
        else if (stage === "funding") for (const f of interior) charge(candidate, trace, f);
        else if (stage === "limits") {
          for (const saved of [...candidate.orders]) {
            const o = candidate.orders.find((x) => x.id === saved.id);
            if (o?.type === "limit" && o.resting && o.blockedAtMinute !== minute && crossed(o, last)) fillOrder(candidate, trace, o, liquidity, o.limitPrice, "maker", "intrabar-limit-cross");
          }
        } else if (stage === "stopLoss" || stage === "takeProfit") trigger(candidate, trace, stage, liquidity, last, mark, false);
      }
      risk(candidate, trace, { phase: "mark-close", markPrice: mark.close, relativeTimeMs: (minute + 1) * MINUTE_MS });
      for (const f of boundary) charge(candidate, trace, f);
      return { state: candidate, events: trace, path, equity: equity(candidate, mark.close), capacity: liquidity.capacity };
    });
    const selected = candidates.reduce((a, b) => b.equity.lt(a.equity) ? b : a);
    if (paths.length > 1) emit(events, s, "intraminute-ambiguity", { intervalStartMinute: minute, intervalEndMinute: minute + 1,
      selectedPath: selected.path, selection: "lowest-minute-close-equity; fixed-stage-order-ties", actualIntraminutePath: null,
      candidates: candidates.map((c) => ({ path: c.path, equity: money(c.equity) })) });
    events.push(...selected.events); const result = selected.state;
    if ((result.ending && !result.account.position) || result.elapsedMinutes === totalMinutes) {
      cancelOrders(result, events, "training-end"); clearProtection(result, events, "training-end");
      result.status = result.account.position ? "end-blocked" : "completed";
      emit(events, result, result.status === "completed" ? "training-ended" : "end-blocked", { reason: result.endReason ?? "window-expired" });
    }
    summarize(result); return { state: result, events };
  }
  function validate(s) {
    if (!s || Object.keys(versions).some((k) => s.versions?.[k] !== versions[k]) || s.slippageBps !== String(bps)) fail("STATE_VERSION_MISMATCH", "Restore only with the same executor/data/rules");
    if (!Number.isSafeInteger(s.elapsedMinutes) || s.elapsedMinutes < 0 || s.elapsedMinutes > totalMinutes
      || !["active", "completed", "end-blocked"].includes(s.status) || !Array.isArray(s.orders)
      || !Number.isSafeInteger(s.nextOrderId) || s.nextOrderId < 1 || !Number.isSafeInteger(s.eventSequence) || s.eventSequence < 0
      || typeof s.ending !== "boolean" || (s.status === "active" && s.elapsedMinutes >= totalMinutes)
      || (s.status === "completed" && (s.account.position || s.orders.length || s.protection))) fail("INVALID_STATE", "Invalid internal order state");
    if (cash(s.startingCash).isNegative() || cash(s.reservedBalance).isNegative()) fail("INVALID_STATE", "Negative starting cash or reserve");
    cash(s.account.availableBalance); for (const key of TOTALS) cash(s.totals[key]);
    const ids = new Set();
    for (const o of s.orders) {
      if (ids.has(o.id) || !Number.isSafeInteger(o.id) || o.id < 1 || o.id >= s.nextOrderId || !["increase", "reduce"].includes(o.intent)
        || !["long", "short"].includes(o.side) || !["market", "limit"].includes(o.type)
        || o.submittedMinute > s.elapsedMinutes || cash(o.reservedBalance).isNegative()
        || (o.intent === "reduce" && (!s.account.position || !new D(o.reservedBalance).isZero()))) fail("INVALID_STATE", "Invalid active order");
      calc.quoteFill({ contracts: o.remainingContracts, fillPrice: o.limitPrice ?? knownLast(s), liquidityRole: "taker" }); ids.add(o.id);
    }
    if (s.protection && (!s.account.position || s.protection.contracts !== s.account.position.contracts)) fail("INVALID_STATE", "Protection must match actual position");
    summarize(s);
  }
  return Object.freeze({ versions: Object.freeze({ ...versions }),
    create({ startingCash = "10000", leverage = "5" } = {}) {
      const initial = cash(startingCash); if (initial.isNegative()) fail("INVALID_STARTING_CASH", "Starting cash cannot be negative");
      calc.quoteFill({ contracts: spec.minSz, fillPrice: bar("last", -1).close, liquidityRole: "taker", leverage });
      const s = { versions: { ...versions }, slippageBps: String(bps), leverage: decimal(leverage).toFixed(), startingCash: money(initial),
        elapsedMinutes: 0, status: "active", ending: false, endReason: null, nextOrderId: 1, eventSequence: 0,
        account: { availableBalance: money(initial), position: null }, reservedBalance: ZERO, orders: [], protection: null,
        totals: Object.fromEntries(TOTALS.map((k) => [k, ZERO])) };
      summarize(s); return s;
    },
    apply(inputState, command) {
      let s = structuredClone(inputState); validate(s);
      if (s.status !== "active") fail("REPLAY_NOT_ACTIVE", "This replay is ended or blocked");
      if (s.ending && command?.type !== "advance") fail("ENDING_IN_PROGRESS", "Only advance while exiting for training end");
      const events = []; let advancedMinutes = 0, paused = false;
      switch (command?.type) {
        case "market-open": case "limit-open": case "market-close": case "limit-close": {
          if (s.elapsedMinutes >= replayMinutes) fail("END_EXECUTION_ONLY", "No new user orders in the reserved minute");
          const reduce = command.type.endsWith("close"), type = command.type.startsWith("limit") ? "limit" : "market";
          if (!reduce && s.protection?.triggeredLeg) fail("PROTECTION_EXIT_PENDING", "Finish or explicitly cancel the triggered exit before adding risk");
          const side = reduce ? s.account.position?.side : command.side;
          if (!["long", "short"].includes(side)) fail(reduce ? "NO_POSITION" : "INVALID_SIDE", "A one-way side/position is required");
          if (!reduce && ((s.account.position && s.account.position.side !== side) || s.orders.some((o) => o.intent === "increase" && o.side !== side))) fail("POSITION_SIDE_MISMATCH", "Complete the old side before reversing");
          const contracts = decimal(command.contracts ?? (reduce ? s.account.position.contracts : null)).toFixed();
          const price = type === "limit" ? decimal(command.limitPrice).toFixed() : knownLast(s);
          calc.quoteFill({ contracts, fillPrice: price, liquidityRole: "taker", leverage: reduce ? null : s.leverage });
          if (new D(contracts).gt(type === "market" ? spec.maxMktSz : spec.maxLmtSz)) fail("ORDER_SIZE_LIMIT", "Order exceeds frozen size limit");
          if (reduce) {
            const pending = s.orders.filter((o) => o.intent === "reduce").reduce((n, o) => n.plus(o.remainingContracts), new D(0));
            if (pending.plus(contracts).gt(s.account.position.contracts)) fail("OVER_REDUCTION", "Pending user closes cannot exceed the position");
            if (command.protection) fail("INVALID_PROTECTION", "Only increase orders can attach protection");
          } else {
            const pending = s.orders.filter((o) => o.intent === "increase").reduce((n, o) => n.plus(o.remainingContracts), new D(s.account.position?.contracts ?? 0));
            calc.quoteFill({ contracts: pending.plus(contracts).toFixed(), fillPrice: price, liquidityRole: "taker", leverage: s.leverage });
          }
          const order = { id: s.nextOrderId++, type, intent: reduce ? "reduce" : "increase", side, contracts, remainingContracts: contracts,
            filledContracts: "0", limitPrice: type === "limit" ? price : null, submittedMinute: s.elapsedMinutes,
            resting: false, blockedAtMinute: null, reservedBalance: ZERO, attachedProtection: command.protection ? protectionConfig(command.protection) : null, protectionApplied: false };
          if (!reserve(s, order)) fail("INSUFFICIENT_CASH", "Cover the estimated margin and taker fee before submission");
          s.orders.push(order); emit(events, s, "order-submitted", { order: structuredClone(order), estimateIsNotAFill: true }); break;
        }
        case "amend-limit": {
          if (s.elapsedMinutes >= replayMinutes) fail("END_EXECUTION_ONLY", "No price changes in the reserved minute");
          if (!Number.isSafeInteger(command.orderId) || command.orderId < 1) fail("INVALID_ORDER_ID", "Use an active order ID");
          const o = s.orders.find((o) => o.id === command.orderId);
          if (!o || o.type !== "limit") fail("ORDER_NOT_ACTIVE", "Only active limit orders can be amended");
          if (o.intent === "increase" && s.protection?.triggeredLeg) fail("PROTECTION_EXIT_PENDING", "Finish the triggered exit before adding risk");
          const price = decimal(command.limitPrice).toFixed();
          calc.quoteFill({ contracts: o.remainingContracts, fillPrice: price, liquidityRole: "taker", leverage: o.intent === "increase" ? s.leverage : null });
          if (new D(price).eq(o.limitPrice)) fail("UNCHANGED_LIMIT_PRICE", "The limit price has not changed");
          if (o.intent === "increase") {
            const pending = s.orders.filter((x) => x.intent === "increase").reduce((n, x) => n.plus(x.remainingContracts), new D(s.account.position?.contracts ?? 0));
            calc.quoteFill({ contracts: pending.toFixed(), fillPrice: price, liquidityRole: "taker", leverage: s.leverage });
          }
          const oldPrice = o.limitPrice, oldReserve = o.reservedBalance;
          // The entire command operates on a clone: failed reserve checks keep the old order intact.
          release(s, o); o.limitPrice = price;
          if (!reserve(s, o)) fail("INSUFFICIENT_CASH", "Cover the amended margin and taker fee before confirmation");
          // A price change loses queue priority. Re-evaluate at the next unseen minute, never at the visible candle.
          o.resting = false; o.blockedAtMinute = null; o.submittedMinute = s.elapsedMinutes;
          s.orders = [...s.orders.filter((x) => x.id !== o.id), o];
          emit(events, s, "order-amended", { orderId: o.id, oldPrice, limitPrice: price, remainingContracts: o.remainingContracts, oldReserve, reservedBalance: o.reservedBalance });
          break;
        }
        case "cancel-order": {
          const o = s.orders.find((o) => o.id === command.orderId); if (!o) fail("ORDER_NOT_ACTIVE", "Only active unfilled quantity can be cancelled");
          cancel(s, events, o, "user"); break;
        }
        case "cancel-all-orders": cancelOrders(s, events, "user"); break;
        case "set-protection": {
          if (!s.account.position) fail("NO_POSITION", "Protection requires a filled position");
          if (s.protection?.triggeredLeg) fail("PROTECTION_EXIT_PENDING", "Cancel the triggered exit explicitly before replacing it");
          s.protection = { ...protectionConfig(command), contracts: s.account.position.contracts, triggeredLeg: null };
          emit(events, s, "protection-armed", { protection: structuredClone(s.protection) }); break;
        }
        case "cancel-protection": {
          if (!s.protection) fail("NO_PROTECTION", "No active protection");
          if (command.leg != null && !["stopLoss", "takeProfit"].includes(command.leg)) fail("INVALID_PROTECTION", "Unknown protective leg");
          if (command.leg && s.protection.triggeredLeg && command.leg !== s.protection.triggeredLeg) fail("NO_PROTECTION", "The sibling was already cancelled");
          if (command.leg && !s.protection.triggeredLeg) {
            if (!s.protection[command.leg]) fail("NO_PROTECTION", "Leg is already absent");
            s.protection[command.leg] = null; emit(events, s, "protection-leg-cancelled", { leg: command.leg });
            if (!s.protection.stopLoss && !s.protection.takeProfit) s.protection = null;
          } else clearProtection(s, events, "user");
          break;
        }
        case "add-margin": {
          const result = calc.addMargin(s.account, command.amount); s.account = result.account; total(s, "manualTopups", result.amount);
          emit(events, s, "margin-added", { amount: result.amount, marginAfter: s.account.position.marginBalance }); break;
        }
        case "finish": {
          s.ending = true; s.endReason = "user-finish"; cancelOrders(s, events, "training-end"); clearProtection(s, events, "training-end");
          if (!s.account.position) { s.status = "completed"; emit(events, s, "training-ended", { reason: s.endReason }); }
          break;
        }
        case "advance": {
          if (!Number.isSafeInteger(command.minutes) || command.minutes < 1 || (command.stopOnEvent !== undefined && typeof command.stopOnEvent !== "boolean")) fail("INVALID_ADVANCE", "Use positive integer minutes and boolean stopOnEvent");
          const limit = Math.min(command.minutes, totalMinutes - s.elapsedMinutes);
          for (let i = 0; i < limit && s.status === "active"; i++) {
            const result = processMinute(s); s = result.state; events.push(...result.events); advancedMinutes++;
            if (command.stopOnEvent !== false && result.events.some((e) => PAUSE.has(e.type))) { paused = true; break; }
          }
          break;
        }
        default: fail("UNSUPPORTED_COMMAND", "Unsupported order-execution command");
      }
      summarize(s);
      return { state: s, events: events.map((e) => ({ sequence: ++s.eventSequence, ...e })), advancedMinutes, paused };
    },
  });
}
