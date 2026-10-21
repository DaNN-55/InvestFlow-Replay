import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 96 });
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;
export const CRYPTO_VIEW_VERSION = "crypto-prefix-view-v1";
export const CRYPTO_TIMEFRAMES = Object.freeze([1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function timestamp(value, label) {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail("INVALID_TIME", label);
  return Number(value);
}
function numberString(value, { positive = false } = {}) {
  if (typeof value !== "string" || value.length > 64 || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) fail("INVALID_PRICE_OR_RATE", "Use source decimal strings");
  const d = new D(value);
  if (positive && d.lte(0)) fail("INVALID_OHLC", "Prices must be positive");
  return d;
}
function checkBar(bar, kind, intervalMs) {
  if (!Number.isSafeInteger(bar.ts) || (bar.ts + BEIJING_OFFSET_MS) % intervalMs !== 0) fail("BAR_ALIGNMENT", "Misaligned opening timestamp");
  const [o, h, l, c] = [bar.open, bar.high, bar.low, bar.close].map((x) => numberString(x, { positive: true }));
  if (h.lt(D.max(o, c)) || l.gt(D.min(o, c)) || l.gt(h)) fail("INVALID_OHLC", "OHLC bounds disagree");
  if (bar.sourceConfirm !== "1") fail("UNCONFIRMED_BAR", "REST historical bars must be completed");
  if (kind === "last") for (const key of ["volumeContracts", "volumeBase", "volumeQuote"]) {
    if (numberString(bar[key]).isNegative()) fail("INVALID_VOLUME", "Negative volume");
  }
  if (kind === "mark" && ["volumeContracts", "volumeBase", "volumeQuote"].some((key) => key in bar)) {
    fail("MARK_VOLUME", "Mark candles are not trading liquidity");
  }
}
export function normalizeOkxCandles(rows, { kind, intervalMs = MINUTE_MS }) {
  if (!["last", "mark"].includes(kind) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) fail("INVALID_SOURCE", "Unsupported stream/interval");
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== (kind === "last" ? 9 : 6)) fail("INVALID_ROW", "Unexpected OKX candle schema");
    const bar = { ts: timestamp(row[0], "candle ts"), open: row[1], high: row[2], low: row[3], close: row[4], sourceConfirm: row.at(-1) };
    if (kind === "last") Object.assign(bar, { volumeContracts: row[5], volumeBase: row[6], volumeQuote: row[7] });
    checkBar(bar, kind, intervalMs);
    return bar;
  }).sort((a, b) => a.ts - b.ts);
}
export function normalizeOkxFunding(rows, instrumentId) {
  return rows.filter((row) => row.instrument_name === instrumentId).map((row) => {
    const sourceRate = row.funding_rate;
    if (typeof sourceRate !== "string" || sourceRate.length > 64
      || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(sourceRate)) {
      fail("INVALID_PRICE_OR_RATE", "Invalid archived funding rate");
    }
    const settledRate = new D(sourceRate).toFixed();
    numberString(settledRate);
    return { ts: timestamp(row.funding_time, "funding_time"), settledRate, sourceRate,
      method: null, formulaType: null, sourceTimeField: "funding_time" };
  }).sort((a, b) => a.ts - b.ts);
}
function windowOf(scenario) {
  const w = scenario.window;
  if (!w) fail("INVALID_WINDOW", "Missing internal scenario window");
  for (const key of ["backgroundStartMs", "replayStartMs", "replayEndMs", "executionEndMs"]) {
    if (!Number.isSafeInteger(w[key]) || w[key] % MINUTE_MS !== 0) fail("INVALID_WINDOW", key);
  }
  if (!(w.backgroundStartMs < w.replayStartMs && w.replayStartMs < w.replayEndMs
    && w.executionEndMs === w.replayEndMs + MINUTE_MS)) fail("INVALID_WINDOW", "Expected background, replay and exactly one execution minute");
  return w;
}
export function validateCryptoScenario(scenario) {
  if (!["BTC-USDT-SWAP", "ETH-USDT-SWAP"].includes(scenario.instrumentId)) fail("INVALID_INSTRUMENT", "Only confirmed OKX swaps are supported");
  const w = windowOf(scenario);
  const expected = (w.executionEndMs - w.backgroundStartMs) / MINUTE_MS;
  for (const kind of ["last", "mark"]) {
    const rows = scenario[kind];
    if (!Array.isArray(rows) || rows.length !== expected) fail("COVERAGE_GAP", `${kind}: expected ${expected} bars`);
    for (let i = 0; i < rows.length; i++) {
      checkBar(rows[i], kind, MINUTE_MS);
      if (rows[i].ts !== w.backgroundStartMs + i * MINUTE_MS) fail("TIME_SEQUENCE", `${kind}: gap, duplicate or ordering error at ${i}`);
    }
  }
  const audit = scenario.fundingAudit;
  if (!audit || !Number.isSafeInteger(audit.cadenceMs) || audit.cadenceMs < MINUTE_MS
    || !Number.isSafeInteger(audit.maxSourceOffsetMs) || audit.maxSourceOffsetMs < 0
    || audit.maxSourceOffsetMs >= audit.cadenceMs / 2) fail("INVALID_FUNDING_AUDIT", "A window-specific funding cadence audit is required");
  if (!Array.isArray(scenario.funding) || !scenario.funding.length) fail("FUNDING_COVERAGE", "Missing funding archive events");
  const slots = new Set();
  let previous = -1, maxOffset = 0;
  for (const event of scenario.funding) {
    if (!Number.isSafeInteger(event.ts) || event.ts <= previous) fail("FUNDING_SEQUENCE", "Duplicate or unordered funding time");
    numberString(event.settledRate);
    const slot = Math.round(event.ts / audit.cadenceMs) * audit.cadenceMs;
    const offset = Math.abs(event.ts - slot);
    if (offset > audit.maxSourceOffsetMs || slots.has(slot)) fail("FUNDING_CADENCE", "Missing/duplicate cadence slot or excessive source timestamp offset");
    slots.add(slot); previous = event.ts; maxOffset = Math.max(maxOffset, offset);
  }
  const firstSlot = Math.floor(w.backgroundStartMs / audit.cadenceMs) * audit.cadenceMs - audit.cadenceMs;
  const lastSlot = Math.ceil(w.executionEndMs / audit.cadenceMs) * audit.cadenceMs;
  for (let slot = firstSlot; slot <= lastSlot; slot += audit.cadenceMs) {
    if (!slots.has(slot)) fail("FUNDING_COVERAGE", `Missing archive funding slot ${slot}`);
  }
  if (scenario.funding[0].ts >= w.backgroundStartMs || scenario.funding.at(-1).ts <= w.executionEndMs) {
    fail("FUNDING_GUARDS", "Need an original event before and after the full price window");
  }
  let fundingReplayEventsWithMarkProxy = 0;
  for (const event of scenario.funding) {
    if (event.ts < w.replayStartMs || event.ts >= w.executionEndMs) continue;
    const reference = fundingMarkReference(scenario.mark, event.ts);
    if (!reference || reference.knownAtMs > event.ts) fail("FUNDING_MARK_COVERAGE", "Missing causal completed-minute mark proxy");
    fundingReplayEventsWithMarkProxy++;
  }
  return { fundingReplayEventsWithMarkProxy, priceBarsPerStream: expected, backgroundMinutes: (w.replayStartMs - w.backgroundStartMs) / MINUTE_MS,
    replayMinutes: (w.replayEndMs - w.replayStartMs) / MINUTE_MS, executionMinutes: 1,
    fundingEventsWithGuards: scenario.funding.length, maxFundingTimestampOffsetMs: maxOffset,
    observedFundingCadenceAuditMs: audit.cadenceMs };
}

// Callers must pass an already time-bounded prefix. This helper is also used for official cross-checks.
export function aggregateCryptoBars(rows, timeframeMinutes) {
  if (!CRYPTO_TIMEFRAMES.includes(timeframeMinutes)) fail("INVALID_TIMEFRAME", "Unsupported timeframe");
  const duration = timeframeMinutes * MINUTE_MS;
  const result = [];
  for (const row of rows) {
    const start = Math.floor((row.ts + BEIJING_OFFSET_MS) / duration) * duration - BEIJING_OFFSET_MS;
    let group = result.at(-1);
    if (!group || group.ts !== start) {
      group = { ts: start, open: row.open, high: row.high, low: row.low, close: row.close, minuteCount: 0, lastMinuteTs: row.ts };
      if ("volumeContracts" in row) Object.assign(group, { volumeContracts: "0", volumeBase: "0", volumeQuote: "0" });
      result.push(group);
    }
    group.high = D.max(group.high, row.high).toFixed();
    group.low = D.min(group.low, row.low).toFixed();
    group.close = row.close;
    group.minuteCount++;
    group.lastMinuteTs = row.ts;
    if ("volumeContracts" in row) for (const key of ["volumeContracts", "volumeBase", "volumeQuote"]) group[key] = new D(group[key]).plus(row[key]).toFixed();
  }
  return result;
}
function prefixEnd(rows, cutoff, closeDelay) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].ts + closeDelay <= cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// Exact funding-time mark is absent from the archive. Never use the still-forming minute's close.
export function fundingMarkReference(markRows, eventTimeMs) {
  const eventTime = timestamp(eventTimeMs, "funding event time");
  const end = prefixEnd(markRows, eventTime, MINUTE_MS);
  const bar = markRows[end - 1];
  const expectedTs = Math.floor(eventTime / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (!bar || bar.ts !== expectedTs) return null;
  return { price: bar.close, barTs: bar.ts, knownAtMs: bar.ts + MINUTE_MS,
    approximate: true, type: "previous-completed-minute-close" };
}
export function createCryptoScenarioView(input) {
  // Copies prevent a later fetch/parser mutation from changing this frozen internal scenario.
  const scenario = structuredClone(input);
  validateCryptoScenario(scenario);
  const w = scenario.window;
  return Object.freeze({
    visibleAt({ elapsedMinutes, timeframeMinutes = 5 }) {
      if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes < 0
        || elapsedMinutes > (w.executionEndMs - w.replayStartMs) / MINUTE_MS) fail("INVALID_CURSOR", "Cursor must be a minute in the replay/execution window");
      if (!CRYPTO_TIMEFRAMES.includes(timeframeMinutes)) fail("INVALID_TIMEFRAME", "Unsupported timeframe");
      const cutoff = w.replayStartMs + elapsedMinutes * MINUTE_MS;
      const candles = {};
      for (const kind of ["last", "mark"]) {
        // Filter first. Aggregating the full day/hour and then hiding its timestamp leaks future OHLCV.
        const prefix = scenario[kind].slice(0, prefixEnd(scenario[kind], cutoff, MINUTE_MS));
        candles[kind] = aggregateCryptoBars(prefix, timeframeMinutes).map((bar) => {
          const { ts, lastMinuteTs, ...values } = bar;
          return { ...values, startMinute: (ts - w.replayStartMs) / MINUTE_MS,
            knownThroughMinute: (lastMinuteTs + MINUTE_MS - w.replayStartMs) / MINUTE_MS,
            complete: bar.minuteCount === timeframeMinutes && ts + timeframeMinutes * MINUTE_MS <= cutoff };
        });
      }
      const funding = scenario.funding.slice(0, prefixEnd(scenario.funding, cutoff, 0))
        .filter((event) => event.ts >= w.backgroundStartMs).map((event) => ({ relativeTimeMs: event.ts - w.replayStartMs,
          settledRate: event.settledRate, publicationAssumption: "known-at-source-event-time; actual-publication-latency-unknown" }));
      // No UTC timestamps, original dates, raw metadata/URLs, next final rates or complete internal snapshot.
      return { viewVersion: CRYPTO_VIEW_VERSION, instrumentId: scenario.instrumentId,
        elapsedMinutes, timeframeMinutes, candles, funding };
    },
  });
}
