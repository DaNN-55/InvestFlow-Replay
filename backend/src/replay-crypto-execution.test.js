import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { createCryptoMarketReplay, CRYPTO_EXECUTION_VERSION } from "./replay-crypto-execution.js";
import { MINUTE_MS as M } from "./replay-crypto-scenario.js";
const D = Decimal.clone({ precision: 96 });
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../docs/research/okx-rule-snapshots/${name}`, import.meta.url)));
const rules = fixture("2026-10-19-training-rule-manifest.draft.json");
const goldens = fixture("2026-10-19-liquidation-teaching-cases.json");
const START = Date.parse("2024-01-01T00:00:00+08:00");
const error = (code) => (e) => e.code === code;
const clone = (v) => structuredClone(v);
function sample(instrumentId = "BTC-USDT-SWAP", price = "50000") {
  const window = { backgroundStartMs: START - 60 * M, replayStartMs: START, replayEndMs: START + 180 * M, executionEndMs: START + 181 * M };
  const bars = Array.from({ length: 241 }, (_, i) => ({ ts: window.backgroundStartMs + i * M,
    open: price, high: price, low: price, close: price, sourceConfirm: "1" }));
  return { instrumentId, window, mark: clone(bars), last: bars.map((b) => ({ ...b, volumeContracts: "100000", volumeBase: "1000", volumeQuote: "50000000" })),
    fundingAudit: { cadenceMs: 60 * M, maxSourceOffsetMs: 2000 },
    funding: Array.from({ length: 7 }, (_, i) => ({ ts: START + (i - 2) * 60 * M, settledRate: "0" })) };
}
function setBar(s, kind, minute, values) { Object.assign(s[kind][60 + minute], values); }
function flatBar(s, kind, minute, price) { setBar(s, kind, minute, { open: price, high: price, low: price, close: price }); }
function rate(s, minute, settledRate, offset = 0) { const event = s.funding.find((e) => e.ts === START + minute * M); event.settledRate = settledRate; event.ts += offset; }
const engine = (s = sample(), extra = {}) => createCryptoMarketReplay({ rules, scenario: s, dataVersion: "synthetic-v1", slippageBps: 0, ...extra });
const apply = (e, s, command) => e.apply(s, command).state;
const advance = (e, s, minutes = 1) => e.apply(s, { type: "advance", minutes, stopOnEvent: false });
function opened(e, { side = "long", contracts = "10", ...config } = {}) {
  const initial = e.create(config);
  return advance(e, apply(e, initial, { type: "market-open", side, contracts })).state;
}
function assertBridge(s) {
  const t = s.totals;
  const recognized = new D(t.realizedPricePnl).minus(t.tradingFees).minus(t.fundingPayments).plus(t.liquidationAggregatePnl);
  const actual = new D(s.account.availableBalance).plus(s.reservedBalance).plus(s.account.position?.marginBalance ?? 0).plus(s.risk?.unrealizedPnl ?? 0);
  assert.equal(actual.toFixed(8), new D(s.startingCash).plus(recognized).plus(s.risk?.unrealizedPnl ?? 0).toFixed(8));
  assert.equal(actual.toFixed(8), s.summary.accountEquity);
}

test("market submit reserves cash using known close; fill waits for the unseen open, with adverse tick and fee", () => {
  const data = sample(); flatBar(data, "last", 0, "51000");
  const e = engine(data, { slippageBps: 2 }); const initial = e.create();
  const submitted = e.apply(initial, { type: "market-open", side: "long", contracts: "10" });
  assert.equal(submitted.state.account.position, null);
  assert.equal(submitted.state.reservedBalance, "1002.70050000");
  assert.equal(submitted.state.summary.accountEquity, "10000.00000000");
  assert.equal(submitted.events[0].estimate.fillPrice, "50010.0");
  const result = advance(e, submitted.state);
  assert.equal(result.state.account.position.entryPrice, "51010.2");
  assert.equal(result.state.account.position.marginBalance, "1020.20400000");
  assert.equal(result.state.totals.tradingFees, "2.55051000");
  assert.equal(result.state.reservedBalance, "0.00000000");
  assert.equal(result.events.find((x) => x.type === "market-filled").executionMinute, 0);
  assert.equal(initial.account.availableBalance, "10000.00000000"); assertBridge(result.state);
});

test("independent approved full round trip: costs, funding proxy and manual topup reconcile to 10042.46300500", () => {
  const s = sample(); for (let m = 10; m <= 60; m++) flatBar(s, "mark", m, "50200");
  flatBar(s, "last", 61, "50500"); rate(s, 60, ".0001");
  const e = engine(s, { slippageBps: 2 }); let state = opened(e);
  state = apply(e, state, { type: "add-margin", amount: "500" });
  state = advance(e, state, 60).state;
  assert.equal(state.totals.fundingPayments, "0.50200000");
  state = apply(e, state, { type: "market-close" }); const result = advance(e, state);
  assert.equal(result.state.account.availableBalance, "10042.46300500");
  assert.equal(result.state.totals.tradingFees, "5.02499500");
  assert.equal(result.state.totals.slippageAttribution, "2.01000000");
  assert.equal(result.state.account.position, null); assertBridge(result.state);
});

for (const side of ["long", "short"]) test(`${side}: partial and full market reductions preserve entry and use distinct directional fills`, () => {
  const s = sample(); flatBar(s, "last", 1, "51000"); flatBar(s, "last", 2, "50500");
  const e = engine(s); let state = opened(e, { side });
  state = advance(e, apply(e, state, { type: "market-close", contracts: "4" })).state;
  assert.equal(state.account.position.contracts, "6"); assert.ok(new D(state.account.position.entryPrice).eq("50000"));
  assert.equal(state.account.position.marginBalance, "600.00000000");
  assert.equal(state.totals.realizedPricePnl, side === "long" ? "40.00000000" : "-40.00000000");
  state = advance(e, apply(e, state, { type: "market-close" })).state;
  assert.equal(state.account.position, null);
  assert.equal(state.account.availableBalance, side === "long" ? "10064.96500000" : "9924.96500000");
  assertBridge(state);
});

test("flat-only opening and reduce-only closing reject reversal, additions, over-reduction and invalid quantities", () => {
  const e = engine(); const s = opened(e);
  for (const side of ["long", "short"]) assert.throws(() => e.apply(s, { type: "market-open", side, contracts: "1" }), error("POSITION_EXISTS"));
  assert.throws(() => e.apply(s, { type: "market-close", contracts: "10.01" }), error("OVER_REDUCTION"));
  assert.throws(() => e.apply(s, { type: "market-close", contracts: ".001" }), error("INVALID_QUANTITY"));
  assert.throws(() => e.apply(e.create(), { type: "market-close" }), error("NO_POSITION"));
  assert.throws(() => e.apply(e.create(), { type: "market-open", side: "both", contracts: "10" }), error("INVALID_SIDE"));
  assert.throws(() => e.apply(e.create(), { type: "limit-open" }), error("UNSUPPORTED_COMMAND"));
});

test("cash reserves release on cancellation and a gap rejection; neither charges fees", () => {
  const s = sample(); flatBar(s, "last", 0, "60000");
  const e = engine(s); const initial = e.create({ startingCash: "1003" });
  const pending = apply(e, initial, { type: "market-open", side: "long", contracts: "10" });
  const cancelled = e.apply(pending, { type: "cancel-market" });
  assert.equal(cancelled.state.account.availableBalance, "1003.00000000");
  const rejected = advance(e, pending);
  assert.equal(rejected.events.find((x) => x.type === "market-rejected").reason, "INSUFFICIENT_CASH");
  assert.equal(rejected.state.account.availableBalance, "1003.00000000");
  assert.equal(rejected.state.account.position, null); assert.equal(rejected.state.totals.tradingFees, "0.00000000");
  assert.throws(() => e.apply(initial, { type: "market-open", side: "long", contracts: "100" }), error("INSUFFICIENT_CASH"));
  assert.throws(() => e.apply(pending, { type: "market-open", side: "short", contracts: "1" }), error("MARKET_ORDER_PENDING"));
  assertBridge(rejected.state);
});

test("market size and ordinary contract volume are enforced, with no mark-volume or invented partial fill", () => {
  const s = sample(); setBar(s, "last", 0, { volumeContracts: "9.99" });
  const e = engine(s); const pending = apply(e, e.create(), { type: "market-open", side: "long", contracts: "10" });
  const result = advance(e, pending);
  assert.equal(result.events.find((x) => x.type === "market-rejected").reason, "MARKET_VOLUME_SHORTFALL");
  assert.equal(result.state.account.position, null); assert.equal(result.state.account.availableBalance, "10000.00000000");
  assert.throws(() => e.apply(e.create({ startingCash: "10000000" }), { type: "market-open", side: "long", contracts: "35000.01" }), error("MARKET_SIZE_LIMIT"));
});

test("zero available cash still permits risk-reducing closing", () => {
  const e = engine(); let state = opened(e, { startingCash: "1002.5" });
  assert.equal(state.account.availableBalance, "0.00000000");
  state = advance(e, apply(e, state, { type: "market-close" })).state;
  assert.equal(state.account.availableBalance, "997.50000000"); assertBridge(state);
});

test("normal exit cash deficit is explicit and is not silently waived as liquidation", () => {
  const s = sample(); flatBar(s, "last", 1, "30000"); const e = engine(s);
  const result = advance(e, apply(e, opened(e, { startingCash: "1002.5" }), { type: "market-close" }));
  assert.equal(result.state.account.availableBalance, "-1001.50000000");
  assert.equal(result.state.summary.cashDeficit, "1001.50000000");
  assert.equal(result.state.totals.deficitWaiverMemo, "0.00000000"); assertBridge(result.state);
});

for (const [side, settledRate, payment] of [["long", ".0001", "0.50000000"], ["long", "-.0001", "-0.50000000"],
  ["short", ".0001", "-0.50000000"], ["short", "-.0001", "0.50000000"]]) test(`funding ${side} ${settledRate}: only isolated margin changes and boundary replay does not charge twice`, () => {
  const s = sample(); rate(s, 60, settledRate); const e = engine(s); const initial = opened(e, { side });
  const result = advance(e, initial, 59); const charged = result.events.filter((x) => x.type === "funding-settled");
  assert.equal(charged.length, 1); assert.equal(charged[0].payment, payment); assert.equal(charged[0].relativeTimeMs, 60 * M);
  assert.equal(result.state.account.availableBalance, initial.account.availableBalance);
  assert.equal(result.state.account.position.marginBalance, new D(1000).minus(payment).toFixed(8));
  assert.equal(advance(e, result.state).state.totals.fundingPayments, payment); assertBridge(result.state);
});

test("exact-boundary funding belongs to pre-existing holdings and precedes next boundary market orders", () => {
  const s = sample(); rate(s, 60, ".0001"); const e = engine(s);
  let flat = advance(e, e.create(), 60).state;
  flat = advance(e, apply(e, flat, { type: "market-open", side: "long", contracts: "10" })).state;
  assert.equal(flat.totals.fundingPayments, "0.00000000");
  let held = advance(e, opened(e), 59).state;
  assert.equal(held.totals.fundingPayments, "0.50000000");
  held = advance(e, apply(e, held, { type: "market-close" })).state;
  assert.equal(held.totals.fundingPayments, "0.50000000");
  const before = advance(e, opened(e), 58).state;
  const exited = advance(e, apply(e, before, { type: "market-close" }));
  assert.equal(exited.state.totals.fundingPayments, "0.00000000");
  assert.ok(exited.events.some((x) => x.type === "funding-skipped"));
});

test("source +1 second funding: known open/close happen first, and proxy never uses current minute close", () => {
  const s = sample(); rate(s, 60, ".0001", 1000); flatBar(s, "mark", 60, "51000");
  const e = engine(s); const flat = advance(e, e.create(), 60).state;
  const result = advance(e, apply(e, flat, { type: "market-open", side: "long", contracts: "10" }));
  const f = result.events.find((x) => x.type === "funding-settled");
  assert.equal(f.relativeTimeMs, 60 * M + 1000); assert.equal(f.markReference.price, "50000");
  assert.equal(f.markReference.knownAtMinute, 60); assert.equal(f.payment, "0.50000000");
  assert.ok(result.events.findIndex((x) => x.type === "market-filled") < result.events.findIndex((x) => x.type === "funding-settled"));
  const held = advance(e, opened(e), 59).state;
  const exited = advance(e, apply(e, held, { type: "market-close" }));
  assert.equal(exited.state.totals.fundingPayments, "0.00000000");
});

test("manual topup transfers cash, preserves equity/quantity/entry and cannot exceed free cash", () => {
  const e = engine(); const s = opened(e); const topped = e.apply(s, { type: "add-margin", amount: "500" }).state;
  assert.equal(topped.account.availableBalance, "8497.50000000"); assert.equal(topped.account.position.marginBalance, "1500.00000000");
  assert.equal(topped.summary.accountEquity, s.summary.accountEquity); assert.ok(new D(topped.account.position.entryPrice).eq(s.account.position.entryPrice));
  assert.equal(topped.account.position.contracts, s.account.position.contracts);
  assert.ok(new D(topped.risk.estimatedLiquidationPrice).lt(s.risk.estimatedLiquidationPrice));
  for (const amount of ["0", "-1", "9000"]) assert.throws(() => e.apply(s, { type: "add-margin", amount }), error("INVALID_TOPUP"));
  assert.throws(() => e.apply(s, { type: "add-margin", amount: ".000000001" }), error("MONEY_PRECISION"));
  assertBridge(topped);
});

for (const c of goldens.cases) test(`approved liquidation oracle ${c.id}: execution derives cancellation, posts aggregate once, outside cash unchanged`, () => {
  const x = c.inputs, expected = c.expected;
  const data = sample(x.instrument, x.entryFillPrice);
  const hasFunding = new D(x.fundingAlreadyPaid).gt(0);
  if (hasFunding) rate(data, 60, new D(x.fundingAlreadyPaid).div(new D(x.baseQuantity).times(x.entryFillPrice)).toFixed());
  if (c.id !== "funding_negative_margin_boundary") flatBar(data, "mark", hasFunding ? 60 : 1, x.referenceMark);
  const e = engine(data); let state = opened(e, { side: c.side, contracts: x.contracts, startingCash: x.startingCash });
  if (new D(x.manualTopup).gt(0)) state = apply(e, state, { type: "add-margin", amount: x.manualTopup });
  const result = advance(e, state, hasFunding ? 60 : 1);
  const liquidations = result.events.filter((event) => event.type === "teaching-liquidation");
  assert.equal(liquidations.length, 1); const settlement = liquidations[0].settlement;
  assert.equal(settlement.aggregateSettlementPnl, expected.aggregateSettlementPnl);
  assert.equal(settlement.reference.takerFee, expected.referenceTakerFeeMemoOnly);
  assert.equal(settlement.reference.deficitWaiver, expected.deficitWaiverMemoOnly);
  assert.equal(settlement.reference.remainingEquityWriteoff, expected.remainingEquityWriteoffMemoOnly);
  assert.equal(settlement.actualLiquidationFillPrice, null); assert.equal(settlement.officialClearanceFee, null);
  assert.equal(result.state.account.availableBalance, expected.finalOutsideCash);
  assert.equal(result.state.summary.netPnl, expected.netSessionPnl); assert.equal(result.state.account.position, null);
  assert.equal(result.state.totals.tradingFees, x.openingFeeAlreadyPaid);
  assert.ok(result.events.some((event) => event.type === "risk-rechecked"));
  const later = advance(e, result.state, 10);
  assert.equal(later.state.totals.liquidationAggregatePnl, result.state.totals.liquidationAggregatePnl);
  assert.throws(() => e.apply(result.state, { type: "add-margin", amount: "1" }), error("INVALID_POSITION"));
  assertBridge(result.state);
});

test("mark opening gap cancels an already pending ordinary close before takeover, while later adverse mark cannot undo a completed open-price close", () => {
  const gap = sample(); flatBar(gap, "mark", 1, "40000"); const e1 = engine(gap);
  const result = advance(e1, apply(e1, opened(e1), { type: "market-close" }));
  assert.equal(result.events.filter((x) => x.type === "market-filled").length, 0);
  assert.deepEqual(result.events.find((x) => x.type === "orders-cancelled-for-risk").orderIds, [2]);
  assert.equal(result.events.find((x) => x.type === "teaching-liquidation").phase, "mark-open");
  const intrabar = sample(); setBar(intrabar, "mark", 1, { low: "40000" }); const e2 = engine(intrabar);
  const exited = advance(e2, apply(e2, opened(e2), { type: "market-close" }));
  assert.equal(exited.events.filter((x) => x.type === "market-filled").length, 1);
  assert.equal(exited.events.filter((x) => x.type === "teaching-liquidation").length, 0);
});

test("mark/last separation: last-only crash cannot trigger takeover; mark-only adverse extreme can", () => {
  const last = sample(); flatBar(last, "last", 1, "30000"); const e1 = engine(last);
  assert.ok(advance(e1, opened(e1)).state.account.position);
  const mark = sample(); setBar(mark, "mark", 1, { low: "30000" }); const e2 = engine(mark);
  const result = advance(e2, opened(e2)); const event = result.events.find((x) => x.type === "teaching-liquidation");
  assert.equal(event.phase, "mark-adverse"); assert.equal(event.relativeTimeMs, null);
  assert.equal(event.intraminuteOrderUnknown, true); assert.equal(event.intervalEndMinute, 2);
});

test("interior funding credit cannot optimistically rescue a position whose adverse-first path liquidates", () => {
  const s = sample(); rate(s, 60, "-.01", 1000); setBar(s, "mark", 60, { low: "40180.8" });
  const e = engine(s); const held = advance(e, opened(e), 59).state; const result = advance(e, held);
  const ambiguity = result.events.find((x) => x.type === "intraminute-ambiguity");
  assert.equal(ambiguity.selectedPath, "adverse-mark-before-funding");
  assert.equal(ambiguity.candidateEquities.adverseMarkFirst, "8997.50000000");
  assert.ok(new D(ambiguity.candidateEquities.fundingFirst).gt(ambiguity.candidateEquities.adverseMarkFirst));
  assert.equal(result.state.account.position, null); assert.equal(result.state.totals.fundingPayments, "0.00000000");
});

test("batch advance pauses at completed event minute without calculating later liquidation/funding", () => {
  const s = sample(); setBar(s, "mark", 2, { low: "30000" }); const e = engine(s);
  const pending = apply(e, e.create(), { type: "market-open", side: "long", contracts: "10" });
  const result = e.apply(pending, { type: "advance", minutes: 15 });
  assert.equal(result.state.elapsedMinutes, 1); assert.equal(result.advancedMinutes, 1); assert.equal(result.paused, true);
  assert.ok(result.state.account.position); assert.equal(result.state.totals.liquidationAggregatePnl, "0.00000000");
  assert.ok(result.events.every((x) => x.observedAtMinute <= 1));
});

test("1/5/15 and full advances produce identical states and ordered traces for the same commands", () => {
  const s = sample(); rate(s, 60, ".0001", 1000); setBar(s, "mark", 100, { low: "40000" }); const e = engine(s);
  const initial = apply(e, e.create(), { type: "market-open", side: "long", contracts: "10" });
  const run = (step) => { let state = clone(initial); const events = []; while (state.elapsedMinutes < 181) {
    const r = advance(e, state, step); state = r.state; events.push(...r.events); } return { state, events }; };
  const expected = run(181);
  for (const step of [1, 5, 15]) assert.deepEqual(run(step), expected);
});

test("future price/volume/final rates and source metadata do not alter current execution state or trace", () => {
  const s = sample(); const poison = clone(s);
  for (const kind of ["last", "mark"]) for (const bar of poison[kind]) if (bar.ts >= START + 5 * M) {
    Object.assign(bar, { open: "10000", high: "10000", low: "10000", close: "10000" });
    if (kind === "last") bar.volumeContracts = "0";
  }
  for (const f of poison.funding) if (f.ts > START + 5 * M) f.settledRate = ".99";
  poison.metadata = { secretFuture: "never expose" };
  const run = (data) => { const e = engine(data); return advance(e, apply(e, e.create(), { type: "market-open", side: "long", contracts: "10" }), 5); };
  assert.deepEqual(run(s), run(poison));
});

test("input snapshots, original rules/scenario and returned traces cannot mutate subsequent transitions", () => {
  const data = sample(), manifest = clone(rules); const e = engine(data, { rules: manifest });
  const initial = e.create(); const snapshot = clone(initial);
  const pending = e.apply(initial, { type: "market-open", side: "long", contracts: "10" });
  assert.deepEqual(initial, snapshot);
  manifest.feeBaseline.takerRate = ".99"; flatBar(data, "last", 0, "10000");
  const expected = advance(e, pending.state); expected.events[0].quote.fee = "999";
  assert.equal(advance(e, pending.state).state.totals.tradingFees, "2.50000000");
  assert.equal(expected.state.account.position.entryPrice, "50000.0");
  assert.deepEqual(JSON.parse(JSON.stringify(pending.state)), pending.state);
});

test("window ending uses only the reserved open, boundary funding precedes it, no trading also completes", () => {
  const s = sample(); rate(s, 180, ".0001"); flatBar(s, "last", 180, "50500"); const e = engine(s);
  const held = advance(e, opened(e), 179).state;
  assert.equal(held.totals.fundingPayments, "0.50000000");
  assert.throws(() => e.apply(held, { type: "market-close" }), error("END_EXECUTION_ONLY"));
  const ended = advance(e, held);
  assert.equal(ended.state.status, "completed"); assert.equal(ended.state.account.position, null);
  assert.equal(ended.events.find((x) => x.type === "market-filled").reason, "training-end");
  assert.equal(ended.state.account.availableBalance, "10044.47500000");
  assert.equal(advance(e, e.create(), 181).state.summary.accountEquity, "10000.00000000");
  assert.throws(() => advance(e, ended.state), error("REPLAY_NOT_ACTIVE"));
});

test("end execution with insufficient volume stays explicit end-blocked, never fakes a normal fill or non-risk liquidation", () => {
  const s = sample(); setBar(s, "last", 180, { volumeContracts: "0" }); const e = engine(s);
  const result = advance(e, opened(e), 180);
  assert.equal(result.state.status, "end-blocked"); assert.ok(result.state.account.position);
  assert.ok(result.events.some((x) => x.type === "end-blocked"));
  assert.equal(result.events.filter((x) => x.type === "teaching-liquidation").length, 0);
});

test("version, cursor, precision and malformed state/advance inputs fail explicitly", () => {
  const e = engine(); const state = e.create();
  assert.equal(state.versions.executionVersion, CRYPTO_EXECUTION_VERSION);
  const version = clone(state); version.versions.dataVersion = "other";
  assert.throws(() => advance(e, version), error("STATE_VERSION_MISMATCH"));
  const reserve = clone(state); reserve.reservedBalance = "1";
  assert.throws(() => advance(e, reserve), error("INVALID_STATE"));
  for (const minutes of [0, -1, 1.5, "1", NaN]) assert.throws(() => advance(e, state, minutes), error("INVALID_ADVANCE"));
  assert.throws(() => e.apply(state, { type: "advance", minutes: 1, stopOnEvent: "false" }), error("INVALID_ADVANCE"));
  assert.throws(() => e.create({ startingCash: "1.000000001" }), error("MONEY_PRECISION"));
  assert.throws(() => e.create({ leverage: "101" }), error("INVALID_LEVERAGE"));
  assert.throws(() => engine(sample(), { slippageBps: 3 }), error("UNSUPPORTED_SLIPPAGE"));
});

test("execution has no infrastructure imports or writes into existing transaction/UI modules", () => {
  const source = readFileSync(new URL("./replay-crypto-execution.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["decimal.js", "./replay-crypto-calculations.js", "./replay-crypto-scenario.js"]);
});

test("manual topup can prevent a future takeover, while no topup is ever silently drawn from outside cash", () => {
  const s = sample(); setBar(s, "mark", 1, { low: "40000" }); const e = engine(s);
  const initial = opened(e);
  const unprotected = advance(e, initial);
  assert.equal(unprotected.state.account.position, null);
  assert.equal(unprotected.state.account.availableBalance, initial.account.availableBalance);
  const topped = apply(e, initial, { type: "add-margin", amount: "1000" });
  const protectedResult = advance(e, topped);
  assert.ok(protectedResult.state.account.position);
  assert.equal(protectedResult.state.account.availableBalance, "7997.50000000");
  assert.equal(protectedResult.state.account.position.marginBalance, "2000.00000000");
  assertBridge(protectedResult.state);
});

test("takeover ends the position, allows later trading with remaining cash, and reversal requires a completed close", () => {
  const s = sample(); setBar(s, "mark", 1, { low: "30000" }); const e = engine(s);
  let state = advance(e, opened(e)).state;
  state = advance(e, apply(e, state, { type: "market-open", side: "short", contracts: "1" })).state;
  assert.equal(state.account.position.side, "short");
  state = advance(e, apply(e, state, { type: "market-close" })).state;
  state = advance(e, apply(e, state, { type: "market-open", side: "long", contracts: "1" })).state;
  assert.equal(state.account.position.side, "long");
  assert.equal(state.totals.liquidationAggregatePnl, "-1000.00000000"); assertBridge(state);
});

test("held-position funding pauses a batch at that completed minute before the next price crash", () => {
  const s = sample(); rate(s, 60, ".0001"); setBar(s, "mark", 60, { low: "30000" }); const e = engine(s);
  const result = e.apply(opened(e), { type: "advance", minutes: 180 });
  assert.equal(result.state.elapsedMinutes, 60); assert.equal(result.advancedMinutes, 59);
  assert.equal(result.state.totals.fundingPayments, "0.50000000"); assert.ok(result.state.account.position);
  assert.equal(result.events.some((x) => x.type === "teaching-liquidation"), false);
});

test("interior funding debit immediately rechecks risk; equal-equity ambiguity chooses funding first without a second posting", () => {
  const s = sample(); rate(s, 60, ".201", 1000); setBar(s, "mark", 60, { low: "49999", high: "50001" });
  const e = engine(s); const result = advance(e, advance(e, opened(e), 59).state);
  const ambiguity = result.events.find((x) => x.type === "intraminute-ambiguity");
  assert.equal(ambiguity.selectedPath, "funding-before-adverse-mark");
  assert.equal(result.events.filter((x) => x.type === "funding-settled").length, 1);
  assert.equal(result.events.find((x) => x.type === "teaching-liquidation").phase, "funding");
  assert.equal(result.state.totals.fundingPayments, "1005.00000000");
  assert.equal(result.state.totals.liquidationAggregatePnl, "5.00000000");
  assert.equal(result.state.summary.netPnl, "-1002.50000000"); assertBridge(result.state);
});
