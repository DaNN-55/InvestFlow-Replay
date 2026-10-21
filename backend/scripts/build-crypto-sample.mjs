import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import Decimal from "decimal.js";
import { decodeCryptoSourceJob } from "../src/replay-crypto-source-job.js";
import { MINUTE_MS, DAY_MS, BEIJING_OFFSET_MS, normalizeOkxFunding,
  validateCryptoScenario, aggregateCryptoBars, createCryptoScenarioView } from "../src/replay-crypto-scenario.js";
const D = Decimal.clone({ precision: 96 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folder = resolve(root, "storage/crypto-samples/okx-20240101-v1");
const raw = resolve(folder, "raw");
const manifestPath = resolve(folder, "manifest.json");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const json = (p) => JSON.parse(readFileSync(p));
const check = (ok, message) => { if (!ok) throw new Error(message); };
if (execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim() !== "codex/okx-crypto-training") throw new Error("Use the authorized crypto branch");
const command = process.argv[2] ?? "build";
check(["build", "verify"].includes(command), "Expected build or verify");
const index = json(resolve(raw, "download-index.json"));
const indexHash = hash(readFileSync(resolve(raw, "download-index.json")));
const window = { backgroundStartMs: index.backgroundStart, replayStartMs: index.replayStart,
  replayEndMs: index.replayEnd, executionEndMs: index.executionEndExclusive };
function readJob(entry) {
  return decodeCryptoSourceJob(readFileSync(resolve(raw, entry.file)), entry);
}

function readFunding() {
  const entries = index.entries.filter((e) => e.kind === "fundingArchive");
  const seen = new Set();
  const records = [];
  // Standard-library ZIP/CSV decoding; never extracts archive paths to disk.
  for (const entry of entries) {
    check(!seen.has(entry.date), `Duplicate funding archive date ${entry.date}`); seen.add(entry.date);
    check(hash(readFileSync(resolve(raw, entry.file))) === entry.sha256, `Funding checksum mismatch: ${entry.file}`);
  }
  const output = execFileSync("python3", ["-c", `import csv,io,json,zipfile,sys
from pathlib import Path
index=json.loads(Path(sys.argv[1]).read_text())
rows=[]
for e in index['entries']:
 if e.get('kind')!='fundingArchive':continue
 with zipfile.ZipFile(Path(sys.argv[1]).parent/e['file']) as z:
  for name in z.namelist():
   if not name.endswith('.csv'):continue
   for r in csv.DictReader(io.StringIO(z.read(name).decode('utf-8-sig'))):
    if r.get('instrument_name') in index['instruments']:rows.append({**r,'sourceDate':e['date']})
print(json.dumps(rows))`, resolve(raw, "download-index.json")], { maxBuffer: 8 * 1024 * 1024 });
  records.push(...JSON.parse(output));
  const first = window.backgroundStartMs - DAY_MS;
  const last = window.replayEndMs;
  for (let day = first; day <= last; day += DAY_MS) {
    const date = new Date(day + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
    check(seen.has(date), `Missing funding archive day ${date}`);
    for (const instId of index.instruments) check(records.filter((r) => r.sourceDate === date && r.instrument_name === instId).length === 3,
      `Expected 3 source funding records for this historical window: ${date}/${instId}`);
  }
  return records;
}
function crosscheck(minutes, official, timeframe, kind) {
  const derived = aggregateCryptoBars(minutes.filter((b) => b.ts < window.replayEndMs), timeframe);
  check(derived.length === official.length, `${kind}/${timeframe} aggregate coverage`);
  const keys = ["open", "high", "low", "close", ...(kind === "last" ? ["volumeContracts", "volumeBase", "volumeQuote"] : [])];
  for (let i = 0; i < derived.length; i++) {
    check(derived[i].ts === official[i].ts && derived[i].minuteCount === timeframe, "Coarse time alignment");
    for (const key of keys) check(new D(derived[i][key]).eq(official[i][key]), `Official mismatch ${kind}/${timeframe}/${official[i].ts}/${key}: ${derived[i][key]} != ${official[i][key]}`);
  }
  return { timeframeMinutes: timeframe, checkedBars: derived.length, fields: keys, exact: true };
}
function prefixChecks(scenario) {
  const supply = createCryptoScenarioView(scenario);
  for (const elapsedMinutes of [0, 1, 5, 61, 1441, 4320, 4321]) {
    for (const timeframeMinutes of [5, 60, 1440]) {
      const view = supply.visibleAt({ elapsedMinutes, timeframeMinutes });
      check(!JSON.stringify(view).includes(String(window.replayStartMs)), "UTC replay date leaked");
      for (const kind of ["last", "mark"]) for (const b of view.candles[kind]) check(b.knownThroughMinute <= elapsedMinutes, "Future candle leaked");
      for (const f of view.funding) check(f.relativeTimeMs <= elapsedMinutes * MINUTE_MS, "Future funding leaked");
      if (elapsedMinutes === 5 && timeframeMinutes === 1440) {
        const day = view.candles.last.at(-1);
        check(day.minuteCount === 5 && day.complete === false, "Current daily bar used future minutes");
      }
    }
  }
  const altered = structuredClone(scenario);
  const cutoff = window.replayStartMs + 5 * MINUTE_MS;
  for (const kind of ["last", "mark"]) for (const bar of altered[kind]) {
    if (bar.ts + MINUTE_MS <= cutoff) continue;
    Object.assign(bar, { open: "99999", high: "999999", low: "1", close: "88888" });
    if (kind === "last") Object.assign(bar, { volumeContracts: "999999", volumeBase: "99999", volumeQuote: "8888888" });
  }
  for (const event of altered.funding) if (event.ts > cutoff) event.settledRate = "-.987654321";
  altered.internalFutureMetadata = { actualDate: "2030-12-31", finalRate: "-999" };
  const poisonedSupply = createCryptoScenarioView(altered);
  for (const timeframeMinutes of [5, 1440]) {
    const cursor = { elapsedMinutes: 5, timeframeMinutes };
    check(hash(JSON.stringify(supply.visibleAt(cursor))) === hash(JSON.stringify(poisonedSupply.visibleAt(cursor))),
      `Real-data future perturbation leaked for ${timeframeMinutes}m`);
  }
  return { checkedCursors: [0, 1, 5, 61, 1441, 4320, 4321], timeframes: [5, 60, 1440],
    realDataFuturePerturbation: { elapsedMinutes: 5, timeframes: [5, 1440], unchanged: true }, passed: true };
}
if (command === "build") {
  check(!existsSync(manifestPath), "Frozen manifest exists; use verify instead of silently overwriting");
  const sourceFunding = readFunding();
  const instruments = {};
  for (const instId of index.instruments) {
    const streams = {};
    const checks = [];
    for (const kind of ["last", "mark"]) {
      const entries = index.entries.filter((e) => e.instrumentId === instId && e.kind === kind);
      const minuteEntries = entries.filter((e) => e.bar === "1m").sort((a, b) => a.start - b.start);
      streams[kind] = minuteEntries.flatMap(readJob);
      for (const [bar, tf] of [["1H", 60], ["1D", 1440]]) {
        checks.push({ kind, ...crosscheck(streams[kind], readJob(entries.find((e) => e.bar === bar)), tf, kind) });
      }
    }
    const cadenceMs = 8 * 60 * MINUTE_MS;
    const firstSlot = Math.floor(window.backgroundStartMs / cadenceMs) * cadenceMs - cadenceMs;
    const lastSlot = Math.ceil(window.executionEndMs / cadenceMs) * cadenceMs;
    const funding = normalizeOkxFunding(sourceFunding, instId).filter((e) => {
      const slot = Math.round(e.ts / cadenceMs) * cadenceMs;
      return slot >= firstSlot && slot <= lastSlot;
    });
    const scenario = { instrumentId: instId, window, ...streams, funding,
      fundingAudit: { cadenceMs, maxSourceOffsetMs: 120000, appliesOnlyToThisHistoricalWindow: true } };
    const validation = validateCryptoScenario(scenario);
    check(validation.backgroundMinutes === 90 * 1440 && validation.replayMinutes === 4320, "Wrong requested window");
    const visibility = prefixChecks(scenario);
    const files = {};
    for (const kind of ["last", "mark", "funding"]) {
      const file = `${instId}.${kind}.json.gz`;
      const bytes = gzipSync(JSON.stringify(scenario[kind]), { level: 9 });
      writeFileSync(resolve(folder, file), bytes);
      files[kind] = { file, sha256: hash(bytes), rows: scenario[kind].length, bytes: bytes.length };
    }
    instruments[instId] = { files, validation, crosschecks: checks, visibility,
      fundingAudit: scenario.fundingAudit,
      fundingReplayEvents: funding.filter((e) => e.ts >= window.replayStartMs && e.ts < window.executionEndMs).length,
      fundingRateMetadata: { method: null, formulaType: null, actualPublicationLatency: null,
        semantics: "Archive funding_time retained verbatim; no forced rounding to nominal schedule" } };
    console.log(JSON.stringify({ instrumentId: instId, validation, crosschecks: checks.map(({ kind, timeframeMinutes, checkedBars }) => ({ kind, timeframeMinutes, checkedBars })) }));
  }
  const manifest = { schemaVersion: "okx-frozen-sample-v1", dataVersion: "okx-20240101-v1", exchange: "OKX", instType: "SWAP",
    timezone: "Asia/Shanghai", sourceTimeUnit: "UTC epoch milliseconds", window, sourceIndex: { file: "raw/download-index.json", sha256: indexHash },
    rawFileCount: index.entries.length, ruleVersion: "okx-usdt-swap-training-2026-10-19-v1", instruments,
    limitations: ["1m OHLC does not reconstruct intraminute ordering or actual liquidation fills", "funding_time archive seconds and actual publication latency are not inferred", "8h cadence audit applies only to this frozen historical window", "BTC/ETH same-period samples are related exposure; not unseen test results"] };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ status: "frozen", manifest: relative(root, manifestPath), sha256: hash(readFileSync(manifestPath)) }));
} else {
  const manifest = json(manifestPath);
  check(manifest.sourceIndex.sha256 === indexHash, "Source index checksum mismatch");
  readFunding();
  for (const entry of index.entries.filter((e) => e.kind !== "fundingArchive")) readJob(entry);
  const results = {};
  for (const [instrumentId, info] of Object.entries(manifest.instruments)) {
    const scenario = { instrumentId, window: manifest.window, fundingAudit: info.fundingAudit };
    for (const [kind, file] of Object.entries(info.files)) {
      const bytes = readFileSync(resolve(folder, file.file));
      check(hash(bytes) === file.sha256, `Normalized checksum mismatch: ${file.file}`);
      scenario[kind] = JSON.parse(gunzipSync(bytes));
    }
    const validation = validateCryptoScenario(scenario);
    const visibility = prefixChecks(scenario);
    results[instrumentId] = { validation, visibility };
  }
  console.log(JSON.stringify({ status: "verified-offline", manifestSHA256: hash(readFileSync(manifestPath)),
    instruments: Object.keys(manifest.instruments), rawFiles: index.entries.length, results }));
}
