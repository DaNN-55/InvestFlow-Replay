import Decimal from "decimal.js";
import { createCryptoCalculator, TEACHING_LIQUIDATION_VERSION } from "./replay-crypto-calculations.js";
import { MINUTE_MS, validateCryptoScenario, fundingMarkReference } from "./replay-crypto-scenario.js";

// See ADR-0005. Internal pure execution snapshots, not HTTP payloads or a business ledger.
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
export const CRYPTO_EXECUTION_VERSION = "okx-market-minute-teaching-v1";
const ZERO = "0.00000000";
const money = (value) => { const d = new D(value).toDecimalPlaces(8); return d.isZero() ? ZERO : d.toFixed(8); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function amount(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
    || value.replace(/[-.]/g, "").length > 32) fail("INVALID_DECIMAL", label);
  return new D(value);
}
function cash(value, label) {
  const d = amount(value, label);
  if (d.decimalPlaces() > 8) fail("MONEY_PRECISION", label);
  return d;
}
const TOTAL_KEYS = ["tradingFees", "fundingPayments", "realizedPricePnl", "liquidationAggregatePnl",
  "manualTopups", "slippageAttribution", "deficitWaiverMemo"];
const PAUSE_TYPES = new Set(["market-filled", "market-rejected", "funding-settled", "teaching-liquidation", "training-ended", "end-blocked"]);

/**
 * Trusted internal JSON state -> new state + incremental calculation trace. No IO, wall clock or randomness.
 * Cursor means completed/revealed minutes; funding exactly at the cursor has already been handled.
 * Lifecycle/retry authorization and durable events remain the existing transaction layer's responsibility (P4).
 */
export function createCryptoMarketReplay({ rules, scenario: input, dataVersion, slippageBps = null }) {
  if (typeof dataVersion !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(dataVersion)) fail("DATA_VERSION_REQUIRED", "Freeze a data version explicitly");
  const scenario = structuredClone(input);
  const ruleSnapshot = structuredClone(rules);
  validateCryptoScenario(scenario);
  const { instrumentId, window: w } = scenario;
  const calculator = createCryptoCalculator({ rules: ruleSnapshot, instrumentId });
  const spec = ruleSnapshot.instruments[instrumentId].spec;
  const bps = slippageBps ?? ruleSnapshot.executionAssumptions.slippageBps.default;
  const replayMinutes = (w.replayEndMs - w.replayStartMs) / MINUTE_MS;
  const totalMinutes = replayMinutes + 1;
  const backgroundMinutes = (w.replayStartMs - w.backgroundStartMs) / MINUTE_MS;
  const versions = { ...calculator.versions, executionVersion: CRYPTO_EXECUTION_VERSION, dataVersion };
  const funding = scenario.funding.filter((e) => e.ts > w.replayStartMs && e.ts <= w.executionEndMs);
  const barAt = (kind, minute) => scenario[kind][backgroundMinutes + minute];
  const markAtCursor = (s) => barAt("mark", s.elapsedMinutes - 1).close;
  const knownLast = (s) => barAt("last", s.elapsedMinutes - 1).close;
  const quote = (args) => calculator.quoteMarketFill({ ...args, slippageBps: bps });
  // Validate the frozen slippage group without reading any replay prices.
  quote({ action: "buy", referencePrice: barAt("last", -1).close, contracts: spec.minSz });

  function addTotal(s, key, value) { s.totals[key] = money(new D(s.totals[key]).plus(value)); }
  function equity(s, mark) {
    const unrealized = s.account.position ? calculator.assessPosition(s.account.position, mark).unrealizedPnl : ZERO;
    return new D(s.account.availableBalance).plus(s.reservedBalance)
      .plus(s.account.position?.marginBalance ?? 0).plus(unrealized);
  }
  function updateSummary(s) {
    const mark = markAtCursor(s);
    s.risk = s.account.position ? calculator.assessPosition(s.account.position, mark) : null;
    const realizedNet = new D(s.totals.realizedPricePnl).minus(s.totals.tradingFees)
      .minus(s.totals.fundingPayments).plus(s.totals.liquidationAggregatePnl);
    s.summary = { accountEquity: money(equity(s, mark)), netPnl: money(equity(s, mark).minus(s.startingCash)),
      recognizedNetPnl: money(realizedNet), cashDeficit: money(D.max(new D(s.account.availableBalance).negated(), 0)),
      waiverExcludedFromTradingProfitMetrics: true };
    const expected = new D(s.startingCash).plus(realizedNet).plus(s.risk?.unrealizedPnl ?? 0);
    if (!equity(s, mark).eq(expected)) fail("ACCOUNTING_MISMATCH", "Cash + reserve + margin + unrealized must reconcile to starting cash + recognized PnL");
  }
  function validateState(s) {
    if (!s || Object.keys(versions).some((key) => s.versions?.[key] !== versions[key])
      || Object.keys(s.versions).length !== Object.keys(versions).length
      || s.slippageBps !== String(bps)) fail("STATE_VERSION_MISMATCH", "State must belong to these frozen execution inputs");
    if (!Number.isSafeInteger(s.elapsedMinutes) || s.elapsedMinutes < 0 || s.elapsedMinutes > totalMinutes
      || !Number.isSafeInteger(s.eventSequence) || s.eventSequence < 0
      || !Number.isSafeInteger(s.nextOrderId) || s.nextOrderId < 1
      || !["active", "completed", "end-blocked"].includes(s.status)
      || (s.status === "active") !== (s.elapsedMinutes < totalMinutes)
      || (s.status === "completed" && s.account?.position != null)
      || (s.status === "end-blocked" && s.account?.position == null)) fail("INVALID_STATE", "Invalid execution cursor/status");
    if (cash(s.startingCash, "startingCash").isNegative() || cash(s.reservedBalance, "reserve").isNegative()) fail("INVALID_STATE", "Negative initial cash/reserve");
    cash(s.account.availableBalance, "availableBalance");
    for (const key of TOTAL_KEYS) cash(s.totals?.[key], key);
    const p = s.pendingMarketOrder;
    if (p && (!["open", "close"].includes(p.kind) || p.submittedMinute !== s.elapsedMinutes
      || !Number.isSafeInteger(p.id) || p.id < 1 || p.id >= s.nextOrderId
      || p.reservedBalance !== s.reservedBalance
      || (p.kind === "open" && s.account.position != null) || (p.kind === "close" && !s.account.position))) fail("INVALID_STATE", "Invalid pending market order");
    if ((!p || p.kind === "close") && !new D(s.reservedBalance).isZero()) fail("INVALID_STATE", "Only pending opens reserve cash");
    calculator.quoteFill({ contracts: spec.minSz, fillPrice: knownLast(s), liquidityRole: "taker", leverage: s.leverage });
    // Detect accidental balance/state edits; this is not an untrusted-client authentication mechanism.
    updateSummary(s);
  }
  function event(events, s, type, values = {}) {
    events.push({ type, instrumentId, observedAtMinute: s.elapsedMinutes, ...values });
  }
  function releaseOrder(s) {
    const order = s.pendingMarketOrder;
    s.account.availableBalance = money(new D(s.account.availableBalance).plus(s.reservedBalance));
    s.reservedBalance = ZERO; s.pendingMarketOrder = null;
    return order;
  }
  function checkRisk(s, events, reference) {
    if (!s.account.position) return;
    const risk = calculator.assessPosition(s.account.position, reference.markPrice);
    if (!risk.liquidationRequired) return;
    event(events, s, "risk-triggered", { ...reference, risk });
    const released = s.reservedBalance;
    const cancelled = releaseOrder(s);
    event(events, s, "orders-cancelled-for-risk", { orderIds: cancelled ? [cancelled.id] : [], releasedReserve: released });
    const result = calculator.liquidateAfterCancellation(s.account, { markPrice: reference.markPrice,
      modelVersion: TEACHING_LIQUIDATION_VERSION, ordersCancelled: s.pendingMarketOrder === null && s.reservedBalance === ZERO });
    event(events, s, "risk-rechecked", { ...reference, risk: result.risk, status: result.status });
    if (result.status === "liquidated") {
      s.account = result.account;
      addTotal(s, "liquidationAggregatePnl", result.settlement.aggregateSettlementPnl);
      addTotal(s, "deficitWaiverMemo", result.settlement.reference.deficitWaiver);
      event(events, s, "teaching-liquidation", { ...reference, settlement: result.settlement });
    }
  }
  function fundingEvent(s, events, source) {
    const relativeTimeMs = source.ts - w.replayStartMs;
    if (!s.account.position) {
      event(events, s, "funding-skipped", { relativeTimeMs, reason: "flat-at-source-event-time" }); return;
    }
    const reference = fundingMarkReference(scenario.mark, source.ts);
    if (!reference) fail("FUNDING_MARK_COVERAGE", "A causal mark proxy is required for held-position funding");
    const result = calculator.settleFunding(s.account, { markPrice: reference.price, settledRate: source.settledRate });
    s.account = result.account; addTotal(s, "fundingPayments", result.fundingPayment);
    const markReference = { price: reference.price, type: reference.type, approximate: true,
      knownAtMinute: (reference.knownAtMs - w.replayStartMs) / MINUTE_MS };
    event(events, s, "funding-settled", { relativeTimeMs, settledRate: source.settledRate,
      payment: result.fundingPayment, marginAfter: s.account.position.marginBalance, markReference,
      publicationAssumption: "known-at-source-event-time; actual-publication-latency-unknown" });
    checkRisk(s, events, { phase: "funding", markPrice: reference.price, relativeTimeMs, approximateMark: true });
  }
  function executeMarket(s, events, order, last, minute, reason = "user") {
    const close = order.kind === "close";
    const side = close ? s.account.position?.side : order.side;
    if (!side) fail("INVALID_STATE", "No position to reduce");
    const action = (side === "long") !== close ? "buy" : "sell";
    const quoted = quote({ action, referencePrice: last.open, contracts: order.contracts,
      ...(close ? {} : { leverage: s.leverage }) });
    let rejection = null;
    if (new D(order.contracts).gt(spec.maxMktSz)) rejection = "MARKET_SIZE_LIMIT";
    else if (new D(order.contracts).gt(last.volumeContracts)) rejection = "MARKET_VOLUME_SHORTFALL";
    else if (!close && new D(s.account.availableBalance).lt(new D(quoted.initialMargin).plus(quoted.fee))) rejection = "INSUFFICIENT_CASH";
    if (rejection) {
      event(events, s, "market-rejected", { orderId: order.id, kind: order.kind, reason: rejection,
        executionMinute: minute, endExit: reason === "training-end" });
      return false;
    }
    const result = close ? calculator.reducePosition(s.account, { contracts: order.contracts,
      fillPrice: quoted.fillPrice, liquidityRole: "taker" }) : calculator.openPosition(s.account, {
      side, leverage: s.leverage, contracts: order.contracts, fillPrice: quoted.fillPrice, liquidityRole: "taker" });
    s.account = result.account;
    addTotal(s, "tradingFees", quoted.fee); addTotal(s, "slippageAttribution", quoted.slippageAttribution);
    if (close) addTotal(s, "realizedPricePnl", result.realizedPnl);
    event(events, s, "market-filled", { orderId: order.id, kind: order.kind, side, executionMinute: minute,
      relativeTimeMs: minute * MINUTE_MS, reason, quote: quoted,
      liquidityAssumption: "whole-completed-execution-minute-volume; all-or-nothing approximation",
      ...(close ? { releasedMargin: result.releasedMargin, realizedPnl: result.realizedPnl, cashDeficit: result.cashDeficit } : {}) });
    return true;
  }
  function processMinute(state) {
    const s = structuredClone(state), events = [];
    const minute = s.elapsedMinutes;
    const start = w.replayStartMs + minute * MINUTE_MS;
    const end = start + MINUTE_MS;
    const last = barAt("last", minute), mark = barAt("mark", minute);
    s.elapsedMinutes++;
    // Funding exactly at start was handled at the previous cursor (initial account was flat).
    checkRisk(s, events, { phase: "mark-open", markPrice: mark.open, relativeTimeMs: minute * MINUTE_MS });
    if (minute === replayMinutes) {
      const cancelled = releaseOrder(s);
      if (cancelled) event(events, s, "market-cancelled", { orderId: cancelled.id, reason: "training-end" });
      if (s.account.position) executeMarket(s, events, { id: null, kind: "close", contracts: s.account.position.contracts }, last, minute, "training-end");
    } else if (s.pendingMarketOrder) {
      const order = releaseOrder(s);
      executeMarket(s, events, order, last, minute);
    }
    checkRisk(s, events, { phase: "post-fill-mark-open", markPrice: mark.open, relativeTimeMs: minute * MINUTE_MS });
    const due = funding.filter((e) => e.ts > start && e.ts <= end);
    const interior = due.filter((e) => e.ts < end), boundary = due.filter((e) => e.ts === end);
    function tail(source, fundingFirst) {
      const candidate = structuredClone(source), trace = [];
      const adverse = () => {
        if (candidate.account.position) checkRisk(candidate, trace, { phase: "mark-adverse",
          markPrice: candidate.account.position.side === "long" ? mark.low : mark.high,
          relativeTimeMs: null, intervalStartMinute: minute, intervalEndMinute: minute + 1,
          intraminuteOrderUnknown: true });
      };
      if (fundingFirst) { for (const f of interior) fundingEvent(candidate, trace, f); adverse(); }
      else { adverse(); for (const f of interior) fundingEvent(candidate, trace, f); }
      checkRisk(candidate, trace, { phase: "mark-close", markPrice: mark.close, relativeTimeMs: (minute + 1) * MINUTE_MS });
      for (const f of boundary) fundingEvent(candidate, trace, f);
      return { state: candidate, events: trace, equity: equity(candidate, mark.close) };
    }
    const first = tail(s, true);
    let selected = first;
    if (interior.length && s.account.position && !new D(mark.high).eq(mark.low)) {
      const second = tail(s, false);
      const fundingFirst = first.equity.lte(second.equity);
      selected = fundingFirst ? first : second;
      event(events, s, "intraminute-ambiguity", { intervalStartMinute: minute, intervalEndMinute: minute + 1,
        selectedPath: fundingFirst ? "funding-before-adverse-mark" : "adverse-mark-before-funding",
        selection: "lower-completed-minute-equity; ties-funding-first",
        candidateEquities: { fundingFirst: money(first.equity), adverseMarkFirst: money(second.equity) },
        actualIntraminutePath: null });
    }
    events.push(...selected.events);
    const result = selected.state;
    if (result.elapsedMinutes === totalMinutes) {
      result.status = result.account.position ? "end-blocked" : "completed";
      event(events, result, result.status === "completed" ? "training-ended" : "end-blocked",
        { reason: result.status === "completed" ? "reserved-execution-minute" : "ordinary-exit-unfilled; no-invented-takeover" });
    }
    updateSummary(result);
    return { state: result, events };
  }
  return Object.freeze({
    versions: Object.freeze({ ...versions }),
    create({ startingCash = "10000", leverage = "5" } = {}) {
      const initial = cash(startingCash, "startingCash");
      if (initial.isNegative()) fail("INVALID_STARTING_CASH", "Starting cash cannot be negative");
      calculator.quoteFill({ contracts: spec.minSz, fillPrice: barAt("last", -1).close, liquidityRole: "taker", leverage });
      const state = { versions: { ...versions }, slippageBps: String(bps), leverage: amount(leverage, "leverage").toFixed(),
        startingCash: money(initial), elapsedMinutes: 0, status: "active", eventSequence: 0, nextOrderId: 1,
        account: { availableBalance: money(initial), position: null }, reservedBalance: ZERO, pendingMarketOrder: null,
        totals: Object.fromEntries(TOTAL_KEYS.map((key) => [key, ZERO])) };
      updateSummary(state); return state;
    },
    apply(inputState, command) {
      let s = structuredClone(inputState);
      validateState(s);
      if (s.status !== "active") fail("REPLAY_NOT_ACTIVE", "Completed/end-blocked replay cannot accept new actions");
      const events = [];
      let advancedMinutes = 0, paused = false;
      switch (command?.type) {
        case "market-open":
        case "market-close": {
          if (s.elapsedMinutes >= replayMinutes) fail("END_EXECUTION_ONLY", "The reserved minute is for ending, not new user orders");
          if (s.pendingMarketOrder) fail("MARKET_ORDER_PENDING", "Execute or cancel the pending market order first");
          const close = command.type === "market-close";
          if (close && !s.account.position) fail("NO_POSITION", "Closing requires a position");
          if (!close && s.account.position) fail("POSITION_EXISTS", "Close first; same-side additions belong to P3b");
          const side = close ? s.account.position.side : command.side;
          if (!["long", "short"].includes(side)) fail("INVALID_SIDE", "Use long or short");
          const contracts = command.contracts ?? (close ? s.account.position.contracts : null);
          const quoted = quote({ action: (side === "long") !== close ? "buy" : "sell", referencePrice: knownLast(s), contracts,
            ...(close ? {} : { leverage: s.leverage }) });
          if (new D(quoted.contracts).gt(spec.maxMktSz)) fail("MARKET_SIZE_LIMIT", "Contracts exceed the frozen market order limit");
          if (close && new D(quoted.contracts).gt(s.account.position.contracts)) fail("OVER_REDUCTION", "A close cannot reverse the position");
          const reserved = close ? new D(0) : new D(quoted.initialMargin).plus(quoted.fee);
          if (!close && new D(s.account.availableBalance).lt(reserved)) fail("INSUFFICIENT_CASH", "Cover estimated margin and opening fee before submitting");
          s.pendingMarketOrder = { id: s.nextOrderId++, kind: close ? "close" : "open", side,
            contracts: quoted.contracts, submittedMinute: s.elapsedMinutes, reservedBalance: money(reserved) };
          s.account.availableBalance = money(new D(s.account.availableBalance).minus(reserved));
          s.reservedBalance = money(reserved);
          event(events, s, "market-submitted", { order: { ...s.pendingMarketOrder }, estimate: quoted, estimateIsNotAFill: true });
          break;
        }
        case "cancel-market": {
          if (!s.pendingMarketOrder) fail("NO_PENDING_MARKET_ORDER", "No pending market order");
          const reserved = s.reservedBalance, order = releaseOrder(s);
          event(events, s, "market-cancelled", { orderId: order.id, reason: "user", releasedReserve: reserved });
          break;
        }
        case "add-margin": {
          const before = s.account;
          const result = calculator.addMargin(s.account, command.amount);
          s.account = result.account; addTotal(s, "manualTopups", result.amount);
          event(events, s, "margin-added", { amount: result.amount, availableBefore: before.availableBalance,
            availableAfter: s.account.availableBalance, marginAfter: s.account.position.marginBalance });
          break;
        }
        case "advance": {
          if (!Number.isSafeInteger(command.minutes) || command.minutes < 1
            || (command.stopOnEvent !== undefined && typeof command.stopOnEvent !== "boolean")) fail("INVALID_ADVANCE", "Use positive integer minutes and a boolean stopOnEvent");
          const limit = Math.min(command.minutes, totalMinutes - s.elapsedMinutes);
          for (let i = 0; i < limit; i++) {
            const result = processMinute(s); s = result.state; events.push(...result.events); advancedMinutes++;
            if (command.stopOnEvent !== false && result.events.some((e) => PAUSE_TYPES.has(e.type))) { paused = true; break; }
          }
          break;
        }
        default: fail("UNSUPPORTED_COMMAND", "Only P3a market, margin and advance commands are supported");
      }
      updateSummary(s);
      const numbered = events.map((e) => ({ sequence: ++s.eventSequence, ...e }));
      return { state: s, events: numbered, advancedMinutes, paused };
    },
  });
}
