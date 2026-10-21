import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { normalizeOkxCandles } from "./replay-crypto-scenario.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

// Byte decoding is separate from filesystem access so source-integrity rejection can be tested offline.
export function decodeCryptoSourceJob(bytes, entry) {
  requireValue(hash(bytes) === entry.sha256, `Raw file checksum mismatch: ${entry.file}`);
  const decoded = JSON.parse(gunzipSync(bytes));
  for (const key of ["key", "kind", "instrumentId", "bar", "intervalMs", "start", "endExclusive", "endpoint", "limit"]) {
    requireValue(decoded.job[key] === entry[key], `Raw job identity mismatch: ${entry.file}/${key}`);
  }
  const rows = [];
  for (const page of decoded.pages) {
    const url = new URL(page.url);
    requireValue(url.origin === "https://www.okx.com" && url.pathname === `/api/v5/market/${entry.endpoint}`
      && url.searchParams.get("instId") === entry.instrumentId && url.searchParams.get("bar") === entry.bar,
    `Raw source stream mismatch: ${entry.file}`);
    requireValue(hash(page.responseText) === page.responseSHA256, `Original response checksum mismatch: ${entry.file}`);
    const data = JSON.parse(page.responseText);
    requireValue(data.code === "0", "Non-successful API response");
    rows.push(...data.data.filter((r) => Number(r[0]) >= entry.start && Number(r[0]) < entry.endExclusive));
  }
  const bars = normalizeOkxCandles(rows, { kind: entry.kind, intervalMs: entry.intervalMs });
  requireValue(bars.length === (entry.endExclusive - entry.start) / entry.intervalMs, `Wrong per-job coverage: ${entry.file}`);
  bars.forEach((bar, i) => requireValue(bar.ts === entry.start + i * entry.intervalMs, `Job duplicate/gap: ${entry.file}`));
  return bars;
}
