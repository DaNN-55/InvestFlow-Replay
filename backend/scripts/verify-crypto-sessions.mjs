import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import Decimal from "decimal.js";
import { createDatabase } from "../src/db.js";
import { createReplayLifecycleStore } from "../src/replay-lifecycle-store.js";
import { createCryptoReplayService, createFrozenOkxSource } from "../src/replay-crypto-session.js";
import { cryptoHash } from "../src/replay-crypto-persistence.js";
const D = Decimal.clone({ precision: 96 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "codex/okx-crypto-training");
const baselineFile = resolve(root, "docs/research/okx-sample-evidence/2026-10-20-p3b-orders-validation.json");
const baseline = JSON.parse(readFileSync(baselineFile)); assert.equal(baseline.status, "verified-p3b-offline");
for (const [file, expected] of Object.entries(baseline.codeSHA256)) assert.equal(cryptoHash(readFileSync(resolve(root, file))), expected, file);
const folder = mkdtempSync(join(tmpdir(), "crypto-p4-real-")), path = join(folder, "replay.sqlite");
const source = createFrozenOkxSource(); let sourceAllowed = true, sourceLoads = 0, database, service;
const snapshotSource = { load(id) { assert.ok(sourceAllowed, "Recovery/retrain must not load the current source"); sourceLoads++; return source.load(id); } };
function open() { database = createDatabase(path); service = createCryptoReplayService({ store: createReplayLifecycleStore(database), snapshotSource }); }
function reopen() { database.close(); open(); }
function allAudit(id, kind) {
  const items = []; let after = kind === "ledger" ? -1 : 0;
  for (;;) {
    const r = service.audit(id, kind, { after, limit: 200 }).items; items.push(...r);
    if (r.length < 200) return items;
    after = kind === "ledger" ? r.at(-1).revision : r.at(-1).sequence;
  }
}
function reconcile(s) {
  const entries = allAudit(s.id, "ledger"), sum = (key) => entries.reduce((n, e) => n.plus(e[key]), new D(0)).toFixed(8);
  assert.equal(sum("availableDelta"), s.account.availableBalance); assert.equal(sum("reservedDelta"), s.reservedBalance);
  assert.equal(sum("marginDelta"), s.account.position?.marginBalance ?? "0.00000000");
  for (const [key, total] of [["feesDelta", "tradingFees"], ["fundingDelta", "fundingPayments"], ["realizedDelta", "realizedPricePnl"], ["liquidationDelta", "liquidationAggregatePnl"]]) assert.equal(sum(key), s.totals[total]);
  const trace = allAudit(s.id, "traces"); assert.ok(trace.every((e, i) => e.sequence === i + 1));
  return { ledgerRows: entries.length, traceRows: trace.length, ledgerSHA256: cryptoHash(JSON.stringify(entries)), traceSHA256: cryptoHash(JSON.stringify(trace)) };
}
const results = {};
try {
  open();
  for (const instrumentId of Object.keys(baseline.results)) {
    const result = { normalCases: [], riskCases: [] };
    for (const side of ["long", "short"]) {
      sourceAllowed = true;
      const createRequest = { market: "crypto-perpetual", actionId: `${instrumentId}-${side}-create`, instrumentId };
      const created = service.create(createRequest); let s = created.session;
      assert.throws(() => service.market(s.id, { elapsedMinutes: 1 }), (e) => e.code === "REPLAY_CURSOR_FORBIDDEN");
      let number = 0;
      function command(command) { const request = { actionId: `command-${number++}`, expectedRevision: s.revision, command }; const r = service.command(s.id, request); s = r.session; return { request, result: r }; }
      function go(target) {
        while (s.elapsedMinutes < target) {
          const left = target - s.elapsedMinutes, minutes = left >= 15 ? 15 : left >= 5 ? 5 : 1;
          const request = { actionId: `advance-${number++}`, expectedRevision: s.revision, minutes };
          const r = service.advance(s.id, request); s = r.session;
          assert.deepEqual(service.advance(s.id, request).session, s);
        }
      }
      go(1);
      const long = side === "long", tick = instrumentId.startsWith("BTC") ? ".1" : ".01";
      const protection = { stopLoss: { price: new D(s.currentPrices.last).times(long ? ".5" : "1.5").toNearest(tick).toFixed() },
        takeProfit: { price: new D(s.currentPrices.last).times(long ? "1.5" : ".5").toNearest(tick).toFixed() } };
      const submitted = command({ type: "market-open", side, contracts: "10", protection }); go(2);
      const retryOrder = service.command(s.id, submitted.request); assert.equal(retryOrder.idempotent, true); assert.deepEqual(retryOrder.session, submitted.result.session);
      command({ type: "add-margin", amount: "500" }); go(100); command({ type: "market-open", side, contracts: "5" }); go(101);
      const beforeRestart = structuredClone(s), loadsBeforeRestart = sourceLoads;
      sourceAllowed = false; reopen(); assert.deepEqual(service.get(s.id).session, beforeRestart);
      assert.throws(() => service.market(s.id, { elapsedMinutes: s.elapsedMinutes + 1 }), (e) => e.code === "REPLAY_CURSOR_FORBIDDEN");
      go(600);
      const closeBuy = side === "short";
      command({ type: "limit-close", contracts: "4", limitPrice: new D(s.currentPrices.last).times(closeBuy ? "1.01" : ".99").toNearest(tick, closeBuy ? D.ROUND_CEIL : D.ROUND_FLOOR).toFixed() }); go(601);
      assert.equal(s.account.position.contracts, "11"); assert.equal(s.protection.contracts, "11");
      go(1000); command({ type: "market-close" }); go(1001);
      const expected = baseline.results[instrumentId].oracleCases.find((x) => x.side === side && x.slippageBps === 2);
      assert.equal(s.account.availableBalance, expected.availableBalance);
      for (const key of ["tradingFees", "fundingPayments", "realizedPricePnl"]) assert.equal(s.totals[key], expected[key]);
      assert.equal(s.orders.length, 0); assert.equal(s.protection, null); const ledger = reconcile(s);
      const finished = service.finish(s.id, { actionId: `finish-${number++}`, expectedRevision: s.revision }); s = finished.session;
      assert.equal(s.status, "completed");
      s = service.saveBlindReview(s.id, { actionId: `blind-${number++}`, expectedRevision: s.revision, review: { thesis: "固定工程数值验证", tradePlan: "验证费用及恢复，非策略表现" } }).session;
      s = service.reveal(s.id, { actionId: `reveal-${number++}`, expectedRevision: s.revision }).session;
      const original = structuredClone(s), retrainRequest = { actionId: `retrain-${number++}`, expectedRevision: s.revision };
      const child = service.retrain(s.id, retrainRequest).session;
      assert.equal(child.elapsedMinutes, 0); assert.equal(child.account.availableBalance, "10000.00000000"); assert.equal(child.attemptInfo.sourceSessionId, s.id);
      assert.equal(child.frozenRules.slippageBps, "2"); assert.equal(child.revealed, false);
      assert.deepEqual(database.getReplaySession(child.id).snapshot, database.getReplaySession(s.id).snapshot);
      assert.deepEqual(service.retrain(s.id, retrainRequest).session, child); assert.deepEqual(service.get(s.id).session, original);
      assert.equal(sourceLoads, loadsBeforeRestart);
      assert.deepEqual(service.create(createRequest).session, created.session);
      result.normalCases.push({ side, finalAvailable: s.account.availableBalance, fees: s.totals.tradingFees, funding: s.totals.fundingPayments,
        pricePnl: s.totals.realizedPricePnl, equalsP3bIndependentOracle: true, resumeAtMinute: 101, retrainFrozen: true,
        retriesReturnOriginalCursor: true, futureCursorRejected: true, currentSourceUnusedAfterRestart: true, ...ledger });
      process.stderr.write(`${instrumentId} ${side}: transactional resume/retrain/ledger verified\n`);
    }
    sourceAllowed = true;
    let risky = service.create({ market: "crypto-perpetual", actionId: `${instrumentId}-risk`, instrumentId, leverage: "100" }).session;
    let i = 0;
    const cmd = (command) => { const r = service.command(risky.id, { actionId: `risk-command-${i++}`, expectedRevision: risky.revision, command }); risky = r.session; };
    cmd({ type: "market-open", side: "long", contracts: "10", protection: { stopLoss: { price: new D(risky.currentPrices.last).times(".5").toNearest(instrumentId.startsWith("BTC") ? ".1" : ".01").toFixed() } } });
    risky = service.advance(risky.id, { actionId: `risk-advance-${i++}`, expectedRevision: risky.revision, minutes: 1 }).session;
    const outside = risky.account.availableBalance;
    cmd({ type: "limit-open", side: "long", contracts: "1", limitPrice: new D(risky.currentPrices.last).times(".5").toNearest(instrumentId.startsWith("BTC") ? ".1" : ".01").toFixed() });
    sourceAllowed = false; let lastRequest;
    while (risky.account.position) {
      lastRequest = { actionId: `risk-advance-${i++}`, expectedRevision: risky.revision, minutes: 15 };
      risky = service.advance(risky.id, lastRequest).session;
    }
    assert.equal(risky.account.availableBalance, outside); assert.equal(risky.orders.length, 0); assert.equal(risky.protection, null);
    const riskLedger = reconcile(risky), takeovers = allAudit(risky.id, "traces").filter((x) => x.type === "teaching-liquidation");
    assert.equal(takeovers.length, 1); assert.equal(takeovers[0].settlement.referenceAmountsAreNonPosting, true);
    assert.deepEqual(service.advance(risky.id, lastRequest).session, risky); reopen(); assert.deepEqual(service.get(risky.id).session, risky);
    result.riskCases.push({ side: "long", leverageForTest: "100", takeoverCount: 1, observedAtMinute: risky.elapsedMinutes,
      outsideCashPreserved: true, retryAndRestartNoDoublePosting: true, ...riskLedger });
    results[instrumentId] = result;
  }
  const raw = new DatabaseSync(path);
  const snapshotDocuments = raw.prepare("SELECT count(*) n FROM replay_crypto_snapshots").get().n;
  const sessions = raw.prepare("SELECT count(*) n FROM replay_sessions").get().n; raw.close();
  assert.equal(snapshotDocuments, 2); assert.equal(sessions, 10);
  const files = ["backend/src/db.js", "backend/src/app.js", "backend/src/replay-interaction.js", "backend/src/replay-lifecycle-store.js",
    "backend/src/replay-crypto-persistence.js", "backend/src/replay-crypto-session.js", "backend/src/replay-crypto-session.test.js", "backend/scripts/verify-crypto-sessions.mjs"];
  console.log(JSON.stringify({ status: "verified-p4-transactions-offline", branch: "codex/okx-crypto-training", dataManifestSHA256: baseline.dataManifestSHA256,
    baselineP3bSHA256: cryptoHash(readFileSync(baselineFile)), codeSHA256: Object.fromEntries(files.map((f) => [f, cryptoHash(readFileSync(resolve(root, f)))])),
    snapshotDocuments, sessionsInTemporaryDatabase: sessions, temporaryDatabaseBytes: statSync(path).size,
    productionLedgerTouched: false, temporaryDatabaseRemovedOnExit: true, results }, null, 2));
} finally { database?.close(); rmSync(folder, { recursive: true, force: true }); }
