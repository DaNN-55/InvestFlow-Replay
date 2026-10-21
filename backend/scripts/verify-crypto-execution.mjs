import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import Decimal from "decimal.js";
import { createCryptoMarketReplay } from "../src/replay-crypto-execution.js";
import { MINUTE_MS as M } from "../src/replay-crypto-scenario.js";

const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folder = resolve(root, "storage/crypto-samples/okx-20240101-v1");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const money = (value) => new D(value).toDecimalPlaces(8).toFixed(8);
const canonicalHash = (value) => hash(JSON.stringify(value));
const advance = (e, s, minutes) => e.apply(s, { type: "advance", minutes, stopOnEvent: false });
const command = (e, s, action) => e.apply(s, action).state;
const checkedJson = (file, expected) => {
  const bytes = readFileSync(file); if (expected) assert.equal(hash(bytes), expected, file);
  return JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
};
const manifest = checkedJson(resolve(folder, "manifest.json"), "048fd665a006077050585ba34c8b498caab3672d21bd4311a270c412fe3e6f56");
const rulePath = resolve(root, "docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json");
const rules = checkedJson(rulePath, "1a1f5a04615ab6e2229cb8abc5685ea20d13a47ef131027d571255824c0f78e6");
assert.equal(manifest.ruleVersion, rules.ruleVersion);

// Independent Decimal oracle: no P1 calculator or execution calls. This path only covers safely
// collateralized open -> topup -> partial close -> close, not unknown intraminute liquidation paths.
function oracle(scenario, side, bps) {
  const spec = rules.instruments[scenario.instrumentId].spec;
  const face = new D(spec.ctVal).times(spec.ctMult), tick = new D(spec.tickSz);
  const index = (ts) => (ts - scenario.window.backgroundStartMs) / M;
  const start = scenario.window.replayStartMs;
  const fill = (minute, buy) => new D(scenario.last[index(start + minute * M)].open)
    .times(new D(1).plus(new D(bps).div(10000).times(buy ? 1 : -1)))
    .toNearest(tick, buy ? D.ROUND_CEIL : D.ROUND_FLOOR);
  const entry = fill(1, side === "long");
  const fee = (qty, price) => new D(money(new D(qty).times(face).times(price).times(rules.feeBaseline.takerRate)));
  let margin = new D(money(new D(10).times(face).times(entry).div(5)));
  let fees = fee(10, entry), funding = new D(0), realized = new D(0);
  let available = new D(10000).minus(margin).minus(fees);
  available = available.minus(500); margin = margin.plus(500);
  function charge(from, to, quantity) {
    for (const f of scenario.funding) if (f.ts > start + from * M && f.ts <= start + to * M) {
      const previousMinute = Math.floor(f.ts / M) * M - M;
      const mark = scenario.mark[index(previousMinute)].close;
      const payment = new D(money(new D(quantity).times(face).times(mark).times(f.settledRate).times(side === "long" ? 1 : -1)));
      funding = funding.plus(payment); margin = margin.minus(payment);
    }
  }
  charge(1, 600, 10);
  const partialPrice = fill(600, side === "short");
  const released = new D(money(margin.times(4).div(10)));
  const firstPnl = new D(money(new D(4).times(face).times(partialPrice.minus(entry)).times(side === "long" ? 1 : -1)));
  const partialFee = fee(4, partialPrice);
  available = available.plus(released).plus(firstPnl).minus(partialFee); margin = margin.minus(released);
  realized = realized.plus(firstPnl); fees = fees.plus(partialFee);
  charge(600, 1000, 6);
  const exit = fill(1000, side === "short");
  const lastPnl = new D(money(new D(6).times(face).times(exit.minus(entry)).times(side === "long" ? 1 : -1)));
  const exitFee = fee(6, exit);
  available = available.plus(margin).plus(lastPnl).minus(exitFee);
  return { availableBalance: money(available), tradingFees: money(fees.plus(exitFee)),
    fundingPayments: money(funding), realizedPricePnl: money(realized.plus(lastPnl)) };
}
function tradePlan(e, side) {
  let s = advance(e, e.create(), 1).state;
  s = command(e, s, { type: "market-open", side, contracts: "10" });
  s = advance(e, s, 1).state;
  s = command(e, s, { type: "add-margin", amount: "500" });
  const first = advance(e, s, 598); s = first.state;
  s = command(e, s, { type: "market-close", contracts: "4" });
  const partial = advance(e, s, 1); s = partial.state;
  const second = advance(e, s, 399); s = second.state;
  s = command(e, s, { type: "market-close" });
  const exit = advance(e, s, 1); s = exit.state;
  const events = [...first.events, ...partial.events, ...second.events, ...exit.events];
  assert.equal(s.account.position, null); assert.equal(s.pendingMarketOrder, null);
  assert.equal(events.filter((x) => x.type === "teaching-liquidation").length, 0);
  return { state: s, events };
}
function fullHold(e, side, step, leverage = "5") {
  let state = e.create({ leverage });
  const events = [];
  function act(action) { const result = e.apply(state, action); state = result.state; events.push(...result.events); }
  act({ type: "advance", minutes: 1, stopOnEvent: false });
  act({ type: "market-open", side, contracts: "10" });
  act({ type: "advance", minutes: 1, stopOnEvent: false });
  if (leverage === "5") act({ type: "add-margin", amount: "500" });
  while (state.status === "active") act({ type: "advance", minutes: step, stopOnEvent: false });
  assert.equal(state.status, "completed"); assert.equal(state.account.position, null);
  return { state, events };
}

assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "codex/okx-crypto-training");
const results = {};
for (const instrumentId of Object.keys(manifest.instruments)) {
  const entry = manifest.instruments[instrumentId];
  const scenario = { instrumentId, window: manifest.window, fundingAudit: entry.fundingAudit };
  for (const kind of ["last", "mark", "funding"]) scenario[kind] = checkedJson(resolve(folder, entry.files[kind].file), entry.files[kind].sha256);
  const result = { oracleCases: [], fullWindow: {}, highLeverageRisk: {} };
  let defaultEngine;
  for (const bps of [0, 2, 10]) {
    const e = createCryptoMarketReplay({ rules, scenario, dataVersion: manifest.dataVersion, slippageBps: bps });
    if (bps === 2) defaultEngine = e;
    for (const side of ["long", "short"]) {
      const actual = tradePlan(e, side), expected = oracle(scenario, side, bps);
      assert.equal(actual.state.account.availableBalance, expected.availableBalance);
      for (const key of ["tradingFees", "fundingPayments", "realizedPricePnl"]) assert.equal(actual.state.totals[key], expected[key]);
      result.oracleCases.push({ side, slippageBps: bps, ...expected, exact: true });
    }
  }
  const quiet = advance(defaultEngine, defaultEngine.create(), 4321);
  assert.equal(quiet.state.status, "completed"); assert.equal(quiet.state.summary.accountEquity, "10000.00000000");
  assert.equal(quiet.events.filter((x) => x.type === "funding-settled").length, 0);
  result.noTrading = { completed: true, endingEquity: quiet.state.summary.accountEquity };
  for (const side of ["long", "short"]) {
    const full = fullHold(defaultEngine, side, 4321);
    for (const step of [1, 5, 15]) assert.deepEqual(fullHold(defaultEngine, side, step), full);
    result.fullWindow[side] = { endingEquity: full.state.summary.accountEquity, totals: full.state.totals,
      fundingCharged: full.events.filter((x) => x.type === "funding-settled").length,
      ambiguityMinutes: full.events.filter((x) => x.type === "intraminute-ambiguity").length,
      traceSHA256: canonicalHash(full.events), equivalentSteps: [1, 5, 15, 4321] };
    const risky = fullHold(defaultEngine, side, 15, "100");
    const takeovers = risky.events.filter((x) => x.type === "teaching-liquidation");
    assert.equal(takeovers.length, 1);
    const takeover = takeovers[0];
    const open = risky.events.find((x) => x.type === "market-filled" && x.kind === "open");
    assert.equal(risky.state.totals.tradingFees, open.quote.fee);
    assert.equal(takeover.settlement.referenceAmountsAreNonPosting, true);
    assert.equal(risky.state.account.availableBalance, money(new D(10000).minus(open.quote.initialMargin).minus(open.quote.fee)));
    result.highLeverageRisk[side] = { teachingFixtureLeverage: "100", takeoverCount: 1,
      observedAtMinute: takeover.observedAtMinute, triggerPhase: takeover.phase,
      endingEquity: risky.state.summary.accountEquity, aggregateSettlementPnl: takeover.settlement.aggregateSettlementPnl,
      outsideCashPreserved: true, actualLiquidationFillPrice: takeover.settlement.actualLiquidationFillPrice };
  }
  const poisoned = structuredClone(scenario);
  const cutoff = scenario.window.replayStartMs + 5 * M;
  for (const kind of ["last", "mark"]) for (const b of poisoned[kind]) if (b.ts >= cutoff) {
    Object.assign(b, { open: "10000", high: "10000", low: "10000", close: "10000" });
    if (kind === "last") b.volumeContracts = "0";
  }
  for (const f of poisoned.funding) if (f.ts > cutoff) f.settledRate = ".99";
  poisoned.metadata = { futureDate: "2099-01-01", secret: "must not affect current prefix" };
  const poisonEngine = createCryptoMarketReplay({ rules, scenario: poisoned, dataVersion: manifest.dataVersion, slippageBps: 2 });
  const prefix = (e) => advance(e, command(e, e.create(), { type: "market-open", side: "long", contracts: "10" }), 5);
  assert.deepEqual(prefix(defaultEngine), prefix(poisonEngine));
  const pending = command(defaultEngine, defaultEngine.create(), { type: "market-open", side: "long", contracts: "10" });
  const paused = defaultEngine.apply(pending, { type: "advance", minutes: 15 });
  assert.equal(paused.state.elapsedMinutes, 1); assert.equal(paused.advancedMinutes, 1);
  result.visibility = { futurePerturbationAtMinute: 5, identical: true, defaultBatchPauseAfterFirstFillMinute: 1 };
  results[instrumentId] = result;
}
const codeFiles = ["backend/src/replay-crypto-execution.js", "backend/src/replay-crypto-execution.test.js", "backend/scripts/verify-crypto-execution.mjs"];
console.log(JSON.stringify({ status: "verified-p3a-offline", branch: "codex/okx-crypto-training", dataVersion: manifest.dataVersion,
  dataManifestSHA256: hash(readFileSync(resolve(folder, "manifest.json"))), ruleSnapshotSHA256: hash(readFileSync(rulePath)),
  codeSHA256: Object.fromEntries(codeFiles.map((file) => [file, hash(readFileSync(resolve(root, file)))])),
  scope: "Pure market execution and calculation traces; no HTTP, UI, business ledger or database writes", results }, null, 2));
