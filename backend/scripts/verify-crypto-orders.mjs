import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Decimal from "decimal.js";
import { createCryptoOrderReplay } from "../src/replay-crypto-order-execution.js";
import { MINUTE_MS as M } from "../src/replay-crypto-scenario.js";
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folder = resolve(root, "storage/crypto-samples/okx-20240101-v1");
const hash = (v) => createHash("sha256").update(v).digest("hex"), money = (v) => new D(v).toDecimalPlaces(8).toFixed(8);
function checked(file, expected) { const b = readFileSync(file); assert.equal(hash(b), expected, file); return JSON.parse(file.endsWith(".gz") ? gunzipSync(b) : b); }
const dataHash = "048fd665a006077050585ba34c8b498caab3672d21bd4311a270c412fe3e6f56";
const ruleHash = "1a1f5a04615ab6e2229cb8abc5685ea20d13a47ef131027d571255824c0f78e6";
const manifest = checked(resolve(folder, "manifest.json"), dataHash);
const rules = checked(resolve(root, "docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json"), ruleHash);
assert.equal(manifest.ruleVersion, rules.ruleVersion);
assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "codex/okx-crypto-training");
const results = {};
for (const instrumentId of Object.keys(manifest.instruments)) {
  const entry = manifest.instruments[instrumentId], spec = rules.instruments[instrumentId].spec;
  const tick = new D(spec.tickSz), lot = new D(spec.lotSz), face = new D(spec.ctVal).times(spec.ctMult);
  const scenario = { instrumentId, window: manifest.window, fundingAudit: entry.fundingAudit };
  for (const kind of ["last", "mark", "funding"]) scenario[kind] = checked(resolve(folder, entry.files[kind].file), entry.files[kind].sha256);
  const offset = (manifest.window.replayStartMs - manifest.window.backgroundStartMs) / M;
  const row = (kind, minute) => scenario[kind][offset + minute];
  const adverseFill = (minute, buy, bps) => new D(row("last", minute).open).times(new D(1).plus(new D(bps).div(10000).times(buy ? 1 : -1)))
    .toNearest(tick, buy ? D.ROUND_CEIL : D.ROUND_FLOOR);
  const limitFor = (minute, buy) => new D(row("last", minute).open).times(buy ? "1.01" : ".99").toNearest(tick, buy ? D.ROUND_CEIL : D.ROUND_FLOOR).toFixed();
  const distantProtection = (side) => ({ stopLoss: { price: new D(row("last", 0).open).times(side === "long" ? ".5" : "1.5").toNearest(tick).toFixed() },
    takeProfit: { price: new D(row("last", 0).open).times(side === "long" ? "1.5" : ".5").toNearest(tick).toFixed() } });
  // Independent Decimal oracle. Fixed engineering operations, not an unseen strategy test.
  function oracle(side, bps) {
    const sign = side === "long" ? 1 : -1;
    const fee = (q, price) => new D(money(new D(q).times(face).times(price).times(rules.feeBaseline.takerRate)));
    const first = adverseFill(1, side === "long", bps), added = adverseFill(100, side === "long", bps);
    let cost = new D(10).times(face).times(first), margin = new D(money(cost.div(5))), fees = fee(10, first), funding = new D(0), realized = new D(0);
    let available = new D(10000).minus(margin).minus(fees).minus(500); margin = margin.plus(500);
    function charge(from, to, quantity) {
      for (const f of scenario.funding) if (f.ts > manifest.window.replayStartMs + from * M && f.ts <= manifest.window.replayStartMs + to * M) {
        const i = (Math.floor(f.ts / M) * M - M - manifest.window.backgroundStartMs) / M;
        const payment = new D(money(new D(quantity).times(face).times(scenario.mark[i].close).times(f.settledRate).times(sign)));
        funding = funding.plus(payment); margin = margin.minus(payment);
      }
    }
    charge(1, 100, 10);
    const newCost = new D(5).times(face).times(added), newMargin = new D(money(newCost.div(5))), newFee = fee(5, added);
    cost = cost.plus(newCost); margin = margin.plus(newMargin); available = available.minus(newMargin).minus(newFee); fees = fees.plus(newFee);
    charge(100, 600, 15);
    const partPrice = adverseFill(600, side === "short", bps), released = new D(money(margin.times(4).div(15)));
    const allocatedCost = new D(money(cost.times(4).div(15)));
    const pnl = new D(money(new D(4).times(face).times(partPrice).minus(allocatedCost).times(sign))), partFee = fee(4, partPrice);
    available = available.plus(released).plus(pnl).minus(partFee); margin = margin.minus(released); cost = cost.minus(allocatedCost); fees = fees.plus(partFee); realized = realized.plus(pnl);
    charge(600, 1000, 11);
    const close = adverseFill(1000, side === "short", bps), endFee = fee(11, close);
    const endPnl = new D(money(new D(11).times(face).times(close).minus(cost).times(sign)));
    available = available.plus(margin).plus(endPnl).minus(endFee);
    return { availableBalance: money(available), tradingFees: money(fees.plus(endFee)), fundingPayments: money(funding), realizedPricePnl: money(realized.plus(endPnl)) };
  }
  function plan(e, side, step, full = false) {
    let state = e.create(); const events = [];
    const act = (command) => { const r = e.apply(state, command); state = r.state; events.push(...r.events); return r; };
    function go(target) { while (state.elapsedMinutes < target && state.status === "active") act({ type: "advance", minutes: Math.min(step, target - state.elapsedMinutes), stopOnEvent: false }); }
    go(1); act({ type: "market-open", side, contracts: "10", protection: distantProtection(side) }); go(2);
    act({ type: "add-margin", amount: "500" }); go(100); act({ type: "market-open", side, contracts: "5" }); go(101);
    assert.equal(state.account.position.contracts, "15"); assert.equal(state.protection.contracts, "15");
    go(600); act({ type: "limit-close", contracts: "4", limitPrice: limitFor(600, side === "short") }); go(601);
    assert.equal(state.account.position.contracts, "11"); assert.equal(state.protection.contracts, "11");
    go(1000);
    if (full) {
      const cancel = act({ type: "limit-open", side, contracts: "1", limitPrice: distantProtection(side).stopLoss.price });
      const id = cancel.events.find((x) => x.type === "order-submitted").order.id;
      go(1100); act({ type: "cancel-order", orderId: id }); go(4321);
    } else { act({ type: "market-close" }); go(1001); }
    assert.equal(state.account.position, null); assert.equal(state.protection, null); assert.equal(state.orders.length, 0);
    return { state, events };
  }
  const result = { oracleCases: [], partialLimits: {}, protections: {}, fullWindow: {} };
  let e;
  for (const bps of [0, 2, 10]) {
    const current = createCryptoOrderReplay({ rules, scenario, dataVersion: manifest.dataVersion, slippageBps: bps }); if (bps === 2) e = current;
    for (const side of ["long", "short"]) {
      const actual = plan(current, side, 1000), expected = oracle(side, bps);
      assert.equal(actual.state.account.availableBalance, expected.availableBalance);
      for (const key of ["tradingFees", "fundingPayments", "realizedPricePnl"]) assert.equal(actual.state.totals[key], expected[key]);
      result.oracleCases.push({ side, slippageBps: bps, ...expected, exact: true });
    }
  }
  const firstCapacity = new D(row("last", 0).volumeContracts).toNearest(lot, D.ROUND_FLOOR), request = firstCapacity.plus(1);
  for (const side of ["long", "short"]) {
    let s = e.create({ startingCash: "1000000" });
    s = e.apply(s, { type: "limit-open", side, contracts: request.toFixed(), limitPrice: limitFor(0, side === "long") }).state;
    const first = e.apply(s, { type: "advance", minutes: 1, stopOnEvent: false });
    assert.equal(first.state.account.position.contracts, firstCapacity.toFixed()); assert.equal(first.state.orders[0].remainingContracts, "1");
    const second = e.apply(first.state, { type: "advance", minutes: 1, stopOnEvent: false });
    const maker = second.events.find((x) => x.type === "order-filled"); assert.equal(maker.quote.liquidityRole, "maker");
    assert.equal(second.state.account.position.contracts, request.toFixed());
    const cancelled = e.apply(first.state, { type: "cancel-order", orderId: first.state.orders[0].id });
    const after = e.apply(cancelled.state, { type: "advance", minutes: 3, stopOnEvent: false });
    assert.equal(after.state.account.position.contracts, firstCapacity.toFixed()); assert.equal(after.state.orders.length, 0);
    result.partialLimits[side] = { startingCashForCapacityFixture: "1000000", requested: request.toFixed(), firstFilled: firstCapacity.toFixed(),
      firstRole: first.events.find((x) => x.type === "order-filled").quote.liquidityRole, nextFilled: maker.quote.contracts,
      nextRole: maker.quote.liquidityRole, cancellationNoRevival: true };
    const full = plan(e, side, 4321, true);
    for (const step of [1, 5, 15]) assert.deepEqual(plan(e, side, step, true), full);
    result.fullWindow[side] = { endingEquity: full.state.summary.accountEquity, totals: full.state.totals,
      traceSHA256: hash(JSON.stringify(full.events)), equivalentSteps: [1, 5, 15, 4321], fundingEvents: full.events.filter((x) => x.type === "funding-settled").length };
    // Future prices select explicit trigger fixtures; these are not trading-performance claims.
    let minute = 1;
    while (minute < 100 && !(new D(row("last", minute).open).minus(row("last", minute).low).gte(tick.times(2))
      && new D(row("last", minute).high).minus(row("last", minute).open).gte(tick.times(2)) && new D(row("last", minute).volumeContracts).gte(10))) minute++;
    assert.ok(minute < 100);
    let held = e.apply(e.create(), { type: "market-open", side, contracts: "10" }).state;
    held = e.apply(held, { type: "advance", minutes: minute, stopOnEvent: false }).state;
    const low = new D(row("last", minute).low).plus(tick).toNearest(tick).toFixed(), high = new D(row("last", minute).high).minus(tick).toNearest(tick).toFixed();
    held = e.apply(held, { type: "set-protection", stopLoss: { price: side === "long" ? low : high }, takeProfit: { price: side === "long" ? high : low } }).state;
    const protectedResult = e.apply(held, { type: "advance", minutes: 1, stopOnEvent: false });
    assert.equal(protectedResult.events.find((x) => x.type === "protection-triggered").leg, "stopLoss");
    assert.equal(protectedResult.state.account.position, null);
    result.protections[side] = { fixtureMinute: minute, bothLegsReachable: true, selected: "stopLoss", siblingCancelled: true,
      endingEquity: protectedResult.state.summary.accountEquity, fillRole: protectedResult.events.find((x) => x.type === "protection-filled").quote.liquidityRole };
  }
  result.highLeverageRisk = {};
  result.markProtection = {};
  for (const side of ["long", "short"]) {
    let risky = e.apply(e.create({ leverage: "100" }), { type: "market-open", side, contracts: "10", protection: distantProtection(side) }).state;
    const opened = e.apply(risky, { type: "advance", minutes: 1, stopOnEvent: false }); risky = opened.state;
    const fill = opened.events.find((x) => x.type === "order-filled");
    risky = e.apply(risky, { type: "limit-open", side, contracts: "1", limitPrice: distantProtection(side).stopLoss.price }).state;
    const takeovers = [];
    while (risky.status === "active") { const r = e.apply(risky, { type: "advance", minutes: 15, stopOnEvent: false }); risky = r.state; takeovers.push(...r.events.filter((x) => x.type === "teaching-liquidation")); }
    assert.equal(takeovers.length, 1); assert.equal(risky.orders.length, 0); assert.equal(risky.protection, null);
    assert.equal(risky.account.availableBalance, money(new D(10000).minus(fill.quote.initialMargin).minus(fill.quote.fee)));
    assert.equal(risky.totals.tradingFees, fill.quote.fee);
    result.highLeverageRisk[side] = { testLeverage: "100", takeoverCount: 1, observedAtMinute: takeovers[0].observedAtMinute, outsideCashPreserved: true, pendingOrdersAndProtectionCleared: true };
    let minute = 1;
    const down = side === "long";
    while (minute < 100 && !(new D(row("mark", minute).open).minus(row("mark", minute).low).gte(tick.times(2)) && new D(row("mark", minute).high).minus(row("mark", minute).open).gte(tick.times(2)) && new D(row("last", minute).volumeContracts).gte(10))) minute++;
    assert.ok(minute < 100);
    let held = e.apply(e.create(), { type: "market-open", side, contracts: "10" }).state;
    held = e.apply(held, { type: "advance", minutes: minute, stopOnEvent: false }).state;
    const price = (down ? new D(row("mark", minute).low).plus(tick) : new D(row("mark", minute).high).minus(tick)).toNearest(tick).toFixed();
    held = e.apply(held, { type: "set-protection", stopLoss: { price, reference: "mark" } }).state;
    const resultMark = e.apply(held, { type: "advance", minutes: 1, stopOnEvent: false });
    assert.equal(resultMark.state.account.position, null);
    const exit = resultMark.events.find((x) => x.type === "protection-filled");
    assert.equal(exit.phase, "intrabar-mark-trigger-adverse-last-proxy");
    result.markProtection[side] = { fixtureMinute: minute, triggerReference: "mark", fillReference: "ordinary-adverse-extreme-proxy", fillPrice: exit.quote.fillPrice, approximate: true };
  }
  const firstPart = firstCapacity.times(".6").toNearest(lot, D.ROUND_FLOOR);
  let shared = e.create({ startingCash: "1000000" });
  for (let i = 0; i < 2; i++) shared = e.apply(shared, { type: "market-open", side: "long", contracts: firstPart.toFixed() }).state;
  const sharedResult = e.apply(shared, { type: "advance", minutes: 1, stopOnEvent: false });
  const sharedFills = sharedResult.events.filter((x) => x.type === "order-filled");
  assert.equal(sharedFills.length, 2); assert.equal(sharedResult.state.account.position.contracts, firstCapacity.toFixed()); assert.equal(sharedFills[0].quote.contracts, firstPart.toFixed());
  result.sharedCapacity = { sourceCapacity: firstCapacity.toFixed(), orderedFills: sharedFills.map((x) => x.quote.contracts), exact: true };
  let partialMinute = 1;
  while (partialMinute < 100 && !(new D(row("last", partialMinute).volumeContracts).gte(1) && new D(row("last", partialMinute).volumeContracts).lt(firstCapacity)
    && new D(row("last", partialMinute).open).minus(row("last", partialMinute).low).gte(tick.times(2)))) partialMinute++;
  assert.ok(partialMinute < 100);
  let big = e.apply(e.create({ startingCash: "1000000" }), { type: "market-open", side: "long", contracts: firstCapacity.toFixed() }).state;
  big = e.apply(big, { type: "advance", minutes: partialMinute, stopOnEvent: false }).state;
  const stop = new D(row("last", partialMinute).low).plus(tick).toNearest(tick).toFixed();
  big = e.apply(big, { type: "set-protection", stopLoss: { price: stop }, takeProfit: { price: new D(row("last", partialMinute).high).plus(tick).toFixed() } }).state;
  const trigger = e.apply(big, { type: "advance", minutes: 1, stopOnEvent: false });
  assert.ok(trigger.state.account.position); assert.equal(trigger.state.protection.triggeredLeg, "stopLoss"); assert.equal(trigger.state.protection.takeProfit, null);
  let remainder = trigger.state, retries = 0;
  while (remainder.account.position && retries < 100) { remainder = e.apply(remainder, { type: "advance", minutes: 1, stopOnEvent: false }).state; retries++; }
  assert.equal(remainder.account.position, null); assert.equal(remainder.protection, null);
  result.partialProtection = { fixtureMinute: partialMinute, initialContracts: firstCapacity.toFixed(), triggerFilled: trigger.events.find((x) => x.type === "protection-filled").quote.contracts,
    carriedContracts: trigger.state.protection.contracts, laterOpenRetries: retries, siblingStayedCancelled: true };
  const quiet = e.apply(e.create(), { type: "advance", minutes: 4321, stopOnEvent: false }); assert.equal(quiet.state.status, "completed"); assert.equal(quiet.state.summary.accountEquity, "10000.00000000");
  const poison = structuredClone(scenario), cutoff = manifest.window.replayStartMs + 5 * M;
  for (const kind of ["last", "mark"]) for (const b of poison[kind]) if (b.ts >= cutoff) Object.assign(b, { open: "10000", high: "10000", low: "10000", close: "10000", ...(kind === "last" ? { volumeContracts: "0" } : {}) });
  for (const f of poison.funding) if (f.ts > cutoff) f.settledRate = ".99";
  poison.metadata = { secretFutureDate: "2099-01-01" };
  const pe = createCryptoOrderReplay({ rules, scenario: poison, dataVersion: manifest.dataVersion, slippageBps: 2 });
  const prefix = (current) => { const p = current.apply(current.create(), { type: "market-open", side: "long", contracts: "10", protection: distantProtection("long") }); return current.apply(p.state, { type: "advance", minutes: 5, stopOnEvent: false }); };
  assert.deepEqual(prefix(e), prefix(pe));
  const paused = e.apply(e.apply(e.create(), { type: "market-open", side: "long", contracts: "10" }).state, { type: "advance", minutes: 15 }); assert.equal(paused.state.elapsedMinutes, 1);
  result.visibility = { futurePerturbationAtMinute: 5, identical: true, pausedAfterFirstFillMinute: 1 };
  result.noTrading = { completed: true, endingEquity: quiet.state.summary.accountEquity };
  results[instrumentId] = result; process.stderr.write(`${instrumentId}: P3b frozen-sample checks passed\n`);
}
const files = ["backend/src/replay-crypto-calculations.js", "backend/src/replay-crypto-order-execution.js", "backend/src/replay-crypto-order-execution.test.js", "backend/scripts/verify-crypto-orders.mjs"];
console.log(JSON.stringify({ status: "verified-p3b-offline", branch: "codex/okx-crypto-training", dataVersion: manifest.dataVersion, dataManifestSHA256: dataHash, ruleSnapshotSHA256: ruleHash,
  codeSHA256: Object.fromEntries(files.map((f) => [f, hash(readFileSync(resolve(root, f)))])), scope: "Pure order calculations; source data unchanged; no HTTP/UI/business ledger writes", results }, null, 2));
