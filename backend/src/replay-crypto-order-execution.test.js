import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { createCryptoCalculator } from "./replay-crypto-calculations.js";
import { createCryptoOrderReplay } from "./replay-crypto-order-execution.js";
import { MINUTE_MS as M } from "./replay-crypto-scenario.js";
const D = Decimal.clone({ precision: 96 });
const rules = JSON.parse(readFileSync(new URL("../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json", import.meta.url)));
const START = Date.parse("2024-01-01T00:00:00+08:00");
const clone = (v) => structuredClone(v), error = (code) => (e) => e.code === code;
function sample(instrumentId = "BTC-USDT-SWAP", price = "50000") {
  const window = { backgroundStartMs: START - 60 * M, replayStartMs: START, replayEndMs: START + 180 * M, executionEndMs: START + 181 * M };
  const bars = Array.from({ length: 241 }, (_, i) => ({ ts: window.backgroundStartMs + i * M, open: price, high: price, low: price, close: price, sourceConfirm: "1" }));
  return { instrumentId, window, mark: clone(bars), last: bars.map((b) => ({ ...b, volumeContracts: "100000", volumeBase: "1000", volumeQuote: "50000000" })),
    fundingAudit: { cadenceMs: 60 * M, maxSourceOffsetMs: 2000 },
    funding: Array.from({ length: 7 }, (_, i) => ({ ts: START + (i - 2) * 60 * M, settledRate: "0" })) };
}
const set = (s, kind, minute, patch) => Object.assign(s[kind][60 + minute], patch);
const flat = (s, kind, minute, p) => set(s, kind, minute, { open: p, high: p, low: p, close: p });
const engine = (s = sample(), config = {}) => createCryptoOrderReplay({ rules, scenario: s, dataVersion: "synthetic-v1", slippageBps: 0, ...config });
const act = (e, s, command) => e.apply(s, command).state;
const advance = (e, s, minutes = 1) => e.apply(s, { type: "advance", minutes, stopOnEvent: false });
function opened(e, config = {}, protection = null) {
  const { side = "long", contracts = "10", ...account } = config;
  return advance(e, act(e, e.create(account), { type: "market-open", side, contracts, ...(protection ? { protection } : {}) })).state;
}
const fills = (r) => r.events.filter((x) => x.type.endsWith("filled"));
function bridge(s) {
  const t = s.totals, p = s.account.position;
  const recognized = new D(t.realizedPricePnl).minus(t.tradingFees).minus(t.fundingPayments).plus(t.liquidationAggregatePnl);
  assert.equal(new D(s.account.availableBalance).plus(s.reservedBalance).plus(p?.marginBalance ?? 0).plus(s.risk?.unrealizedPnl ?? 0).toFixed(8),
    new D(s.startingCash).plus(recognized).plus(s.risk?.unrealizedPnl ?? 0).toFixed(8));
}

test("P1 extension: non-terminating weighted entry keeps exact remaining cost and reconciles independent round trip", () => {
  const c = createCryptoCalculator({ rules, instrumentId: "BTC-USDT-SWAP" });
  let a = c.openPosition({ availableBalance: "10000", position: null }, { side: "long", contracts: "1", fillPrice: "50000", liquidityRole: "taker", leverage: "5" }).account;
  a = c.addPosition(a, { side: "long", contracts: "2", fillPrice: "50001", liquidityRole: "taker", leverage: "5" }).account;
  assert.equal(a.position.entryNotional, "1500.02000000"); assert.equal(a.position.marginBalance, "300.00400000");
  assert.ok(new D(a.position.entryPrice).minus("50000.6666666666666666667").abs().lt(".000000000000000001"));
  const part = c.reducePosition(a, { contracts: "1", fillPrice: "50010", liquidityRole: "taker" });
  assert.equal(part.realizedPnl, "0.09333333"); assert.equal(part.account.position.entryNotional, "1000.01333333");
  const end = c.reducePosition(part.account, { contracts: "2", fillPrice: "50010", liquidityRole: "taker" });
  assert.equal(end.realizedPnl, "0.18666667"); assert.equal(end.account.availableBalance, "9998.77984000");
});

for (const side of ["long", "short"]) test(`same-side ${side} additions preserve old margin/topup, weighted cost and actual quantity protection`, () => {
  const s = sample(); flat(s, "last", 1, "50001"); const e = engine(s);
  let state = opened(e, { side, contracts: "1" }, { stopLoss: { price: side === "long" ? "40000" : "60000" } });
  state = act(e, state, { type: "add-margin", amount: "100" });
  const result = advance(e, act(e, state, { type: "market-open", side, contracts: "2" }));
  assert.equal(result.state.account.position.contracts, "3"); assert.equal(result.state.account.position.marginBalance, "400.00400000");
  assert.equal(result.state.protection.contracts, "3"); assert.equal(result.state.account.position.entryNotional, "1500.02000000");
  assert.throws(() => e.apply(result.state, { type: "market-open", side: side === "long" ? "short" : "long", contracts: "1" }), error("POSITION_SIDE_MISMATCH"));
  bridge(result.state);
});

test("addition validates total position tier leverage, not the added slice", () => {
  const e = engine(); const state = opened(e, { startingCash: "1000000", leverage: "100", contracts: "1000" });
  assert.throws(() => e.apply(state, { type: "market-open", side: "long", contracts: ".01" }), error("INVALID_LEVERAGE"));
});

test("immediate limit fill is taker and cannot break limit after slippage", () => {
  const e = engine(sample(), { slippageBps: 2 });
  const pending = act(e, e.create(), { type: "limit-open", side: "long", contracts: "10", limitPrice: "50020" });
  const result = advance(e, pending); assert.equal(fills(result)[0].quote.liquidityRole, "taker");
  assert.equal(fills(result)[0].quote.fillPrice, "50010.0");
  const waiting = advance(e, act(e, e.create(), { type: "limit-open", side: "long", contracts: "10", limitPrice: "50000" }));
  assert.equal(fills(waiting).length, 0); assert.equal(waiting.state.orders.length, 1);
  assert.ok(waiting.events.some((x) => x.type === "limit-waiting")); assert.equal(waiting.state.totals.tradingFees, "0.00000000");
});

for (const side of ["long", "short"]) test(`waiting ${side} limit requires a full tick through, fills at limit as maker`, () => {
  const s = sample(); const limit = side === "long" ? "49900" : "50100";
  set(s, "last", 0, side === "long" ? { low: limit } : { high: limit });
  set(s, "last", 1, side === "long" ? { low: "49899.9" } : { high: "50100.1" });
  const e = engine(s); let state = act(e, e.create(), { type: "limit-open", side, contracts: "10", limitPrice: limit });
  const touch = advance(e, state); assert.equal(fills(touch).length, 0); assert.equal(touch.state.orders.length, 1);
  const crossed = advance(e, touch.state); assert.equal(fills(crossed)[0].quote.liquidityRole, "maker");
  assert.ok(new D(fills(crossed)[0].quote.fillPrice).eq(limit)); assert.equal(crossed.state.totals.tradingFees, side === "long" ? "0.99800000" : "1.00200000");
});

test("partial market IOC shares contract capacity by ID, cancels only unfilled, charges actual fills", () => {
  const s = sample(); set(s, "last", 0, { volumeContracts: "5.009" }); const e = engine(s);
  let state = act(e, e.create(), { type: "market-open", side: "long", contracts: "4" });
  state = act(e, state, { type: "market-open", side: "long", contracts: "4" });
  const result = advance(e, state);
  assert.deepEqual(fills(result).map((x) => x.quote.contracts), ["4", "1"]);
  assert.equal(result.state.account.position.contracts, "5"); assert.equal(result.state.totals.tradingFees, "1.25000000");
  assert.equal(result.state.orders.length, 0); assert.equal(result.state.reservedBalance, "0.00000000"); bridge(result.state);
});

test("partial GTC keeps remaining reserve, next fill is maker, cancellation cannot revive", () => {
  const s = sample(); set(s, "last", 0, { volumeContracts: "4" }); flat(s, "last", 1, "49999.9");
  const e = engine(s); const initial = act(e, e.create(), { type: "limit-open", side: "long", contracts: "10", limitPrice: "50000" });
  const first = advance(e, initial); assert.equal(first.state.orders[0].remainingContracts, "6");
  assert.equal(first.state.reservedBalance, "601.50000000"); assert.equal(first.state.totals.tradingFees, "1.00000000");
  const second = advance(e, first.state); assert.equal(fills(second)[0].quote.liquidityRole, "maker");
  assert.equal(second.state.account.position.contracts, "10"); assert.equal(second.state.totals.tradingFees, "1.60000000");
  const cancelled = act(e, first.state, { type: "cancel-order", orderId: 1 });
  assert.equal(cancelled.account.position.contracts, "4"); assert.equal(cancelled.reservedBalance, "0.00000000");
  assert.throws(() => e.apply(cancelled, { type: "cancel-order", orderId: 1 }), error("ORDER_NOT_ACTIVE"));
  assert.equal(advance(e, cancelled, 3).state.account.position.contracts, "4"); bridge(second.state);
});

test("zero capacity and gap cash only permit affordable quantity, never overdraw or a fee for no fill", () => {
  const s = sample(); set(s, "last", 0, { volumeContracts: "0" }); const e = engine(s);
  const result = advance(e, act(e, e.create(), { type: "market-open", side: "long", contracts: "10" }));
  assert.equal(fills(result).length, 0); assert.equal(result.state.account.availableBalance, "10000.00000000");
  const gap = sample(); flat(gap, "last", 0, "60000"); const eg = engine(gap);
  const g = advance(eg, act(eg, eg.create({ startingCash: "1003" }), { type: "market-open", side: "long", contracts: "10" }));
  assert.equal(g.state.account.position.contracts, "8.33"); assert.ok(new D(g.state.account.availableBalance).gte(0)); bridge(g.state);
});

test("protective quantities shrink on manual partial close; full exit clears old pending adds and protection", () => {
  const e = engine(); let s = opened(e, {}, { stopLoss: { price: "45000" }, takeProfit: { price: "55000" } });
  s = advance(e, act(e, s, { type: "market-close", contracts: "4" })).state;
  assert.equal(s.protection.contracts, "6");
  s = act(e, s, { type: "limit-open", side: "long", contracts: "2", limitPrice: "40000" });
  s = act(e, s, { type: "market-close" }); const result = advance(e, s);
  assert.equal(result.state.account.position, null); assert.equal(result.state.protection, null); assert.equal(result.state.orders.length, 0);
  assert.equal(result.state.reservedBalance, "0.00000000"); bridge(result.state);
});

test("cancelling one protective leg does not close or turn the other into a canceled order", () => {
  const e = engine(); const s = opened(e, {}, { stopLoss: { price: "45000" }, takeProfit: { price: "55000" } });
  const cancelled = act(e, s, { type: "cancel-protection", leg: "stopLoss" });
  assert.ok(cancelled.account.position); assert.equal(cancelled.protection.stopLoss, null); assert.ok(cancelled.protection.takeProfit);
  const all = act(e, cancelled, { type: "cancel-protection" }); assert.equal(all.protection, null); assert.ok(all.account.position);
});

test("dual SL/TP touch picks conservative stop, cancels sibling, and uses taker fee once", () => {
  const s = sample(); set(s, "last", 1, { low: "48000", high: "52000" }); const e = engine(s);
  const result = advance(e, opened(e, {}, { stopLoss: { price: "49000" }, takeProfit: { price: "51000" } }));
  const trigger = result.events.find((x) => x.type === "protection-triggered");
  assert.equal(trigger.leg, "stopLoss"); assert.equal(trigger.siblingCancelled, true);
  assert.equal(fills(result)[0].quote.fillPrice, "49000.0"); assert.equal(fills(result)[0].quote.liquidityRole, "taker");
  assert.equal(result.state.account.availableBalance, "9895.05000000"); assert.equal(result.state.protection, null);
  assert.ok(result.events.some((x) => x.type === "intraminute-ambiguity")); bridge(result.state);
});

test("partial protective exit cancels sibling, retains triggered remainder and exits next open with no revival", () => {
  const s = sample(); set(s, "last", 1, { low: "48000", volumeContracts: "4" }); const e = engine(s);
  const result = advance(e, opened(e, {}, { stopLoss: { price: "49000" }, takeProfit: { price: "51000" } }));
  assert.equal(result.state.account.position.contracts, "6"); assert.equal(result.state.protection.contracts, "6");
  assert.equal(result.state.protection.triggeredLeg, "stopLoss"); assert.equal(result.state.protection.takeProfit, null);
  const next = advance(e, result.state); assert.equal(next.state.account.position, null); assert.equal(next.state.protection, null);
  assert.equal(fills(next)[0].quote.contracts, "6"); assert.equal(fills(next)[0].phase, "open"); bridge(next.state);
});

test("zero-volume triggered protection keeps pending exit, cancels adds, user may cancel it without closing", () => {
  const s = sample(); set(s, "last", 1, { low: "48000", volumeContracts: "0" }); const e = engine(s);
  let state = opened(e, {}, { stopLoss: { price: "49000" }, takeProfit: { price: "51000" } });
  state = act(e, state, { type: "limit-open", side: "long", contracts: "1", limitPrice: "40000" });
  const result = advance(e, state); assert.equal(fills(result).length, 0); assert.equal(result.state.orders.length, 0);
  assert.equal(result.state.protection.triggeredLeg, "stopLoss"); assert.equal(result.state.totals.tradingFees, "2.50000000");
  const cancelled = act(e, result.state, { type: "cancel-protection" }); assert.ok(advance(e, cancelled).state.account.position);
});

test("mark-referenced protection uses ordinary adverse price proxy; last-only and mark-only triggers stay separate", () => {
  const s = sample(); set(s, "mark", 1, { low: "48000" }); set(s, "last", 1, { low: "49500" }); const e = engine(s);
  const mark = advance(e, opened(e, {}, { stopLoss: { price: "49000", reference: "mark" } }));
  assert.equal(fills(mark)[0].quote.fillPrice, "49500.0"); assert.match(fills(mark)[0].phase, /adverse-last-proxy/);
  const last = advance(e, opened(e, {}, { stopLoss: { price: "49000", reference: "last" } }));
  assert.ok(last.state.account.position); assert.equal(fills(last).length, 0);
});

test("known opening protection exit precedes later mark low; mark opening liquidation cancels user exits", () => {
  const s = sample(); flat(s, "last", 1, "48000"); set(s, "mark", 1, { low: "30000" }); const e = engine(s);
  const result = advance(e, opened(e, {}, { stopLoss: { price: "49000" } }));
  assert.equal(result.events.some((x) => x.type === "teaching-liquidation"), false);
  assert.equal(fills(result)[0].phase, "open");
  const gap = sample(); flat(gap, "mark", 1, "30000"); const eg = engine(gap);
  const before = act(eg, opened(eg), { type: "market-close" }); const liquidated = advance(eg, before);
  assert.equal(fills(liquidated).length, 0); assert.equal(liquidated.events.filter((x) => x.type === "teaching-liquidation").length, 1);
  assert.equal(liquidated.state.orders.length, 0); bridge(liquidated.state);
});

test("same-minute liquidation/SL/TP/limit/funding ambiguity never double-posts or revives canceled orders", () => {
  const s = sample(); const funding = s.funding.find((f) => f.ts === START + 60 * M); funding.ts += 1000; funding.settledRate = ".001";
  set(s, "last", 60, { low: "38000", high: "52000" }); set(s, "mark", 60, { low: "30000", high: "52000" }); const e = engine(s);
  let state = advance(e, opened(e, {}, { stopLoss: { price: "49000" }, takeProfit: { price: "51000" } }), 59).state;
  state = act(e, state, { type: "limit-open", side: "long", contracts: "2", limitPrice: "40000" });
  const result = advance(e, state);
  assert.ok(result.events.some((x) => x.type === "intraminute-ambiguity"));
  assert.ok(result.events.filter((x) => x.type === "teaching-liquidation").length <= 1);
  assert.ok(result.events.filter((x) => x.type === "funding-settled").length <= 1);
  assert.equal(result.state.account.position, null); assert.equal(result.state.protection, null); assert.equal(result.state.orders.length, 0);
  bridge(result.state);
});

test("manual close orders are reduce-only and shared capacity prevents over-closing", () => {
  const s = sample(); set(s, "last", 1, { volumeContracts: "5" }); const e = engine(s);
  let state = act(e, opened(e), { type: "market-close", contracts: "4" });
  assert.throws(() => e.apply(state, { type: "market-close", contracts: "7" }), error("OVER_REDUCTION"));
  state = act(e, state, { type: "market-close", contracts: "6" });
  const result = advance(e, state); assert.deepEqual(fills(result).map((x) => x.quote.contracts), ["4", "1"]);
  assert.equal(result.state.account.position.contracts, "5"); assert.equal(result.state.orders.length, 0); bridge(result.state);
});

test("end and finish cancel orders/protection, use only future opens, retry partial exits, and report frozen-window shortage", () => {
  const s = sample(); set(s, "last", 1, { volumeContracts: "4" }); const e = engine(s);
  let state = opened(e, {}, { stopLoss: { price: "45000" } });
  state = act(e, state, { type: "limit-open", side: "long", contracts: "1", limitPrice: "40000" });
  const finish = e.apply(state, { type: "finish" }); assert.equal(finish.state.orders.length, 0); assert.equal(finish.state.protection, null);
  assert.ok(finish.state.account.position); assert.throws(() => e.apply(finish.state, { type: "market-close" }), error("ENDING_IN_PROGRESS"));
  const partial = advance(e, finish.state); assert.equal(partial.state.account.position.contracts, "6");
  const ended = advance(e, partial.state); assert.equal(ended.state.status, "completed"); assert.equal(ended.state.elapsedMinutes, 3);
  const blockedData = sample(); set(blockedData, "last", 180, { volumeContracts: "4" }); const eb = engine(blockedData);
  const blocked = advance(eb, opened(eb), 180); assert.equal(blocked.state.status, "end-blocked"); assert.equal(blocked.state.account.position.contracts, "6");
  assert.equal(blocked.events.some((x) => x.type === "teaching-liquidation"), false);
  assert.equal(act(e, e.create(), { type: "finish" }).status, "completed");
});

test("1/5/15/full advances give identical state and traces including active GTC, additions, protection and seconds funding", () => {
  const s = sample(); set(s, "last", 50, { low: "48000", volumeContracts: "4" });
  const funding = s.funding.find((f) => f.ts === START + 60 * M); funding.ts += 1000; funding.settledRate = ".0001";
  const e = engine(s); let initial = opened(e, {}, { stopLoss: { price: "45000" }, takeProfit: { price: "55000" } });
  initial = act(e, initial, { type: "limit-open", side: "long", contracts: "6", limitPrice: "49000" });
  const run = (step) => { let state = initial; const events = []; while (state.status === "active") { const r = advance(e, state, step); state = r.state; events.push(...r.events); } return { state, events }; };
  const expected = run(181); for (const step of [1, 5, 15]) assert.deepEqual(run(step), expected);
});

test("no future price/volume/final funding leakage and event pause stops before later triggers", () => {
  const s = sample(); const future = clone(s); for (const kind of ["last", "mark"]) for (const b of future[kind]) if (b.ts >= START + 5 * M) Object.assign(b, { open: "10000", high: "10000", low: "10000", close: "10000" });
  for (const f of future.funding) if (f.ts > START + 5 * M) f.settledRate = ".99";
  const run = (data) => { const e = engine(data); return advance(e, act(e, e.create(), { type: "market-open", side: "long", contracts: "10", protection: { stopLoss: { price: "45000" } } }), 5); };
  assert.deepEqual(run(s), run(future));
  const e = engine(s), state = act(e, e.create(), { type: "market-open", side: "long", contracts: "10" });
  const result = e.apply(state, { type: "advance", minutes: 15 }); assert.equal(result.state.elapsedMinutes, 1); assert.equal(result.advancedMinutes, 1);
});

test("invalid tick, reference, quantity, duplicate cancel, incompatible version and malformed cursor fail explicitly", () => {
  const e = engine(); const s = opened(e);
  assert.throws(() => e.apply(s, { type: "limit-open", side: "long", contracts: "1", limitPrice: "49900.01" }), error("INVALID_PRICE_TICK"));
  assert.throws(() => e.apply(s, { type: "set-protection", stopLoss: { price: "45000", reference: "index" } }), error("INVALID_PROTECTION_REFERENCE"));
  assert.throws(() => e.apply(s, { type: "set-protection" }), error("INVALID_PROTECTION"));
  assert.throws(() => e.apply(e.create(), { type: "market-open", side: "long", contracts: ".001" }), error("INVALID_QUANTITY"));
  const bad = clone(s); bad.versions.executionVersion = "okx-market-minute-teaching-v1"; assert.throws(() => advance(e, bad), error("STATE_VERSION_MISMATCH"));
  const cursor = clone(s); cursor.elapsedMinutes = -1; assert.throws(() => advance(e, cursor), error("INVALID_STATE"));
});

test("inputs and outputs stay JSON values; executor only imports pure calculation and scenario modules", () => {
  const data = sample(), e = engine(data), initial = e.create(), saved = clone(initial);
  const result = e.apply(initial, { type: "market-open", side: "long", contracts: "10" }); assert.deepEqual(initial, saved);
  result.events[0].order.remainingContracts = "999"; assert.equal(advance(e, result.state).state.account.position.contracts, "10");
  flat(data, "last", 0, "1"); assert.equal(advance(e, result.state).state.account.position.entryPrice, "50000.0");
  assert.deepEqual(JSON.parse(JSON.stringify(result.state)), result.state);
  const source = readFileSync(new URL("./replay-crypto-order-execution.js", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((x) => x[1]), ["decimal.js", "./replay-crypto-calculations.js", "./replay-crypto-scenario.js"]);
});

test("partially filled entry cannot re-arm a user-cancelled attached protective leg", () => {
  const data = sample(); set(data, "last", 0, { volumeContracts: "4" }); flat(data, "last", 1, "49999.9");
  const e = engine(data); let s = act(e, e.create(), { type: "limit-open", side: "long", contracts: "10", limitPrice: "50000",
    protection: { stopLoss: { price: "45000" }, takeProfit: { price: "55000" } } });
  s = advance(e, s).state; s = act(e, s, { type: "cancel-protection", leg: "stopLoss" });
  s = advance(e, s).state; assert.equal(s.account.position.contracts, "10"); assert.equal(s.protection.stopLoss, null); assert.ok(s.protection.takeProfit);
});

test("triggered protective exit blocks additions and cancelling its already absent sibling cannot cancel the active exit", () => {
  const data = sample(); set(data, "last", 1, { low: "48000", volumeContracts: "0" }); const e = engine(data);
  const s = advance(e, opened(e, {}, { stopLoss: { price: "49000" }, takeProfit: { price: "51000" } })).state;
  assert.throws(() => e.apply(s, { type: "market-open", side: "long", contracts: "1" }), error("PROTECTION_EXIT_PENDING"));
  assert.throws(() => e.apply(s, { type: "cancel-protection", leg: "takeProfit" }), error("NO_PROTECTION"));
  assert.equal(advance(e, s).state.account.position, null);
});

test("short stop loss buys to close; short take profit and mark-triggered closing cannot reverse", () => {
  for (const [leg, patch, price] of [["stopLoss", { high: "52000" }, "51000"], ["takeProfit", { low: "48000" }, "49000"]]) {
    const data = sample(); set(data, "last", 1, patch); const e = engine(data);
    const r = advance(e, opened(e, { side: "short" }, { [leg]: { price } }));
    assert.equal(r.state.account.position, null); assert.equal(fills(r)[0].side, "short");
    assert.ok(new D(fills(r)[0].quote.fillPrice).eq(price)); assert.equal(r.state.protection, null); bridge(r.state);
  }
});

test("new weighted cost rejects negative values; canceled active orders release only their own reserve", () => {
  const c = createCryptoCalculator({ rules, instrumentId: "BTC-USDT-SWAP" });
  assert.throws(() => c.assessPosition({ instrumentId: "BTC-USDT-SWAP", side: "long", contracts: "1", entryPrice: "50000", marginBalance: "100", entryNotional: "-1" }, "50000"), error("INVALID_POSITION"));
  const e = engine(); let s = act(e, e.create(), { type: "limit-open", side: "long", contracts: "1", limitPrice: "49000" });
  s = act(e, s, { type: "limit-open", side: "long", contracts: "2", limitPrice: "48000" });
  const cancelled = act(e, s, { type: "cancel-order", orderId: 1 });
  assert.equal(cancelled.orders.length, 1); assert.equal(cancelled.orders[0].id, 2);
  assert.equal(cancelled.reservedBalance, "192.48000000"); bridge(cancelled);
});

const liquidationOracles = JSON.parse(readFileSync(new URL("../../docs/research/okx-rule-snapshots/2026-10-19-liquidation-teaching-cases.json", import.meta.url)));
for (const c of liquidationOracles.cases) test(`P3b approved takeover oracle ${c.id}: single aggregate, exact outside cash and non-posting references`, () => {
  const x = c.inputs, expected = c.expected, data = sample(x.instrument, x.entryFillPrice);
  const funded = new D(x.fundingAlreadyPaid).gt(0);
  if (funded) data.funding.find((f) => f.ts === START + 60 * M).settledRate = new D(x.fundingAlreadyPaid).div(new D(x.baseQuantity).times(x.entryFillPrice)).toFixed();
  if (c.id !== "funding_negative_margin_boundary") flat(data, "mark", funded ? 60 : 1, x.referenceMark);
  const e = engine(data); let s = opened(e, { side: c.side, contracts: x.contracts, startingCash: x.startingCash });
  if (new D(x.manualTopup).gt(0)) s = act(e, s, { type: "add-margin", amount: x.manualTopup });
  const result = advance(e, s, funded ? 60 : 1), takeovers = result.events.filter((x) => x.type === "teaching-liquidation");
  assert.equal(takeovers.length, 1); const settlement = takeovers[0].settlement;
  assert.equal(settlement.aggregateSettlementPnl, expected.aggregateSettlementPnl);
  assert.equal(settlement.reference.takerFee, expected.referenceTakerFeeMemoOnly);
  assert.equal(settlement.reference.deficitWaiver, expected.deficitWaiverMemoOnly);
  assert.equal(settlement.reference.remainingEquityWriteoff, expected.remainingEquityWriteoffMemoOnly);
  assert.equal(settlement.actualLiquidationFillPrice, null); assert.equal(settlement.officialClearanceFee, null);
  assert.equal(result.state.account.availableBalance, expected.finalOutsideCash);
  assert.equal(result.state.summary.netPnl, expected.netSessionPnl); assert.equal(result.state.account.position, null);
  assert.equal(result.state.totals.tradingFees, x.openingFeeAlreadyPaid); bridge(result.state);
});

for (const side of ['long','short']) test(`amend ${side} limit atomically reprices only remaining quantity and executes from next unseen minute`,()=>{
  const source=sample();set(source,'last',0,{volumeContracts:'2'});
  const e=engine(source),protection={stopLoss:{price:side==='long'?'40000':'60000',reference:'mark'}};
  let state=act(e,e.create(),{type:'limit-open',side,contracts:'4',limitPrice:'50000',protection});
  state=advance(e,state).state;
  assert.equal(state.orders[0].filledContracts,'2');assert.equal(state.orders[0].remainingContracts,'2');
  const before=clone(state),limitPrice=side==='long'?'50100':'49900';
  const result=e.apply(state,{type:'amend-limit',orderId:1,limitPrice});
  assert.deepEqual(state,before);state=result.state;
  assert.equal(state.elapsedMinutes,before.elapsedMinutes);assert.deepEqual(state.account.position,before.account.position);
  assert.deepEqual(state.protection,before.protection);assert.deepEqual(state.totals,before.totals);
  assert.deepEqual(state.orders[0],{...before.orders[0],limitPrice,submittedMinute:1,resting:false,blockedAtMinute:null,reservedBalance:state.orders[0].reservedBalance});
  assert.deepEqual(result.events.map(x=>x.type),['order-amended']);bridge(state);
  const filled=advance(e,state);assert.equal(fills(filled)[0].quote.contracts,'2');
  assert.equal(fills(filled)[0].quote.liquidityRole,'taker');assert.equal(filled.state.account.position.contracts,'4');
  assert.equal(filled.state.orders.length,0);bridge(filled.state);
});

test('failed limit amendment preserves old price, reserve and queue; market/absent/ended orders reject',()=>{
  const e=engine();let state=act(e,e.create({startingCash:'101'}),{type:'limit-open',side:'long',contracts:'1',limitPrice:'49000'});
  const before=clone(state);
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:1,limitPrice:'60000'}),error('INSUFFICIENT_CASH'));
  assert.deepEqual(state,before);
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:1,limitPrice:'49000.01'}),error('INVALID_PRICE_TICK'));
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:'1',limitPrice:'48000'}),error('INVALID_ORDER_ID'));
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:2,limitPrice:'48000'}),error('ORDER_NOT_ACTIVE'));
  state=act(e,e.create(),{type:'market-open',side:'long',contracts:'1'});
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:1,limitPrice:'48000'}),error('ORDER_NOT_ACTIVE'));
  state=act(e,state,{type:'finish'});
  assert.throws(()=>e.apply(state,{type:'amend-limit',orderId:1,limitPrice:'48000'}),error('REPLAY_NOT_ACTIVE'));
});

for(const side of ['long','short']) test(`amended ${side} reduce limit preserves reduce-only size and has no margin reserve`,()=>{
  const e=engine();let state=opened(e,{side,contracts:'4'});
  state=act(e,state,{type:'limit-close',contracts:'2',limitPrice:side==='long'?'51000':'49000'});
  const before=clone(state),order=state.orders[0];
  state=act(e,state,{type:'amend-limit',orderId:order.id,limitPrice:side==='long'?'49900':'50100'});
  assert.equal(state.orders[0].remainingContracts,'2');assert.equal(state.orders[0].intent,'reduce');
  assert.equal(state.reservedBalance,'0.00000000');assert.deepEqual(state.account,before.account);
  const filled=advance(e,state);assert.equal(filled.state.account.position.contracts,'2');assert.equal(fills(filled)[0].quote.contracts,'2');bridge(filled.state);
});

test('a price change loses queue priority even when its stable order ID is older',()=>{
  const source=sample();set(source,'last',0,{volumeContracts:'1'});const e=engine(source);
  let state=act(e,e.create(),{type:'limit-open',side:'long',contracts:'1',limitPrice:'49000'});
  state=act(e,state,{type:'limit-open',side:'long',contracts:'1',limitPrice:'50100'});
  state=act(e,state,{type:'amend-limit',orderId:1,limitPrice:'50200'});
  assert.deepEqual(state.orders.map(o=>o.id),[2,1]);
  const filled=advance(e,state);assert.equal(fills(filled)[0].orderId,2);assert.equal(state.elapsedMinutes,0);
});

test('changing every unseen candle cannot alter an amendment or its reserve',()=>{
  const original=sample(),altered=clone(original);
  for(const kind of ['last','mark']) for(const b of altered[kind]) if(b.ts>=START) Object.assign(b,{open:'90000',high:'90000',low:'90000',close:'90000'});
  const run=source=>{const e=engine(source);const state=act(e,e.create(),{type:'limit-open',side:'long',contracts:'2',limitPrice:'49000'});return e.apply(state,{type:'amend-limit',orderId:1,limitPrice:'49500'});};
  assert.deepEqual(run(original),run(altered));
});


for(const side of ['long','short']) test(`remaining ${side} quantity amendment preserves partial fills and uses only unseen minutes`,()=>{
  const source=sample();set(source,'last',0,{volumeContracts:'2'});
  const e=engine(source),protection={stopLoss:{price:side==='long'?'40000':'60000',reference:'mark'}};
  let state=act(e,e.create(),{type:'limit-open',side,contracts:'4',limitPrice:'50000',protection});
  state=advance(e,state).state;const before=clone(state);
  assert.equal(state.orders[0].filledContracts,'2');assert.equal(state.orders[0].remainingContracts,'2');
  for(const remaining of ['1','3']) {
    const result=e.apply(state,{type:'amend-quantity',orderId:1,remainingContracts:remaining}),after=result.state,o=after.orders[0];
    assert.deepEqual(state,before);assert.equal(o.filledContracts,'2');assert.equal(o.remainingContracts,remaining);assert.equal(o.contracts,String(2+Number(remaining)));
    assert.equal(o.limitPrice,'50000');assert.deepEqual(o.attachedProtection,before.orders[0].attachedProtection);
    assert.deepEqual(after.account.position,before.account.position);assert.deepEqual(after.protection,before.protection);assert.deepEqual(after.totals,before.totals);
    assert.equal(after.elapsedMinutes,before.elapsedMinutes);assert.equal(o.resting,false);bridge(after);
    assert.equal(new D(after.reservedBalance).cmp(before.reservedBalance),Number(remaining)<2?-1:1);
    assert.equal(result.events[0].type,'order-quantity-amended');assert.equal(result.events[0].oldRemainingContracts,'2');assert.equal(result.events[0].filledContracts,'2');
    const next=advance(e,after);assert.equal(fills(next)[0].quote.contracts,remaining);assert.equal(next.state.account.position.contracts,String(2+Number(remaining)));bridge(next.state);
  }
});

test('quantity amendments reject invalid size or insufficient cash atomically and preserve sibling closes',()=>{
  const e=engine();let s=act(e,e.create({startingCash:'101'}),{type:'limit-open',side:'long',contracts:'1',limitPrice:'49000'}),before=clone(s);
  for(const remainingContracts of ['0','0.001','-1','100000001','2']) {
    assert.throws(()=>e.apply(s,{type:'amend-quantity',orderId:1,remainingContracts}));assert.deepEqual(s,before);
  }
  assert.throws(()=>e.apply(s,{type:'amend-quantity',orderId:1,remainingContracts:'1'}),error('UNCHANGED_ORDER_QUANTITY'));
  assert.throws(()=>e.apply(s,{type:'amend-quantity',orderId:99,remainingContracts:'1'}),error('ORDER_NOT_ACTIVE'));
  s=opened(e,{contracts:'3'});s=act(e,s,{type:'limit-close',contracts:'1',limitPrice:'51000'});s=act(e,s,{type:'limit-close',contracts:'1',limitPrice:'52000'});before=clone(s);
  const target=s.orders[0],sibling=s.orders[1];
  assert.throws(()=>e.apply(s,{type:'amend-quantity',orderId:target.id,remainingContracts:'3'}),error('OVER_REDUCTION'));assert.deepEqual(s,before);
  const after=act(e,s,{type:'amend-quantity',orderId:target.id,remainingContracts:'2'});
  assert.deepEqual(after.orders.find(o=>o.id===sibling.id),sibling);assert.deepEqual(after.account.position,s.account.position);bridge(after);
});

test('pending market quantity amendment executes only the confirmed remaining quantity on advance',()=>{
  const e=engine();let s=act(e,e.create(),{type:'market-open',side:'short',contracts:'1'});
  s=act(e,s,{type:'amend-quantity',orderId:1,remainingContracts:'2'});
  assert.equal(s.elapsedMinutes,0);assert.equal(s.account.position,null);assert.equal(s.orders[0].filledContracts,'0');bridge(s);
  const next=advance(e,s);assert.equal(next.state.account.position.contracts,'2');assert.equal(next.state.account.position.side,'short');bridge(next.state);
});


test('combined amendment reserves the final price and remaining size once without touching partial fills',()=>{
  const source=sample();set(source,'last',0,{volumeContracts:'2'});const e=engine(source);
  let s=act(e,e.create({startingCash:'405'}),{type:'limit-open',side:'long',contracts:'4',limitPrice:'50000'});s=advance(e,s).state;
  const before=clone(s),o=s.orders[0];assert.equal(o.filledContracts,'2');
  // Increasing quantity at the old price alone is unaffordable; the combined lower price fits.
  assert.throws(()=>e.apply(s,{type:'amend-quantity',orderId:o.id,remainingContracts:'3'}),error('INSUFFICIENT_CASH'));
  const result=e.apply(s,{type:'amend-order',orderId:o.id,limitPrice:'30000',remainingContracts:'3'}),after=result.state;
  assert.deepEqual(s,before);assert.equal(after.orders[0].filledContracts,'2');assert.equal(after.orders[0].remainingContracts,'3');assert.equal(after.orders[0].contracts,'5');assert.equal(after.orders[0].limitPrice,'30000');
  assert.deepEqual(after.account.position,before.account.position);assert.deepEqual(after.totals,before.totals);assert.equal(after.elapsedMinutes,before.elapsedMinutes);bridge(after);
  assert.equal(result.events.length,1);assert.equal(result.events[0].type,'order-updated');
  assert.throws(()=>e.apply(s,{type:'amend-order',orderId:o.id,limitPrice:'60000',remainingContracts:'3'}),error('INSUFFICIENT_CASH'));assert.deepEqual(s,before);
  assert.throws(()=>e.apply(s,{type:'amend-order',orderId:o.id,limitPrice:'30000',remainingContracts:'0.001'}));assert.deepEqual(s,before);
});
