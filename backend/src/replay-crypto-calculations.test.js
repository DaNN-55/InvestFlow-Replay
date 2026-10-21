import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { createCryptoCalculator, CRYPTO_RULE_VERSION, TEACHING_LIQUIDATION_VERSION } from "./replay-crypto-calculations.js";

const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../docs/research/okx-rule-snapshots/${name}`, import.meta.url)));
const rules = fixture("2026-10-19-training-rule-manifest.draft.json");
const golden = fixture("2026-10-19-golden-cases.json");
const liquidation = fixture("2026-10-19-liquidation-teaching-cases.json");
const calculator = (instrumentId = "BTC-USDT-SWAP", manifest = rules) => createCryptoCalculator({ rules: manifest, instrumentId });
const btc = calculator();
const eth = calculator("ETH-USDT-SWAP");
const position = (overrides = {}) => ({ instrumentId: "BTC-USDT-SWAP", side: "long", contracts: "10", entryPrice: "50000", marginBalance: "1000.00000000", ...overrides });
const account = (overrides = {}) => ({ availableBalance: "8997.50000000", position: position(), ...overrides });
const failWith = (code) => (error) => error.code === code;
const sameDecimal = (actual, expected, places = 24) => assert.equal(new D(actual).toFixed(places), new D(expected).toFixed(places));
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test("A01: separate BTC/ETH contract values, ticks and sizing; invalid inputs are rejected", () => {
  assert.equal(btc.quoteFill({ contracts: ".01", fillPrice: "50000", liquidityRole: "taker" }).baseQuantity, "0.0001");
  assert.equal(eth.quoteFill({ contracts: ".01", fillPrice: "3000", liquidityRole: "taker" }).baseQuantity, "0.001");
  assert.equal(btc.floorContracts("10.019"), "10.01");
  assert.equal(btc.floorContracts(".009"), "0");
  assert.throws(() => btc.quoteFill({ contracts: ".001", fillPrice: "50000", liquidityRole: "taker" }), failWith("INVALID_QUANTITY"));
  assert.throws(() => btc.quoteFill({ contracts: "10", fillPrice: "50000.01", liquidityRole: "taker" }), failWith("INVALID_PRICE_TICK"));
  assert.throws(() => eth.quoteFill({ contracts: "10", fillPrice: "3000.001", liquidityRole: "maker" }), failWith("INVALID_PRICE_TICK"));
  for (const invalid of [NaN, Infinity, .1, Number.MAX_SAFE_INTEGER + 1, "1e3", "0x10", " 10", null]) {
    assert.throws(() => btc.floorContracts(invalid), failWith("INVALID_DECIMAL"));
  }
  for (const value of ["0", "-1"]) assert.throws(() => btc.quoteFill({ contracts: value, fillPrice: "50000", liquidityRole: "taker" }), failWith("NON_POSITIVE"));
  assert.throws(() => btc.quoteFill({ contracts: "10", fillPrice: "50000", liquidityRole: "limit" }), failWith("INVALID_ENUM"));
});

test("A02: checked BTC maker/taker fees and ETH mixed fills", () => {
  for (const role of ["maker", "taker"]) {
    assert.equal(btc.quoteFill({ contracts: "100", fillPrice: "60000", liquidityRole: role }).fee, golden.BTC_fee[`${role}Fee`]);
  }
  const quotes = [
    eth.quoteFill({ contracts: "50", fillPrice: "3000", liquidityRole: "taker" }),
    eth.quoteFill({ contracts: "25", fillPrice: "3100", liquidityRole: "maker" }),
    eth.quoteFill({ contracts: "25", fillPrice: "3050", liquidityRole: "taker" }),
  ];
  assert.equal(quotes.reduce((sum, q) => sum.plus(q.fee), new D(0)).toFixed(8), golden.ETH_mixed_fills_total_fee);
  assert.equal(btc.quoteFill({ contracts: "100", fillPrice: "60000", liquidityRole: "taker", leverage: "5" }).fee,
    btc.quoteFill({ contracts: "100", fillPrice: "60000", liquidityRole: "taker", leverage: "20" }).fee);
});

test("8-place HALF_UP and decimal amounts beyond safe JS integer precision", () => {
  assert.equal(btc.quoteFill({ contracts: ".01", fillPrice: ".1", liquidityRole: "taker" }).fee, "0.00000001");
  const input = account({ availableBalance: "9007199254740993.00000000" });
  const topped = btc.addMargin(input, ".00000001");
  assert.equal(topped.account.availableBalance, "9007199254740992.99999999");
  assert.equal(topped.account.position.marginBalance, "1000.00000001");
  assert.throws(() => btc.addMargin(input, ".000000001"), failWith("MONEY_PRECISION"));
});

test("A03: whole-position tier rates, boundaries and maximum leverage", () => {
  assert.equal(btc.assessPosition(position({ contracts: "1000" }), "60000").tier, "1");
  assert.equal(btc.assessPosition(position({ contracts: "1000.01" }), "60000").tier, "2");
  assert.equal(btc.assessPosition(position({ contracts: "1500" }), "60000").maintenanceMargin, "4500.00000000");
  assert.throws(() => btc.quoteFill({ contracts: "1000.01", fillPrice: "60000", liquidityRole: "taker", leverage: "100" }), failWith("INVALID_LEVERAGE"));
  assert.throws(() => btc.quoteFill({ contracts: "10", fillPrice: "60000", liquidityRole: "taker", leverage: ".5" }), failWith("INVALID_LEVERAGE"));
  for (const [instId, calc, fillPrice] of [["BTC-USDT-SWAP", btc, "60000"], ["ETH-USDT-SWAP", eth, "3000"]]) {
    const tiers = rules.instruments[instId].isolatedPositionTiers;
    for (const tier of tiers) {
      for (const contracts of [new D(tier.minSz).isZero() ? ".01" : tier.minSz, tier.maxSz]) {
        assert.equal(calc.quoteFill({ contracts, fillPrice, liquidityRole: "taker", leverage: tier.maxLever }).tier, tier.tier);
      }
    }
    const aboveLast = new D(tiers.at(-1).maxSz).plus(".01").toFixed();
    assert.throws(() => calc.quoteFill({ contracts: aboveLast, fillPrice, liquidityRole: "taker" }), failWith("POSITION_TOO_LARGE"));
  }
});

test("A03: independent long/short liquidation threshold oracles", () => {
  for (const [marginBalance, expected] of Object.entries(golden.liquidation_thresholds)) {
    for (const side of ["long", "short"]) {
      const risk = btc.assessPosition(position({ side, contracts: "100", entryPrice: "60000", marginBalance }), "60000");
      sameDecimal(risk.estimatedLiquidationPrice, expected[`${side}Raw`]);
    }
  }
  const risk = btc.assessPosition(position({ marginBalance: "6000" }), "50000");
  assert.equal(risk.estimatedLiquidationPrice, null);
  assert.equal(risk.thresholdStatus, "no-positive-threshold");
  assert.equal(risk.liquidationRequired, false);
});

test("risk uses unrounded mark equity: equal threshold triggers, just above is safe; no mark reset of M", () => {
  const p = position({ marginBalance: "1018" });
  const exact = btc.assessPosition(p, "40000");
  assert.equal(exact.riskRatio, "1.000000000000000000000000");
  assert.equal(exact.liquidationRequired, true);
  assert.equal(btc.assessPosition({ ...p, marginBalance: "1018.00000001" }, "40000").liquidationRequired, false);
  for (const mark of ["40000", "50000", "60000"]) assert.equal(btc.assessPosition(p, mark).marginBalance, "1018.00000000");
  assert.equal(p.marginBalance, "1018");
  assert.equal(btc.assessPosition(position({ side: "short" }), "49000").unrealizedPnl, "100.00000000");
});

test("a displayed ratio rounded to 1 must not liquidate exact equity above the requirement", () => {
  const p = position({ entryPrice: "100000000000000000000", marginBalance: "45000000000000000.00000001" });
  const risk = btc.assessPosition(p, "100000000000000000000");
  assert.equal(risk.riskRatio, "1.000000000000000000000000");
  assert.equal(risk.liquidationRequired, false);
});

for (const withTopup of [false, true]) test(`A02/A04: complete BTC round trip, top-up=${withTopup}; slippage is not charged twice`, () => {
  const g = golden.BTC_round_trip;
  const openQuote = btc.quoteMarketFill({ action: "buy", contracts: g.contracts, referencePrice: g.openReference, leverage: "5" });
  assert.equal(openQuote.fillPrice, g.openFill);
  assert.equal(openQuote.fee, g.openFee);
  const opened = btc.openPosition({ availableBalance: "10000", position: null }, { side: "long", contracts: g.contracts,
    fillPrice: openQuote.fillPrice, leverage: "5", liquidityRole: "taker" });
  assert.equal(opened.account.position.marginBalance, "1000.20000000");
  let state = opened.account;
  if (withTopup) state = btc.addMargin(state, "500").account;
  const funding = btc.settleFunding(state, { markPrice: g.fundingMark, settledRate: g.fundingRate });
  assert.equal(funding.fundingPayment, g.fundingPayment);
  const exitQuote = btc.quoteMarketFill({ action: "sell", contracts: g.contracts, referencePrice: g.closeReference });
  assert.equal(exitQuote.fillPrice, g.closeFill);
  const exit = btc.reducePosition(funding.account, { contracts: g.contracts, fillPrice: exitQuote.fillPrice, liquidityRole: "taker" });
  assert.equal(exit.realizedPnl, "47.99000000");
  assert.equal(exit.fee, g.closeFee);
  assert.equal(exit.account.availableBalance, "10042.46300500");
  assert.equal(exit.account.position, null);
  assert.equal(new D(openQuote.slippageAttribution).plus(exitQuote.slippageAttribution).toFixed(), g.slippageAttribution);
});

test("A04: margin transfer conserves total equity and rejects overspend/zero/negative", () => {
  const input = account();
  const before = btc.assessPosition(input.position, "49000");
  const next = btc.addMargin(input, "500").account;
  assert.equal(next.availableBalance, "8497.50000000");
  assert.equal(next.position.marginBalance, "1500.00000000");
  assert.equal(next.position.contracts, input.position.contracts);
  assert.equal(next.position.entryPrice, input.position.entryPrice);
  const after = btc.assessPosition(next.position, "49000");
  assert.equal(new D(input.availableBalance).plus(before.positionEquity).toFixed(8),
    new D(next.availableBalance).plus(after.positionEquity).toFixed(8));
  assert.ok(new D(after.estimatedLiquidationPrice).lt(before.estimatedLiquidationPrice));
  for (const amount of ["0", "-1", "9000"]) assert.throws(() => btc.addMargin(input, amount), failWith("INVALID_TOPUP"));
});

test("A04: reductions release margin proportionally, keep entry, close with zero outside cash and cannot reverse", () => {
  const input = account({ availableBalance: "0" });
  const part = btc.reducePosition(input, { contracts: "3", fillPrice: "51000", liquidityRole: "maker" });
  assert.equal(part.releasedMargin, "300.00000000");
  assert.equal(part.realizedPnl, "30.00000000");
  assert.equal(part.account.availableBalance, "329.69400000");
  assert.equal(part.account.position.contracts, "7");
  assert.equal(part.account.position.marginBalance, "700.00000000");
  assert.equal(part.account.position.entryPrice, "50000");
  const rest = btc.reducePosition(part.account, { contracts: "7", fillPrice: "51000", liquidityRole: "maker" });
  assert.equal(rest.account.position, null);
  assert.equal(rest.account.availableBalance, "1098.98000000");
  assert.throws(() => btc.reducePosition(input, { contracts: "10.01", fillPrice: "51000", liquidityRole: "maker" }), failWith("OVER_REDUCTION"));
  assert.throws(() => btc.openPosition(input, { side: "short", contracts: "10", fillPrice: "50000", leverage: "5", liquidityRole: "taker" }), failWith("POSITION_EXISTS"));
  const deficit = btc.reducePosition(input, { contracts: "10", fillPrice: "30000", liquidityRole: "taker" });
  assert.equal(deficit.cashDeficit, "1001.50000000");
  assert.equal(deficit.account.availableBalance, "-1001.50000000");
});

test("partial-release rounding leaves the exact residual for final close", () => {
  const input = account({ availableBalance: "0", position: position({ contracts: ".03", marginBalance: ".00000002" }) });
  const part = btc.reducePosition(input, { contracts: ".01", fillPrice: "50000", liquidityRole: "maker" });
  assert.equal(part.releasedMargin, "0.00000001");
  assert.equal(part.account.position.marginBalance, "0.00000001");
  const rest = btc.reducePosition(part.account, { contracts: ".02", fillPrice: "50000", liquidityRole: "maker" });
  assert.equal(rest.releasedMargin, "0.00000001");
  assert.equal(rest.account.position, null);
});

test("opening reserves margin plus fee, rejects missing leverage and insufficient cash", () => {
  const args = { side: "long", contracts: "10", fillPrice: "50000", leverage: "5", liquidityRole: "taker" };
  assert.throws(() => btc.openPosition({ availableBalance: "1000", position: null }, args), failWith("INSUFFICIENT_CASH"));
  assert.throws(() => btc.openPosition({ availableBalance: "10000", position: null }, { ...args, leverage: undefined }), failWith("INVALID_LEVERAGE"));
  assert.equal(btc.openPosition({ availableBalance: "1002.5", position: null }, args).account.availableBalance, "0.00000000");
});

test("A05: all long/short positive/negative funding directions affect M only", () => {
  for (const side of ["long", "short"]) for (const settledRate of [".0001", "-.0001"]) {
    const input = account({ position: position({ side }) });
    const funded = btc.settleFunding(input, { markPrice: "50000", settledRate });
    const payment = new D(settledRate).times(5000).times(side === "long" ? 1 : -1);
    assert.equal(funded.fundingPayment, payment.toFixed(8));
    assert.equal(funded.account.availableBalance, input.availableBalance);
    assert.equal(funded.account.position.marginBalance, new D(1000).minus(payment).toFixed(8));
  }
});

test("sub-unit negative funding normalizes to canonical zero without changing margin", () => {
  const input = account({ availableBalance: "0", position: position({ contracts: ".01", entryPrice: ".1", marginBalance: ".000001" }) });
  const funded = btc.settleFunding(input, { markPrice: ".1", settledRate: "-.0001" });
  assert.equal(funded.fundingPayment, "0.00000000");
  assert.equal(funded.account.position.marginBalance, "0.00000100");
});

test("A05: funding rechecks risk immediately and negative margin is preserved until explicit takeover", () => {
  const input = account({ position: position({ entryPrice: "40000", marginBalance: "18.1" }) });
  assert.equal(btc.assessPosition(input.position, "40000").liquidationRequired, false);
  const funded = btc.settleFunding(input, { markPrice: "40000", settledRate: ".0001" });
  assert.equal(funded.account.position.marginBalance, "17.70000000");
  assert.equal(funded.risk.liquidationRequired, true);
  const negative = btc.settleFunding(account(), { markPrice: "50000", settledRate: ".201" });
  assert.equal(negative.account.position.marginBalance, "-5.00000000");
  assert.equal(negative.account.availableBalance, "8997.50000000");
  assert.equal(negative.risk.liquidationRequired, true);
});

for (const g of liquidation.cases) test(`L04 checked teaching liquidation oracle: ${g.id}`, () => {
  const x = g.inputs, expected = g.expected, calc = calculator(x.instrument);
  const opened = calc.openPosition({ availableBalance: x.startingCash, position: null }, {
    side: g.side, contracts: x.contracts, fillPrice: x.entryFillPrice, leverage: "5", liquidityRole: "taker" });
  assert.equal(opened.quote.fee, x.openingFeeAlreadyPaid);
  let state = opened.account;
  if (new D(x.manualTopup).gt(0)) state = calc.addMargin(state, x.manualTopup).account;
  if (!new D(x.fundingAlreadyPaid).isZero()) state = calc.settleFunding(state, {
    markPrice: x.entryFillPrice, settledRate: new D(x.fundingAlreadyPaid).div(new D(x.baseQuantity).times(x.entryFillPrice)).toFixed(),
  }).account;
  assert.equal(state.availableBalance, x.cashOutsidePositionAfterCancellation);
  assert.equal(state.position.marginBalance, x.marginBalanceBeforeTakeover);
  const result = calc.liquidateAfterCancellation(state, { markPrice: x.referenceMark,
    ordersCancelled: true, modelVersion: liquidation.liquidationSettlementModelVersion });
  assert.equal(result.status, "liquidated");
  sameDecimal(result.risk.riskRatio, expected.riskRatio);
  sameDecimal(result.risk.estimatedLiquidationPrice, expected.estimatedLiquidationThresholdUnrounded);
  assert.equal(result.risk.unrealizedPnl, expected.referencePricePnl);
  assert.equal(result.risk.positionEquity, expected.positionEquityAtReferenceMark);
  const { settlement: s } = result;
  assert.equal(s.reference.takerFee, expected.referenceTakerFeeMemoOnly);
  assert.equal(s.reference.remainingEquityWriteoff, expected.remainingEquityWriteoffMemoOnly);
  assert.equal(s.reference.deficitWaiver, expected.deficitWaiverMemoOnly);
  assert.equal(s.aggregateSettlementPnl, expected.aggregateSettlementPnl);
  assert.equal(result.account.availableBalance, expected.finalOutsideCash);
  assert.equal(result.account.position, null);
  assert.equal(new D(result.account.availableBalance).minus(x.startingCash).toFixed(8), expected.netSessionPnl);
  assert.equal(s.actualLiquidationFillPrice, null);
  assert.equal(s.officialClearanceFee, null);
  assert.equal(s.referenceAmountsAreNonPosting, true);
  assert.equal(s.waiverExcludedFromTradingProfitMetrics, true);
  assert.equal(new D(s.reference.pricePnl).minus(s.reference.takerFee).minus(s.reference.remainingEquityWriteoff)
    .plus(s.reference.deficitWaiver).toFixed(8), s.aggregateSettlementPnl);
});

test("L01/L10: cancellation prerequisite, safe recheck and explicit model guard", () => {
  assert.throws(() => btc.liquidateAfterCancellation(account(), { markPrice: "40000", modelVersion: TEACHING_LIQUIDATION_VERSION }), failWith("CANCELLATION_REQUIRED"));
  for (const modelVersion of [undefined, "", "okx-real", "isolated-full-loss-teaching-v2"]) {
    assert.throws(() => btc.liquidateAfterCancellation(account(), { markPrice: "40000", ordersCancelled: true, modelVersion }), failWith("UNSUPPORTED_LIQUIDATION_MODEL"));
  }
  const safe = btc.liquidateAfterCancellation(account(), { markPrice: "41000", ordersCancelled: true, modelVersion: TEACHING_LIQUIDATION_VERSION });
  assert.equal(safe.status, "not-required");
  assert.equal(safe.settlement, null);
  assert.deepEqual(safe.account, account());
});

test("higher tier teaching takeover is full, preserves outside cash and has no invented fill or clearance", () => {
  const input = account({ position: position({ contracts: "1500", entryPrice: "60000", marginBalance: "9000" }) });
  const result = btc.liquidateAfterCancellation(input, { markPrice: "59000", ordersCancelled: true, modelVersion: TEACHING_LIQUIDATION_VERSION });
  assert.equal(result.risk.tier, "2");
  assert.equal(result.account.position, null);
  assert.equal(result.account.availableBalance, input.availableBalance);
  assert.equal(result.settlement.aggregateSettlementPnl, "-9000.00000000");
});

test("control/default/stress prices round adversely; the calculator never guesses maker status", () => {
  for (const slippageBps of [0, 2, 10]) {
    for (const action of ["buy", "sell"]) {
      const quote = btc.quoteMarketFill({ contracts: "10", action, referencePrice: "50500", slippageBps });
      assert.equal(quote.liquidityRole, "taker");
      assert.equal(quote.slippageBps, String(slippageBps));
    }
  }
  assert.throws(() => btc.quoteMarketFill({ contracts: "10", action: "buy", referencePrice: "50000", slippageBps: 3 }), failWith("UNSUPPORTED_SLIPPAGE"));
});

test("pure deterministic values: frozen input survives all operations; rules captured defensively; JSON round-trip works", () => {
  const input = deepFreeze(account());
  const original = structuredClone(input);
  btc.addMargin(input, "500");
  btc.settleFunding(input, { markPrice: "50000", settledRate: ".0001" });
  btc.reducePosition(input, { contracts: "3", fillPrice: "51000", liquidityRole: "maker" });
  const command = deepFreeze({ markPrice: "40000", ordersCancelled: true, modelVersion: TEACHING_LIQUIDATION_VERSION });
  const result = btc.liquidateAfterCancellation(input, command);
  assert.deepEqual(result, btc.liquidateAfterCancellation(input, command));
  assert.deepEqual(input, original);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.settlement.ruleVersion, CRYPTO_RULE_VERSION);
  const copy = structuredClone(rules);
  const calc = calculator("BTC-USDT-SWAP", copy);
  copy.feeBaseline.takerRate = ".1";
  assert.equal(calc.quoteFill({ contracts: "100", fillPrice: "60000", liquidityRole: "taker" }).fee, "30.00000000");
  const invalid = structuredClone(rules);
  invalid.ruleVersion = "unknown";
  assert.throws(() => calculator("BTC-USDT-SWAP", invalid), failWith("UNSUPPORTED_RULES"));
  invalid.ruleVersion = CRYPTO_RULE_VERSION;
  invalid.executionAssumptions.liquidationSettlementDecision.version = "unknown";
  assert.throws(() => calculator("BTC-USDT-SWAP", invalid), failWith("UNSUPPORTED_RULES"));
});
