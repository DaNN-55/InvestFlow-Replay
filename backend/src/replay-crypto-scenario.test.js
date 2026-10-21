import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { decodeCryptoSourceJob } from "./replay-crypto-source-job.js";
import { MINUTE_MS as M, DAY_MS, CRYPTO_TIMEFRAMES, normalizeOkxCandles, normalizeOkxFunding,
  validateCryptoScenario, aggregateCryptoBars, createCryptoScenarioView, fundingMarkReference } from "./replay-crypto-scenario.js";
const START = Date.parse("2024-01-01T00:00:00+08:00");
const error = (code) => (e) => e.code === code;
const lastRow = (ts, i = 0) => [String(ts), String(100 + i), String(103 + i), String(98 + i), String(101 + i), "10", ".1", "10.05", "1"];
const markRow = (ts, i = 0) => [String(ts), String(100 + i), String(103 + i), String(98 + i), String(101 + i), "1"];
function sample() {
  const window = { backgroundStartMs: START - 60 * M, replayStartMs: START, replayEndMs: START + 180 * M, executionEndMs: START + 181 * M };
  const rows = Array.from({ length: 241 }, (_, i) => window.backgroundStartMs + i * M);
  const funding = [];
  for (let ts = START - 120 * M; ts <= START + 240 * M; ts += 60 * M) {
    funding.push({ ts: ts + (ts === START + 60 * M ? 1000 : 0), settledRate: ".0001", method: null, formulaType: null });
  }
  return { instrumentId: "BTC-USDT-SWAP", window, funding,
    fundingAudit: { cadenceMs: 60 * M, maxSourceOffsetMs: 120000 },
    last: normalizeOkxCandles(rows.map((t, i) => lastRow(t, i)), { kind: "last" }),
    mark: normalizeOkxCandles(rows.map((t, i) => markRow(t, i)), { kind: "mark" }),
    metadata: { futureSecret: "2024-01-01", sourceUrl: "https://example.invalid/future" } };
}
const clone = (x) => structuredClone(x);

test("source schemas separate contract/base/quote volumes from mark candles", () => {
  const last = normalizeOkxCandles([lastRow(START)], { kind: "last" })[0];
  const mark = normalizeOkxCandles([markRow(START)], { kind: "mark" })[0];
  assert.equal(last.volumeContracts, "10"); assert.equal(last.volumeBase, ".1"); assert.equal(last.volumeQuote, "10.05");
  assert.equal("volumeContracts" in mark, false);
  assert.throws(() => normalizeOkxCandles([lastRow(START)], { kind: "mark" }), error("INVALID_ROW"));
  assert.throws(() => normalizeOkxCandles([markRow(START)], { kind: "last" }), error("INVALID_ROW"));
});

test("reject unconfirmed REST records, broken OHLC, negative volume, and second/ms confusion", () => {
  const unconfirmed = lastRow(START); unconfirmed[8] = "0";
  assert.throws(() => normalizeOkxCandles([unconfirmed], { kind: "last" }), error("UNCONFIRMED_BAR"));
  const bad = lastRow(START); bad[2] = "99";
  assert.throws(() => normalizeOkxCandles([bad], { kind: "last" }), error("INVALID_OHLC"));
  const negative = lastRow(START); negative[5] = "-1";
  assert.throws(() => normalizeOkxCandles([negative], { kind: "last" }), error("INVALID_VOLUME"));
  assert.throws(() => normalizeOkxCandles([lastRow(START / 1000)], { kind: "last" }), error("BAR_ALIGNMENT"));
  for (const value of ["NaN", "Infinity", "0x10", "1e4", 100]) {
    const row = lastRow(START); row[1] = value;
    assert.throws(() => normalizeOkxCandles([row], { kind: "last" }), error("INVALID_PRICE_OR_RATE"));
  }
});

test("normalizing order does not silently discard duplicate records", () => {
  const ordered = normalizeOkxCandles([lastRow(START + M), lastRow(START)], { kind: "last" });
  assert.deepEqual(ordered.map((r) => r.ts), [START, START + M]);
  assert.equal(normalizeOkxCandles([lastRow(START), lastRow(START)], { kind: "last" }).length, 2);
});

test("scenario validates exact background/replay/execution-minute boundaries", () => {
  const result = validateCryptoScenario(sample());
  assert.equal(result.priceBarsPerStream, 241); assert.equal(result.backgroundMinutes, 60);
  assert.equal(result.replayMinutes, 180); assert.equal(result.executionMinutes, 1);
  assert.equal(result.maxFundingTimestampOffsetMs, 1000);
});

for (const kind of ["last", "mark"]) test(`reject ${kind} coverage gaps, duplicates, ordering errors and timestamp shifts`, () => {
  const missing = sample(); missing[kind].splice(2, 1);
  assert.throws(() => validateCryptoScenario(missing), error("COVERAGE_GAP"));
  const duplicate = sample(); duplicate[kind][2] = clone(duplicate[kind][1]);
  assert.throws(() => validateCryptoScenario(duplicate), error("TIME_SEQUENCE"));
  const unordered = sample(); [unordered[kind][1], unordered[kind][2]] = [unordered[kind][2], unordered[kind][1]];
  assert.throws(() => validateCryptoScenario(unordered), error("TIME_SEQUENCE"));
  const shifted = sample(); shifted[kind][2].ts += 1000;
  assert.throws(() => validateCryptoScenario(shifted), error("BAR_ALIGNMENT"));
});

test("funding normalization retains source seconds, rate sign and unknown metadata", () => {
  const rows = [{ instrument_name: "ETH-USDT-SWAP", funding_rate: "-.000123456789", funding_time: String(START + 1000) },
    { instrument_name: "BTC-USDT-SWAP", funding_rate: ".0001", funding_time: String(START) }];
  const result = normalizeOkxFunding(rows, "ETH-USDT-SWAP");
  assert.equal(result.length, 1); assert.equal(result[0].ts, START + 1000);
  assert.equal(result[0].settledRate, "-0.000123456789"); assert.equal(result[0].sourceRate, "-.000123456789");
  assert.equal(result[0].method, null); assert.equal(result[0].formulaType, null);
});

test("scientific funding notation is converted exactly while retaining its original lexeme", () => {
  const [event] = normalizeOkxFunding([{ instrument_name: "BTC-USDT-SWAP", funding_rate: "-3.035143876E-7", funding_time: String(START) }], "BTC-USDT-SWAP");
  assert.equal(event.sourceRate, "-3.035143876E-7");
  assert.equal(event.settledRate, "-0.0000003035143876");
  for (const funding_rate of ["Infinity", "NaN", "0x10", 0.001]) {
    assert.throws(() => normalizeOkxFunding([{ instrument_name: "BTC-USDT-SWAP", funding_rate, funding_time: String(START) }], "BTC-USDT-SWAP"), error("INVALID_PRICE_OR_RATE"));
  }
});

test("reject missing/duplicate funding slots and offsets beyond the explicit window-specific audit", () => {
  const missing = sample(); missing.funding.splice(2, 1);
  assert.throws(() => validateCryptoScenario(missing), error("FUNDING_COVERAGE"));
  const duplicate = sample(); duplicate.funding.splice(2, 0, clone(duplicate.funding[1]));
  assert.throws(() => validateCryptoScenario(duplicate), error("FUNDING_SEQUENCE"));
  const duplicateSlot = sample(); duplicateSlot.funding[2].ts = duplicateSlot.funding[1].ts + 1;
  assert.throws(() => validateCryptoScenario(duplicateSlot), error("FUNDING_CADENCE"));
  const shifted = sample(); shifted.funding[2].ts += 180000;
  assert.throws(() => validateCryptoScenario(shifted), error("FUNDING_CADENCE"));
  const invalidWindow = sample(); invalidWindow.window.executionEndMs += M;
  assert.throws(() => validateCryptoScenario(invalidWindow), error("INVALID_WINDOW"));
});

test("daily aggregation uses Beijing midnight and exact three-unit volume sums", () => {
  const rows = normalizeOkxCandles([lastRow(START - M), lastRow(START, 1), lastRow(START + M, 2)], { kind: "last" });
  const days = aggregateCryptoBars(rows, 1440);
  assert.equal(days.length, 2); assert.equal(days[0].ts, START - DAY_MS); assert.equal(days[1].ts, START);
  assert.equal(days[1].minuteCount, 2); assert.equal(days[1].volumeContracts, "20");
  assert.equal(days[1].volumeBase, "0.2"); assert.equal(days[1].volumeQuote, "20.1");
});

test("initial projection exposes only completed background, not the replay opening candle", () => {
  const view = createCryptoScenarioView(sample()).visibleAt({ elapsedMinutes: 0, timeframeMinutes: 1 });
  assert.equal(view.candles.last.length, 60); assert.equal(view.candles.mark.length, 60);
  assert.equal(view.candles.last.at(-1).startMinute, -1); assert.equal(view.candles.last.at(-1).knownThroughMinute, 0);
  assert.equal(view.candles.last.some((b) => b.startMinute >= 0), false);
});

test("partial hour/day bars contain only already-completed minutes", () => {
  const supply = createCryptoScenarioView(sample());
  for (const timeframeMinutes of [60, 1440]) {
    const first = supply.visibleAt({ elapsedMinutes: 1, timeframeMinutes }).candles.last.at(-1);
    assert.equal(first.startMinute, 0); assert.equal(first.minuteCount, 1);
    assert.equal(first.open, "160"); assert.equal(first.high, "163"); assert.equal(first.low, "158"); assert.equal(first.close, "161");
    assert.equal(first.complete, false);
    const five = supply.visibleAt({ elapsedMinutes: 5, timeframeMinutes }).candles.last.at(-1);
    assert.equal(five.minuteCount, 5); assert.equal(five.high, "167"); assert.equal(five.close, "165"); assert.equal(five.volumeContracts, "50");
  }
});

test("final funding rates become visible at source time, never at a rounded earlier hour", () => {
  const supply = createCryptoScenarioView(sample());
  assert.equal(supply.visibleAt({ elapsedMinutes: 60 }).funding.some((f) => f.relativeTimeMs === 60 * M + 1000), false);
  const after = supply.visibleAt({ elapsedMinutes: 61 }).funding;
  assert.equal(after.some((f) => f.relativeTimeMs === 60 * M + 1000), true);
  assert.ok(after.every((f) => f.relativeTimeMs <= 61 * M));
});

for (const timeframeMinutes of CRYPTO_TIMEFRAMES) test(`future OHLCV/funding/metadata mutations leave the current ${timeframeMinutes}m view unchanged`, () => {
  const original = sample(); const poisoned = clone(original); const elapsedMinutes = 5; const cutoff = START + elapsedMinutes * M;
  for (const kind of ["last", "mark"]) for (const bar of poisoned[kind]) if (bar.ts + M > cutoff) {
    Object.assign(bar, { open: "99999", high: "999999", low: "1", close: "88888" });
    if (kind === "last") Object.assign(bar, { volumeContracts: "999999", volumeBase: "9999.99", volumeQuote: "8888888" });
  }
  for (const event of poisoned.funding) if (event.ts > cutoff) event.settledRate = "-.987654321";
  poisoned.metadata = { futureSecret: "2030-12-31", nextRate: "-999" };
  const cursor = { elapsedMinutes, timeframeMinutes };
  assert.deepEqual(createCryptoScenarioView(original).visibleAt(cursor), createCryptoScenarioView(poisoned).visibleAt(cursor));
});

test("blind projection strips UTC timestamps, dates, source URLs and internal metadata", () => {
  const supply = createCryptoScenarioView(sample()); assert.deepEqual(Object.keys(supply), ["visibleAt"]);
  const view = supply.visibleAt({ elapsedMinutes: 5 }); const serialized = JSON.stringify(view);
  for (const forbidden of [String(START), "2024-01-01", "sourceUrl", '"ts"', "futureSecret", "nextRate", "backgroundStartMs"]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.deepEqual(JSON.parse(serialized), view);
});

test("input and returned-view mutations cannot change the frozen supply", () => {
  const input = sample(); const supply = createCryptoScenarioView(input); const expected = supply.visibleAt({ elapsedMinutes: 5 });
  input.last[60].close = "1"; input.funding[0].settledRate = ".9"; input.window.replayStartMs += DAY_MS;
  const edited = supply.visibleAt({ elapsedMinutes: 5 }); edited.candles.last[0].close = "-1";
  assert.deepEqual(supply.visibleAt({ elapsedMinutes: 5 }), expected);
});

test("one-minute and batched advancement yield identical visible prefixes; reserve minute is withheld until revealed", () => {
  const supply = createCryptoScenarioView(sample()); let stepped;
  for (let elapsedMinutes = 0; elapsedMinutes <= 15; elapsedMinutes++) stepped = supply.visibleAt({ elapsedMinutes });
  assert.deepEqual(stepped, supply.visibleAt({ elapsedMinutes: 15 }));
  assert.equal(supply.visibleAt({ elapsedMinutes: 180, timeframeMinutes: 1 }).candles.last.at(-1).startMinute, 179);
  assert.equal(supply.visibleAt({ elapsedMinutes: 181, timeframeMinutes: 1 }).candles.last.at(-1).startMinute, 180);
});

test("invalid cursors and timeframes cannot extend the frozen replay/execution bounds", () => {
  const supply = createCryptoScenarioView(sample());
  for (const elapsedMinutes of [-1, 1.5, 182, NaN, Infinity, "5"]) assert.throws(() => supply.visibleAt({ elapsedMinutes }), error("INVALID_CURSOR"));
  for (const timeframeMinutes of [0, 2, 2880, "5"]) assert.throws(() => supply.visibleAt({ elapsedMinutes: 1, timeframeMinutes }), error("INVALID_TIMEFRAME"));
});


test("funding mark proxy is the preceding completed minute, including source events one second after the hour", () => {
  const scenario = sample();
  const atHour = fundingMarkReference(scenario.mark, START + 60 * M);
  const oneSecondLater = fundingMarkReference(scenario.mark, START + 60 * M + 1000);
  assert.equal(atHour.barTs, START + 59 * M);
  assert.deepEqual(atHour, oneSecondLater);
  assert.equal(oneSecondLater.price, scenario.mark[119].close);
  assert.equal(oneSecondLater.approximate, true);
  assert.ok(oneSecondLater.knownAtMs <= START + 60 * M + 1000);
  assert.equal(fundingMarkReference(scenario.mark, scenario.window.backgroundStartMs), null);
  assert.equal(fundingMarkReference(scenario.mark, scenario.window.executionEndMs + M), null);
});

test("source bytes verify outer and inner hashes, identity, exchange stream and complete coverage", () => {
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const job = { key: "fixture", kind: "last", instrumentId: "BTC-USDT-SWAP", bar: "1m", intervalMs: M,
    start: START, endExclusive: START + M, endpoint: "history-candles", limit: 300 };
  const body = JSON.stringify({ code: "0", data: [lastRow(START)] });
  const envelope = { job, pages: [{ url: "https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1m",
    responseText: body, responseSHA256: sha(body) }] };
  const packed = (value) => gzipSync(JSON.stringify(value));
  const bytes = packed(envelope);
  const entry = { ...job, file: "fixture.gz", sha256: sha(bytes) };
  assert.equal(decodeCryptoSourceJob(bytes, entry)[0].close, "101");
  assert.throws(() => decodeCryptoSourceJob(Buffer.from("corrupt"), entry), /Raw file checksum/);
  const changedResponse = clone(envelope); changedResponse.pages[0].responseText += " ";
  const changedBytes = packed(changedResponse);
  assert.throws(() => decodeCryptoSourceJob(changedBytes, { ...entry, sha256: sha(changedBytes) }), /Original response checksum/);
  assert.throws(() => decodeCryptoSourceJob(bytes, { ...entry, instrumentId: "ETH-USDT-SWAP" }), /Raw job identity/);
  const changedStream = clone(envelope); changedStream.pages[0].url = changedStream.pages[0].url.replace("BTC-USDT", "ETH-USDT");
  const streamBytes = packed(changedStream);
  assert.throws(() => decodeCryptoSourceJob(streamBytes, { ...entry, sha256: sha(streamBytes) }), /Raw source stream/);
  const missing = clone(envelope); missing.pages[0].responseText = JSON.stringify({ code: "0", data: [] });
  missing.pages[0].responseSHA256 = sha(missing.pages[0].responseText);
  const missingBytes = packed(missing);
  assert.throws(() => decodeCryptoSourceJob(missingBytes, { ...entry, sha256: sha(missingBytes) }), /Wrong per-job coverage/);
});
