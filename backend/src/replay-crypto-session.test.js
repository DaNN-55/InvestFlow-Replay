import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Decimal from "decimal.js";
import request from "supertest";
import { createDatabase } from "./db.js";
import { createReplayLifecycleStore } from "./replay-lifecycle-store.js";
import { createCryptoReplayService } from "./replay-crypto-session.js";
import { createApp } from "./app.js";
import { cryptoExposure } from "./replay-crypto-pool.js";
import { createReplayInteraction } from "./replay-interaction.js";
const D = Decimal.clone({ precision: 96 });
const rules = JSON.parse(readFileSync(new URL("../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json", import.meta.url)));
const START = Date.parse("2024-01-01T00:00:00+08:00"), M = 60000;
function source({ zeroEnd = false, gap = false } = {}) {
  let disabled = false, calls = 0;
  return { disable() { disabled = true; }, get calls() { return calls; }, load(instrumentId) {
    calls++; if (disabled) throw new Error("global source disabled");
    const price = instrumentId.startsWith("BTC") ? "50000" : "3000";
    const window = { backgroundStartMs: START - 60 * M, replayStartMs: START, replayEndMs: START + 180 * M, executionEndMs: START + 181 * M };
    const bars = Array.from({ length: 241 }, (_, i) => ({ ts: window.backgroundStartMs + i * M, open: price, high: price, low: price, close: price, sourceConfirm: "1" }));
    const last = bars.map((b) => ({ ...b, volumeContracts: "100000", volumeBase: "1000", volumeQuote: "50000000" }));
    const mark = structuredClone(bars); if (zeroEnd) last[240].volumeContracts = "0";
    if (gap) Object.assign(mark[61], { open: "30000", high: "30000", low: "30000", close: "30000" });
    return { rules: structuredClone(rules), dataVersion: "test-20240101-private", dataManifestSHA256: "a".repeat(64), scenario: { instrumentId, window, last, mark,
      fundingAudit: { cadenceMs: 60 * M, maxSourceOffsetMs: 2000 }, funding: Array.from({ length: 7 }, (_, i) => ({ ts: START + (i - 2) * 60 * M, settledRate: ".0001" })) } };
  } };
}
function context(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), "crypto-p4-")), path = join(folder, "replay.sqlite"), snapshotSource = options.source ?? source(options);
  let database, service;
  const open = () => { database = createDatabase(path); service = createCryptoReplayService({ store: createReplayLifecycleStore(database), snapshotSource, now: () => "2026-10-20T12:00:00.000Z" }); };
  open(); t.after(() => { database.close(); rmSync(folder, { recursive: true, force: true }); });
  return { path, snapshotSource, get database() { return database; }, get service() { return service; }, reopen() { database.close(); open(); } };
}
const make = (c, id = "create", extra = {}) => c.service.create({ market: "crypto-perpetual", actionId: id, instrumentId: "BTC-USDT-SWAP", ...extra });
function mutate(c, s, actionId, command) { return c.service.command(s.id, { actionId, expectedRevision: s.revision, command }); }
function advance(c, s, name, minutes = 1) { return c.service.advance(s.id, { actionId: name, expectedRevision: s.revision, minutes }); }
function openPosition(c, id = "create", extra = {}) {
  let s = make(c, id, extra).session;
  s = mutate(c, s, "order", { type: "market-open", side: "long", contracts: "10" }).session;
  return advance(c, s, "fill").session;
}
function go(c, s, target, prefix = "go") { let i = 0; while (s.elapsedMinutes < target) { const left = target - s.elapsedMinutes; s = advance(c, s, `${prefix}-${i++}`, left >= 15 ? 15 : left >= 5 ? 5 : 1).session; } return s; }
function ledgerCheck(c, s) {
  const rows = c.service.audit(s.id, "ledger", { limit: 200 }).items;
  const sum = (key) => rows.reduce((n, r) => n.plus(r[key]), new D(0)).toFixed(8);
  assert.equal(sum("availableDelta"), s.account.availableBalance); assert.equal(sum("reservedDelta"), s.reservedBalance);
  assert.equal(sum("marginDelta"), s.account.position?.marginBalance ?? "0.00000000");
  for (const [key, total] of [["feesDelta", "tradingFees"], ["fundingDelta", "fundingPayments"], ["realizedDelta", "realizedPricePnl"], ["liquidationDelta", "liquidationAggregatePnl"]]) assert.equal(sum(key), s.totals[total]);
  return rows;
}
const code = (expected) => (e) => e.code === expected;

test("creation is atomic/idempotent and stores decimal TEXT, one frozen document, and no private source metadata in public state", (t) => {
  const c = context(t), first = make(c); assert.equal(first.created, true); assert.equal(first.session.revision, 0);
  const retry = make(c); assert.equal(retry.idempotent, true); assert.deepEqual(retry.session, first.session); assert.equal(c.snapshotSource.calls, 1);
  assert.throws(() => make(c, "create", { startingCash: "20000" }), code("REPLAY_ACTION_CONFLICT"));
  const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_crypto_snapshots").get().n, 1);
  assert.equal(raw.prepare("SELECT typeof(available_delta) t FROM replay_account_entries").get().t, "text");
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_sessions").get().n, 1);
  assert.doesNotMatch(JSON.stringify(first), /test-20240101|1704038400000|backgroundStartMs|snapshot_json/); ledgerCheck(c, first.session);
});

test("open/advance retries return the original committed cursor, never charge again; changed action and stale revision reject", (t) => {
  const c = context(t); const initial = make(c).session;
  const body = { actionId: "submit", expectedRevision: 0, command: { type: "market-open", side: "long", contracts: ".03" } };
  const order = c.service.command(initial.id, body); const filled = advance(c, order.session, "advance");
  assert.equal(filled.session.account.position.contracts, "0.03"); assert.equal(filled.session.totals.tradingFees, "0.00750150");
  const retried = c.service.command(initial.id, body); assert.equal(retried.idempotent, true); assert.deepEqual(retried.session, order.session);
  const duplicate = advance(c, order.session, "advance"); assert.equal(duplicate.idempotent, true); assert.deepEqual(duplicate.session, filled.session);
  assert.throws(() => c.service.command(initial.id, { ...body, command: { ...body.command, contracts: ".04" } }), code("REPLAY_ACTION_CONFLICT"));
  assert.throws(() => mutate(c, initial, "old", { type: "market-open", side: "long", contracts: "1" }), code("REPLAY_REVISION_CONFLICT"));
  ledgerCheck(c, filled.session);
});

test("funding and topup persist once; ledger buckets reconcile exactly through finish", (t) => {
  const c = context(t); let s = openPosition(c);
  const before = s.summary.accountEquity; const topup = mutate(c, s, "topup", { type: "add-margin", amount: "500" });
  assert.equal(topup.session.summary.accountEquity, before); assert.equal(mutate(c, s, "topup", { type: "add-margin", amount: "500" }).idempotent, true);
  s = go(c, topup.session, 60); assert.equal(s.totals.fundingPayments, "0.50000000"); ledgerCheck(c, s);
  const finish = c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision });
  assert.equal(finish.session.status, "completed"); assert.equal(finish.session.account.position, null); ledgerCheck(c, finish.session);
  assert.deepEqual(c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision }).session, finish.session);
});

test("SQL failure after state/trace changes rolls the entire action back and can be retried", (t) => {
  const c = context(t); let s = make(c).session; s = mutate(c, s, "submit", { type: "market-open", side: "long", contracts: "10" }).session;
  const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER test_fail BEFORE INSERT ON replay_account_entries WHEN NEW.action_id = 'explode' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  assert.throws(() => advance(c, s, "explode"), /test write failure/);
  assert.deepEqual(c.service.get(s.id).session, s);
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_execution_traces").get().n, 1);
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_events WHERE action_id = 'explode'").get().n, 0);
  raw.exec("DROP TRIGGER test_fail"); const success = advance(c, s, "explode"); assert.equal(success.session.revision, s.revision + 1); ledgerCheck(c, success.session);
});

test("failed creation/retrain does not consume attempt numbers or leave frozen/session rows", (t) => {
  const c = context(t), raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fail_create BEFORE INSERT ON replay_account_entries WHEN NEW.action_id = 'bad-create' BEGIN SELECT RAISE(ABORT, 'create failure'); END");
  assert.throws(() => make(c, "bad-create"), /create failure/);
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_sessions").get().n, 0); assert.equal(raw.prepare("SELECT count(*) n FROM replay_crypto_snapshots").get().n, 0);
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_scenario_attempt_counters").get().n, 0);
  raw.exec("DROP TRIGGER fail_create"); const s = make(c, "bad-create").session; assert.equal(s.attemptInfo.attemptNumber, 1);
});

test("restart recovers active partial GTC/protection, totals and cursor without using current source", (t) => {
  const src = source(), originalLoad = src.load.bind(src); src.load = (id) => { const data = originalLoad(id); data.scenario.last[60].volumeContracts = "4"; return data; };
  const c = context(t, { source: src }); let s = make(c).session;
  s = mutate(c, s, "protected", { type: "limit-open", side: "long", contracts: "10", limitPrice: "51000", protection: { stopLoss: { price: "45000" } } }).session;
  s = advance(c, s, "partial").session; assert.equal(s.account.position.contracts, "4"); assert.equal(s.orders[0].remainingContracts, "6");
  src.disable(); c.reopen(); assert.deepEqual(c.service.get(s.id).session, s);
  const next = advance(c, s, "continue").session; assert.equal(next.account.position.contracts, "10"); assert.equal(next.protection.contracts, "10"); ledgerCheck(c, next);
});

test("reveal gating and retrain freeze versions/config/data; duplicate child creation returns initial child even after it progressed", (t) => {
  const c = context(t); let s = make(c, "config", { startingCash: "12345.12345678", leverage: "7", slippageBps: 10 }).session;
  assert.throws(() => c.service.reveal(s.id, { actionId: "no-reveal", expectedRevision: s.revision }), code("REPLAY_ACTION_CONFLICT"));
  s = c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision }).session;
  assert.throws(() => c.service.retrain(s.id, { actionId: "no-retrain", expectedRevision: s.revision }), code("REPLAY_ACTION_CONFLICT"));
  s = c.service.saveBlindReview(s.id, { actionId: "blind", expectedRevision: s.revision, review: { thesis: "不交易", tradePlan: "等待" } }).session;
  s = c.service.reveal(s.id, { actionId: "reveal", expectedRevision: s.revision }).session; const original = structuredClone(s);
  c.snapshotSource.disable(); const body = { actionId: "retrain", expectedRevision: s.revision };
  const child = c.service.retrain(s.id, body).session; assert.notEqual(child.id, s.id); assert.equal(child.account.availableBalance, "12345.12345678");
  assert.equal(child.frozenRules.slippageBps, "10"); assert.equal(child.attemptInfo.kind, "retrain"); assert.equal(child.attemptInfo.countsTowardFirstScore, false);
  advance(c, child, "child-advance"); assert.deepEqual(c.service.retrain(s.id, body).session, child); assert.deepEqual(c.service.get(s.id).session, original);
  const internalSource = c.database.getReplaySession(s.id), internalChild = c.database.getReplaySession(child.id);
  assert.deepEqual(internalChild.snapshot, internalSource.snapshot); assert.equal(internalChild.account.leverage, "7");
  assert.equal(child.blindReview, null); assert.equal(child.elapsedMinutes, 0); assert.ok(c.service.market(child.id, { elapsedMinutes: "0", timeframeMinutes: "1440" }));
});

test("service cursor rejects future reads, client state injection, skipped advances and pre-reveal data identity", (t) => {
  const c = context(t); const s = make(c).session;
  assert.throws(() => c.service.market(s.id, { elapsedMinutes: "1" }), code("REPLAY_CURSOR_FORBIDDEN"));
  assert.throws(() => c.service.get(s.id, { elapsedMinutes: "1" }), code("INVALID_REQUEST"));
  for (const extra of [{ state: {} }, { elapsedMinutes: 100 }, { snapshot: {} }]) assert.throws(() => c.service.command(s.id, { actionId: "inject", expectedRevision: 0, command: { type: "advance", minutes: 1 }, ...extra }), code("INVALID_REQUEST"));
  assert.throws(() => advance(c, s, "skip", 1000), code("INVALID_REQUEST"));
  assert.throws(() => mutate(c, s, "ignore-pause", { type: "advance", minutes: 15, stopOnEvent: false }), code("INVALID_REQUEST"));
  assert.throws(() => c.service.audit(s.id, "traces", { after: "1" }), code("REPLAY_CURSOR_FORBIDDEN"));
  const view = c.service.market(s.id, { timeframeMinutes: "1440" }); assert.equal(view.elapsedMinutes, 0);
  assert.doesNotMatch(JSON.stringify(view), /2024-01-01|1704038400000|test-20240101|sourceUrl/);
});

test("end-blocked stays unclosed and cannot be revealed or retrained", (t) => {
  const c = context(t, { zeroEnd: true }); let s = openPosition(c); s = go(c, s, 181);
  assert.equal(s.status, "end-blocked"); assert.ok(s.account.position); ledgerCheck(c, s); c.reopen(); assert.equal(c.service.get(s.id).session.status, "end-blocked");
  assert.throws(() => c.service.reveal(s.id, { actionId: "reveal", expectedRevision: s.revision }), code("REPLAY_ACTION_CONFLICT"));
});

test("takeover removes orders/protection and posts only the aggregate once across retry/restart", (t) => {
  const c = context(t, { gap: true }); let s = make(c).session;
  s = mutate(c, s, "open", { type: "market-open", side: "long", contracts: "10", protection: { stopLoss: { price: "40000" } } }).session;
  s = advance(c, s, "fill").session;
  s = mutate(c, s, "pending", { type: "limit-open", side: "long", contracts: "1", limitPrice: "10000" }).session;
  const before = s; const liquidated = advance(c, before, "risk").session;
  assert.equal(liquidated.account.position, null); assert.equal(liquidated.protection, null); assert.equal(liquidated.orders.length, 0);
  assert.equal(liquidated.totals.tradingFees, before.totals.tradingFees);
  assert.deepEqual(advance(c, before, "risk").session, liquidated); c.reopen(); assert.deepEqual(c.service.get(s.id).session, liquidated); ledgerCheck(c, liquidated);
});

test("two database writers enforce revisions and share idempotency without duplicate money", (t) => {
  const c = context(t); const s = make(c).session;
  const other = createDatabase(c.path); t.after(() => other.close());
  const service = createCryptoReplayService({ store: createReplayLifecycleStore(other), snapshotSource: c.snapshotSource });
  const request = { actionId: "same", expectedRevision: s.revision, command: { type: "market-open", side: "long", contracts: "10" } };
  const first = c.service.command(s.id, request); assert.equal(service.command(s.id, request).idempotent, true);
  assert.throws(() => service.command(s.id, { ...request, actionId: "lost-race" }), code("REPLAY_REVISION_CONFLICT")); ledgerCheck(c, first.session);
});

test("frozen document/session contracts are immutable and accidental state corruption fails after restart", (t) => {
  const c = context(t); const s = make(c).session; const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  assert.throws(() => raw.prepare("UPDATE replay_crypto_snapshots SET document_json = '{}'").run(), /immutable/);
  assert.throws(() => raw.prepare("UPDATE replay_sessions SET snapshot_json = '{}' WHERE id = ?").run(s.id), /immutable/);
  raw.exec("DROP TRIGGER replay_crypto_account_hash_required"); const state = c.database.getReplaySession(s.id).account; state.elapsedMinutes = 99;
  raw.prepare("UPDATE replay_sessions SET account_json = ? WHERE id = ?").run(JSON.stringify(state), s.id);
  c.reopen(); assert.throws(() => c.service.get(s.id), code("REPLAY_SNAPSHOT_CORRUPT"));
});

test("HTTP routes create/retry/dispatch, enforce visible cursor, and keep old stock routes separate", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "crypto-http-")); const app = createApp({ dbPath: join(folder, "db.sqlite"), cryptoSnapshotSource: source() });
  t.after(() => { app.dispose(); rmSync(folder, { recursive: true, force: true }); }); const http = request(app), base = "/api/quant/replay/sessions";
  const pool = await http.get("/api/quant/replay/crypto-pool").expect(200); assert.equal(pool.body.mode, "fixed-source");
  await http.get("/api/quant/replay/crypto-pool?candidate=20240101").expect(400);
  const body = { market: "crypto-perpetual", actionId: "http", instrumentId: "ETH-USDT-SWAP" };
  const created = await http.post(base).send(body).expect(201); const s = created.body.session; await http.post(base).send(body).expect(200);
  assert.equal(s.instrumentId, "ETH-USDT-SWAP"); await http.get(`${base}/${s.id}/market?elapsedMinutes=1`).expect(409);
  const ordered = await http.post(`${base}/${s.id}/orders`).send({ actionId: "order", expectedRevision: 0, command: { type: "market-open", side: "short", contracts: ".1" } }).expect(200);
  const filled = await http.post(`${base}/${s.id}/advance`).send({ actionId: "advance", expectedRevision: ordered.body.session.revision, minutes: 15 }).expect(200);
  assert.equal(filled.body.session.elapsedMinutes, 1); await http.get(`${base}/${s.id}/market?elapsedMinutes=2`).expect(409);
  const stocks = await http.get(base).expect(200); assert.equal(stocks.body.total, 0);
  const crypto = await http.get(`${base}?market=crypto-perpetual`).expect(200); assert.equal(crypto.body.total, 1);
  await http.post(`${base}/${s.id}/actions`).send({ actionId: "bad", expectedRevision: 2, command: { type: "advance", minutes: 1 }, state: {} }).expect(400);
  const ledger = await http.get(`${base}/${s.id}/ledger`).expect(200); assert.equal(ledger.body.items.length, 3);
  await http.post(`${base}/${s.id}/reviews/post`).send({}).expect(400);
  await http.post(`${base}/${s.id}/reviews/post`).send({ actionId: "too-early-post", expectedRevision: filled.body.session.revision, review: { observation: "观察", executionLesson: "偏差", nextAttempt: "改进" } }).expect(409);
});

test("failed retrain rolls attempt counter back; successful child reserves its creation actionId", (t) => {
  const c = context(t); let s = make(c).session;
  s = c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: "blind", expectedRevision: s.revision, review: { thesis: "等待", tradePlan: "不交易" } }).session;
  s = c.service.reveal(s.id, { actionId: "reveal", expectedRevision: s.revision }).session;
  const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fail_child BEFORE INSERT ON replay_account_entries WHEN NEW.action_id = 'child' BEGIN SELECT RAISE(ABORT, 'child failure'); END");
  const body = { actionId: "child", expectedRevision: s.revision };
  assert.throws(() => c.service.retrain(s.id, body), /child failure/);
  assert.equal(raw.prepare("SELECT count(*) n FROM replay_sessions").get().n, 1);
  assert.equal(raw.prepare("SELECT last_attempt_number n FROM replay_scenario_attempt_counters").get().n, 1);
  raw.exec("DROP TRIGGER fail_child"); const child = c.service.retrain(s.id, body).session;
  assert.equal(child.attemptInfo.attemptNumber, 2);
  assert.throws(() => mutate(c, child, "child", { type: "advance", minutes: 1 }), code("REPLAY_ACTION_CONFLICT"));
});

test("missing/corrupt frozen document and unsupported execution version fail closed without reinterpreting account", (t) => {
  const c = context(t); const s = make(c).session, raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.exec("DROP TRIGGER replay_crypto_contract_immutable");
  raw.prepare("UPDATE replay_sessions SET execution_model_version = 'unknown-executor' WHERE id = ?").run(s.id);
  assert.throws(() => c.service.get(s.id), code("REPLAY_VERSION_UNSUPPORTED"));
  raw.prepare("UPDATE replay_sessions SET execution_model_version = 'okx-orders-minute-teaching-v1' WHERE id = ?").run(s.id);
  raw.exec("DROP TRIGGER replay_crypto_snapshots_no_update"); raw.exec("UPDATE replay_crypto_snapshots SET document_json = '{}'");
  c.reopen(); assert.throws(() => c.service.get(s.id), code("REPLAY_SNAPSHOT_CORRUPT"));
  assert.equal(raw.prepare("SELECT revision FROM replay_sessions WHERE id = ?").get(s.id).revision, 0);
});

test("creation retry after later blind review/reveal returns its initial cursor and does not expose later notes", (t) => {
  const c = context(t), original = make(c); let s = original.session;
  s = c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: "blind", expectedRevision: s.revision, review: { thesis: "later secret", tradePlan: "等待" } }).session;
  s = c.service.reveal(s.id, { actionId: "reveal", expectedRevision: s.revision }).session;
  assert.equal(c.service.market(s.id, { elapsedMinutes: "181" }).elapsedMinutes, 181);
  const retry = make(c); assert.deepEqual(retry.session, original.session); assert.doesNotMatch(JSON.stringify(retry), /later secret|test-20240101/);
});

test("legacy A-share session persists normally; saved newer stock execution versions remain readable but never downgrade on mutation", (t) => {
  const c = context(t), bars = Array.from({ length: 270 }, (_, i) => ({ sequence: i + 1, tradeDate: `2024-${String(i).padStart(4, '0')}`, open: 10, high: 11, low: 9, close: 10, volume: 10000, amount: 100000 }));
  const stock = c.database.createReplaySession({ id: "old-stock", executionModelVersion: "legacy-next-open", sourceDataVersion: "old", gameLength: 20, observationBars: 250, revealedFutureBars: 0,
    status: "active", revision: 0, snapshot: { tsCode: "600000.SH", name: "legacy", interval: "1d", observationBars: 250, gameLength: 20, bars },
    account: { initialCapital: 100000, cash: 100000, positionQuantity: 0, availableQuantity: 0, lockedQuantity: 0, averageCost: 0, realizedPnl: 0, totalFees: 0 },
    costConfig: { commissionRate: .0003, minCommission: 5, stampTaxRate: .0005, transferFeeRate: .00001, slippageBps: 5 }, createdAt: "2026-10-20", updatedAt: "2026-10-20" });
  assert.equal(stock.market, "ashare"); assert.equal(stock.executionModelVersion, "legacy-next-open");
  const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.prepare("UPDATE replay_sessions SET execution_model_version = 'future-bar-orders-v999' WHERE id = ?").run(stock.id);
  c.reopen(); const preserved = c.database.getReplaySession(stock.id); assert.equal(preserved.executionModelVersion, "future-bar-orders-v999"); assert.deepEqual(preserved.account, stock.account);
  assert.throws(() => c.database.advanceReplaySession({ sessionId: stock.id, actionId: "never-downgrade", expectedRevision: 0, requestPayload: {}, updatedAt: "2026-10-20" }), code("REPLAY_VERSION_UNSUPPORTED"));
  assert.deepEqual(c.database.getReplaySession(stock.id).account, stock.account);
  const interaction = createReplayInteraction({ store: createReplayLifecycleStore(c.database), scenarioSource: {} });
  assert.throws(() => interaction.get(stock.id), code("REPLAY_VERSION_UNSUPPORTED"));
});


test("P5 manual plans are persisted, never place orders, and survive restart; automatic protection remains an execution fact", (t) => {
  const c = context(t); let s = openPosition(c);
  const request = { actionId: "plan", expectedRevision: s.revision, command: { type: "set-plan", mode: "manual", manualExitPrice: "49900", reason: "手动判断" } };
  const before = structuredClone(s.account); s = c.service.command(s.id, request).session;
  assert.deepEqual(s.account, before); assert.equal(s.orders.length, 0); assert.equal(s.protection, null); assert.equal(s.trainingJournal.plan.manualExitPrice, "49900");
  c.reopen(); assert.deepEqual(c.service.get(s.id).session, s); assert.deepEqual(c.service.command(s.id, request).session, s);
  s = mutate(c, s, "protect", { type: "set-protection", stopLoss: { price: "49000", reference: "last" } }).session;
  assert.equal(s.protection.stopLoss.price, "49000"); assert.equal(s.trainingJournal.plan.mode, "manual");
  s = mutate(c, s, "unprotect", { type: "cancel-protection" }).session;
  assert.equal(s.protection, null); assert.equal(s.trainingJournal.plan.manualExitPrice, "49900"); ledgerCheck(c, s);
});

test("P5 journal and decision intent roll back with ledger failures, and retry preserves the original journal", (t) => {
  const c = context(t); const s = make(c).session;
  const raw = new DatabaseSync(c.path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fail_p5_ledger BEFORE INSERT ON replay_account_entries WHEN NEW.action_id='plan' BEGIN SELECT RAISE(ABORT, 'intentional P5 failure'); END");
  const body = { actionId: "plan", expectedRevision: 0, command: { type: "set-plan", mode: "manual", manualExitPrice: "40000", reason: "等待手动退出" } };
  assert.throws(() => c.service.command(s.id, body), /intentional P5 failure/); assert.deepEqual(c.service.get(s.id).session, s);
  raw.exec("DROP TRIGGER fail_p5_ledger"); const planned = c.service.command(s.id, body).session;
  const order = c.service.command(s.id, { actionId: "order-note", expectedRevision: planned.revision, command: { type: "market-open", side: "long", contracts: "1" }, note: "趋势验证" }).session;
  assert.equal(order.trainingJournal.decisions.at(-1).note, "趋势验证"); assert.equal(order.trainingJournal.decisions.at(-1).plan.manualExitPrice, "40000");
  assert.deepEqual(c.service.command(s.id, body).session, planned); assert.equal(c.service.get(s.id).session.trainingJournal.decisions.length, 2);
});

test("P5 post review is reveal gated, immutable, idempotent and present in history; retraining starts an independent journal", (t) => {
  const c = context(t); let s = make(c).session;
  const review = { observation: "原判断偏差", executionLesson: "未交易", nextAttempt: "耐心等待" };
  assert.throws(() => c.service.savePostReview(s.id, { actionId: "post", expectedRevision: 0, review }), code("REPLAY_ACTION_CONFLICT"));
  s = c.service.finish(s.id, { actionId: "finish", expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: "blind", expectedRevision: s.revision, review: { thesis: "震荡", tradePlan: "不交易" } }).session;
  s = c.service.reveal(s.id, { actionId: "reveal", expectedRevision: s.revision }).session;
  const body = { actionId: "post", expectedRevision: s.revision, review };
  s = c.service.savePostReview(s.id, body).session; assert.deepEqual(s.trainingJournal.postReview, review);
  assert.deepEqual(c.service.savePostReview(s.id, body).session, s);
  assert.throws(() => c.service.savePostReview(s.id, { ...body, actionId: "replace-post", expectedRevision: s.revision }), code("REPLAY_ACTION_CONFLICT"));
  const history = c.database.listReplaySessions({ market: "crypto-perpetual", state: "all", attemptKind: "all", keyword: "", page: 1, pageSize: 20 }); assert.equal(history.items[0].reviewState, "reviewed");
  c.reopen(); assert.deepEqual(c.service.get(s.id).session, s);
  let child = c.service.retrain(s.id, { actionId: "child", expectedRevision: s.revision }).session;
  assert.equal(child.trainingJournal.postReview, null); assert.equal(child.trainingJournal.plan.mode, "none"); assert.equal(child.firstAttempt, undefined);
  child = c.service.finish(child.id, { actionId: "finish-child", expectedRevision: 0 }).session;
  child = c.service.saveBlindReview(child.id, { actionId: "blind-child", expectedRevision: child.revision, review: { thesis: "再观察", tradePlan: "再等待" } }).session;
  child = c.service.reveal(child.id, { actionId: "reveal-child", expectedRevision: child.revision }).session;
  assert.equal(child.firstAttempt.id, s.id); assert.deepEqual(child.firstAttempt.summary, s.summary);
  assert.deepEqual(c.service.get(s.id).session, s);
});

test("P5 compact chart responses still validate server cursor and preserve partial candle prefix", (t) => {
  const c = context(t); const s = advance(c, make(c).session, "go", 1).session;
  const full = c.service.market(s.id, { timeframeMinutes: 60 }), clipped = c.service.market(s.id, { timeframeMinutes: 60, limit: 1 });
  assert.deepEqual(clipped.candles.last, full.candles.last.slice(-1)); assert.equal(clipped.candles.last[0].knownThroughMinute, 1);
  assert.throws(() => c.service.market(s.id, { elapsedMinutes: 2, limit: 1 }), code("REPLAY_CURSOR_FORBIDDEN"));
  assert.throws(() => c.service.market(s.id, { limit: 2001 }), code("INVALID_REQUEST"));
});

test("P5 first-attempt comparison follows scenario identity across a chain and a separately created replay", (t) => {
  const c = context(t);
  function reveal(s, prefix) { s = c.service.finish(s.id, { actionId: `${prefix}-finish`, expectedRevision: s.revision }).session; s = c.service.saveBlindReview(s.id, { actionId: `${prefix}-blind`, expectedRevision: s.revision, review: { thesis: '保留首次判断', tradePlan: '不交易' } }).session; return c.service.reveal(s.id, { actionId: `${prefix}-reveal`, expectedRevision: s.revision }).session; }
  const first = reveal(make(c, 'first').session, 'first');
  const second = reveal(c.service.retrain(first.id, { actionId: 'second', expectedRevision: first.revision }).session, 'second');
  const third = reveal(c.service.retrain(second.id, { actionId: 'third', expectedRevision: second.revision }).session, 'third');
  assert.equal(third.firstAttempt.id, first.id);
  const fresh = reveal(make(c, 'fresh-same-window').session, 'fresh'); assert.equal(fresh.attemptInfo.kind, 'retrain'); assert.equal(fresh.firstAttempt.id, first.id);
});

test("P5 failure while saving post review rolls back both review state and journal, so the exact request can retry", (t) => {
  const c = context(t); let s = make(c).session;
  s = c.service.finish(s.id, { actionId: 'finish', expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: 'blind', expectedRevision: s.revision, review: { thesis: '等待', tradePlan: '不交易' } }).session;
  s = c.service.reveal(s.id, { actionId: 'reveal', expectedRevision: s.revision }).session;
  const raw = new DatabaseSync(c.path); t.after(() => raw.close()); raw.exec("CREATE TRIGGER fail_p5_post BEFORE INSERT ON replay_account_entries WHEN NEW.action_id='post' BEGIN SELECT RAISE(ABORT, 'post rollback'); END");
  const body = { actionId: 'post', expectedRevision: s.revision, review: { observation: '观察', executionLesson: '偏差', nextAttempt: '行动' } };
  assert.throws(() => c.service.savePostReview(s.id, body), /post rollback/); assert.deepEqual(c.service.get(s.id).session, s); assert.equal(c.database.getReplaySession(s.id).review.postReview, null);
  raw.exec('DROP TRIGGER fail_p5_post'); const saved = c.service.savePostReview(s.id, body).session; assert.deepEqual(saved.trainingJournal.postReview, body.review); assert.deepEqual(c.database.getReplaySession(s.id).review.postReview, body.review);
});


function poolFixtureSource(base = source(), shift = 0) {
  return { load(inst) { const value = base.load(inst); if (shift) { for (const key of Object.keys(value.scenario.window)) value.scenario.window[key] += shift; for (const kind of ['last','mark','funding']) for (const row of value.scenario[kind]) row.ts += shift; }
    return { ...value, exposure: cryptoExposure(inst, value.scenario.window), poolVersion: 'pool-test-v1' }; } };
}
test('P6 new pooled scenes reserve exposure atomically across contracts, deletion, and source revisions', t => {
  const rawSource = source(), pooled = poolFixtureSource(rawSource), c = context(t, { source: pooled });
  const first = make(c, 'pool-first').session; const internal = c.database.getReplaySession(first.id);
  assert.equal(internal.scenarioFingerprintVersion, 'okx-btc-eth-exposure-v1'); assert.equal(first.attemptInfo.countsTowardFirstScore, true);
  assert.throws(() => make(c, 'same-window'), code('REPLAY_EXPOSURE_CONFLICT'));
  assert.throws(() => make(c, 'correlated-eth', { instrumentId: 'ETH-USDT-SWAP' }), code('REPLAY_EXPOSURE_CONFLICT'));
  c.database.deleteReplaySession(first.id, '2026-10-21T00:00:00Z'); c.reopen();
  assert.equal(c.database.getReplayCryptoExposureUsage()[0].deleted, true); assert.throws(() => make(c, 'after-delete'), code('REPLAY_EXPOSURE_CONFLICT'));
  const revised = { load(inst) { return { ...pooled.load(inst), dataVersion: 'changed-pool-data-version' }; } };
  const revisionService = createCryptoReplayService({ store: createReplayLifecycleStore(c.database), snapshotSource: revised });
  assert.throws(() => revisionService.create({ market:'crypto-perpetual', actionId:'revision', instrumentId:'BTC-USDT-SWAP' }), code('REPLAY_EXPOSURE_CONFLICT'));
});
test('P6 old descriptor identity survives restart and its original window blocks new or related first attempts', t => {
  const c = context(t), first = make(c).session, original = c.database.getReplaySession(first.id).scenarioFingerprint;
  c.reopen(); assert.equal(c.database.getReplaySession(first.id).scenarioFingerprint, original);
  const service = createCryptoReplayService({ store:createReplayLifecycleStore(c.database),snapshotSource:poolFixtureSource() });
  assert.throws(() => service.create({ market:'crypto-perpetual',actionId:'new-pool-over-legacy',instrumentId:'ETH-USDT-SWAP' }),code('REPLAY_EXPOSURE_CONFLICT'));
  assert.deepEqual(c.service.get(first.id).session, first);
});
test('P6 an unseen replay cannot come from the already-visible background of a later scene', t => {
  const c = context(t,{ source:poolFixtureSource(source(),180*M) }); make(c,'later-first');
  const service=createCryptoReplayService({store:createReplayLifecycleStore(c.database),snapshotSource:poolFixtureSource()});
  assert.throws(()=>service.create({market:'crypto-perpetual',actionId:'earlier-background',instrumentId:'BTC-USDT-SWAP'}),code('REPLAY_EXPOSURE_CONFLICT'));
});
test('P6 stale concurrent selectors cannot both create a first, while original creation and frozen retrain remain stable', t => {
  const rawSource=source(),c=context(t,{source:poolFixtureSource(rawSource)}),other=createDatabase(c.path);t.after(()=>other.close());
  const rival=createCryptoReplayService({store:createReplayLifecycleStore(other),snapshotSource:poolFixtureSource()});
  let s=make(c,'winner').session;assert.throws(()=>rival.create({market:'crypto-perpetual',actionId:'stale-selector',instrumentId:'BTC-USDT-SWAP'}),code('REPLAY_EXPOSURE_CONFLICT'));
  const originalCreate=structuredClone(s);rawSource.disable();assert.deepEqual(make(c,'winner').session,originalCreate);
  s=c.service.finish(s.id,{actionId:'finish',expectedRevision:s.revision}).session;
  s=c.service.saveBlindReview(s.id,{actionId:'blind',expectedRevision:s.revision,review:{thesis:'冻结',tradePlan:'不交易'}}).session;
  s=c.service.reveal(s.id,{actionId:'reveal',expectedRevision:s.revision}).session;
  c.reopen();const child=c.service.retrain(s.id,{actionId:'retrain',expectedRevision:s.revision}).session;
  assert.equal(child.attemptInfo.kind,'retrain');assert.equal(child.attemptInfo.countsTowardFirstScore,false);assert.equal(child.executionModelVersion,s.executionModelVersion);
  assert.deepEqual(c.database.getReplaySession(child.id).snapshot,c.database.getReplaySession(s.id).snapshot);assert.deepEqual(c.service.get(s.id).session,s);
});

for (const instrumentId of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) test(`F3 deleted first remains a frozen comparison only after child reveal: ${instrumentId}`, t => {
  const c = context(t);
  function reveal(s, prefix) {
    s = c.service.finish(s.id, { actionId: `${prefix}-finish`, expectedRevision: s.revision }).session;
    s = c.service.saveBlindReview(s.id, { actionId: `${prefix}-blind`, expectedRevision: s.revision, review: { thesis: '保留首次判断', tradePlan: '不交易' } }).session;
    return c.service.reveal(s.id, { actionId: `${prefix}-reveal`, expectedRevision: s.revision }).session;
  }
  const first = reveal(make(c, 'deleted-first', { instrumentId }).session, 'first');
  const child = reveal(c.service.retrain(first.id, { actionId: 'child', expectedRevision: first.revision }).session, 'child');
  const active = c.service.retrain(first.id, { actionId: 'active-child', expectedRevision: first.revision }).session;
  const expected = structuredClone(child.firstAttempt), descriptor = c.database.getReplaySession(child.id).snapshot;
  c.database.deleteReplaySession(first.id, '2026-10-21T00:01:00Z'); c.snapshotSource.disable(); c.reopen();
  assert.deepEqual(c.service.get(child.id).session.firstAttempt, expected);
  assert.deepEqual(c.service.get(child.id).session.summary, child.summary);
  assert.deepEqual(c.database.getReplaySession(child.id).snapshot, descriptor);
  assert.equal(c.service.get(active.id).session.firstAttempt, undefined);
  assert.throws(() => c.service.get(first.id), code('NOT_FOUND'));
  assert.equal(c.database.getReplaySession(first.id), null);
  const history = c.database.listReplaySessions({ market: 'crypto-perpetual', state: 'all', attemptKind: 'all', keyword: '', page: 1, pageSize: 30 });
  assert.ok(history.items.every(s => s.id !== first.id));
  assert.ok(c.database.getReplayCryptoExposureUsage().some(s => s.id === first.id && s.deleted));
});
test('F2 HTTP source rejection explicitly reports no commit; successful retry remains idempotent', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'crypto-source-reject-')), input = source(); let unavailable = true;
  const app = createApp({ dbPath: join(folder, 'db.sqlite'), cryptoSnapshotSource: { load(id) { if (unavailable) throw Object.assign(new Error('行情池文件缺失'), { status: 503, code: 'REPLAY_SNAPSHOT_UNAVAILABLE' }); return input.load(id); } } });
  t.after(() => { app.dispose(); rmSync(folder, { recursive: true, force: true }); });
  const http = request(app), base = '/api/quant/replay/sessions', body = { market: 'crypto-perpetual', actionId: 'source-failure', instrumentId: 'BTC-USDT-SWAP' };
  const failed = await http.post(base).send(body).expect(503);
  assert.equal(failed.body.error.details?.actionOutcome, 'not-committed');
  assert.equal((await http.get(`${base}?market=crypto-perpetual`).expect(200)).body.total, 0);
  unavailable = false; const first = await http.post(base).send(body).expect(201);
  unavailable = true; const retry = await http.post(base).send(body).expect(200);
  assert.equal(retry.body.idempotent, true); assert.deepEqual(retry.body.session, first.body.session);
});

for (const instrumentId of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) test(`F1 frozen pretrade preview is read-only, causal and sizes down: ${instrumentId}`, t => {
  const c = context(t), s = make(c, 'preview', { instrumentId }).session;
  const request = { expectedRevision: s.revision, intent: 'long', orderType: 'market', sizingMode: 'contracts', amount: '10' };
  const q = c.service.preview(s.id, request).preview;
  assert.equal(q.contracts, '10'); assert.equal(q.fee, instrumentId.startsWith('BTC') ? '2.50050000' : '1.50030000');
  assert.equal(q.initialMargin, instrumentId.startsWith('BTC') ? '1000.20000000' : '600.12000000');
  assert.equal(q.revision, 0); assert.deepEqual(c.service.get(s.id).session, s); assert.equal(ledgerCheck(c, s).length, 1);
  const sized = c.service.preview(s.id, { ...request, sizingMode: 'margin', amount: q.initialMargin }).preview;
  assert.equal(sized.contracts, '10');
  const exitPrice = instrumentId.startsWith('BTC') ? '45000' : '2700';
  const budget = c.service.preview(s.id, { ...request, sizingMode: 'risk', amount: '100', exitPrice }).preview;
  assert.ok(new D(budget.estimatedPlanLoss).lte(100)); assert.ok(new D(budget.contracts).gt(0));
  assert.throws(() => c.service.preview(s.id, { ...request, sizingMode: 'risk', amount: '100' }), code('INVALID_REQUEST'));
  assert.throws(() => c.service.preview(s.id, { ...request, amount: '.001' }), /lot|minSz|quantity/i);
  assert.throws(() => c.service.preview(s.id, { ...request, expectedRevision: 1 }), code('REPLAY_REVISION_CONFLICT'));
  assert.throws(() => c.service.analysis(s.id), code('REPLAY_COMPARISON_NOT_READY'));
});
test('F6 derived minute equity and plan comparison reconcile without mutating frozen state', t => {
  const c = context(t); let s = make(c, 'analysis').session;
  s = mutate(c, s, 'plan', { type: 'set-plan', mode: 'manual', manualExitPrice: '45000', reason: '入场计划' }).session;
  s = mutate(c, s, 'open', { type: 'market-open', side: 'long', contracts: '10' }).session; s = advance(c, s, 'fill').session;
  s = mutate(c, s, 'topup', { type: 'add-margin', amount: '500' }).session;
  s = mutate(c, s, 'reduce', { type: 'market-close', contracts: '4' }).session; s = advance(c, s, 'reduce-fill').session;
  s = c.service.finish(s.id, { actionId: 'finish', expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: 'blind', expectedRevision: s.revision, review: { thesis: '核对', tradePlan: '保留' } }).session;
  s = c.service.reveal(s.id, { actionId: 'reveal', expectedRevision: s.revision }).session;
  const before = c.database.getReplaySession(s.id), ledger = ledgerCheck(c, s), a = c.service.analysis(s.id).analysis;
  assert.equal(a.finalEquity, s.summary.accountEquity); assert.equal(a.slippageAttribution, s.totals.slippageAttribution);
  assert.equal(a.returnPercent, new D(s.summary.netPnl).div(s.config.startingCash).times(100).toFixed(8));
  assert.ok(new D(a.maxDrawdownPercent).gt(0)); assert.equal(a.trades.length, 1);
  assert.equal(a.trades[0].actualPricePnl, s.totals.realizedPricePnl); assert.ok(new D(a.trades[0].plannedPricePnl).lt(0));
  assert.equal(a.trades[0].exitKind, 'training-end'); assert.equal(a.sampledThroughMinute, s.elapsedMinutes);
  assert.deepEqual(c.database.getReplaySession(s.id), before); assert.deepEqual(ledgerCheck(c, s), ledger);
  c.snapshotSource.disable(); c.reopen(); assert.deepEqual(c.service.analysis(s.id).analysis, a);
});

test('F1 changing future candles cannot change the current preview', t => {
  const original = source(), altered = { load(id) { const s = original.load(id); for (const kind of ['last', 'mark']) for (const bar of s.scenario[kind]) if (bar.ts >= START) Object.assign(bar, { open: '90000', high: '99999', low: '1', close: '88888' }); return s; } };
  const a = context(t), b = context(t, { source: altered }), first = make(a, 'same-id').session, second = make(b, 'same-id').session;
  const request = { expectedRevision: 0, intent: 'short', orderType: 'limit', sizingMode: 'contracts', amount: '10', limitPrice: '51000' };
  assert.deepEqual(a.service.preview(first.id, request), b.service.preview(second.id, request));
});
test('F6 no-trade and teaching takeover never invent a price loss or profit from waiver', t => {
  for (const gap of [false, true]) {
    const c = context(t, { gap }); let s = make(c, gap ? 'takeover-analysis' : 'no-trade-analysis', { leverage: '100' }).session;
    if (gap) { s = mutate(c, s, 'open', { type: 'market-open', side: 'long', contracts: '10' }).session; s = advance(c, s, 'risk-minute').session; s = advance(c, s, 'gap-minute').session; assert.equal(s.account.position, null); }
    s = c.service.finish(s.id, { actionId: 'finish', expectedRevision: s.revision }).session;
    s = c.service.saveBlindReview(s.id, { actionId: 'blind', expectedRevision: s.revision, review: { thesis: '核对', tradePlan: '核对' } }).session;
    s = c.service.reveal(s.id, { actionId: 'reveal', expectedRevision: s.revision }).session;
    const a = c.service.analysis(s.id).analysis; assert.equal(a.finalEquity, s.summary.accountEquity); assert.equal(a.waiverIsNotTradingProfit, true);
    if (gap) { assert.ok(new D(a.deficitWaiverMemo).gt(0)); assert.equal(a.trades[0].actualPricePnl, null); assert.equal(a.trades[0].comparisonStatus, 'different-settlement-model'); }
    else { assert.equal(a.returnPercent, '0.00000000'); assert.equal(a.maxDrawdownPercent, '0.00000000'); assert.deepEqual(a.trades, []); }
  }
});

test('F1/F6 HTTP readers enforce market, revision and reveal without appending ledger actions', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'crypto-insights-http-')), app = createApp({ dbPath: join(folder, 'db.sqlite'), cryptoSnapshotSource: source() });
  t.after(() => { app.dispose(); rmSync(folder, { recursive: true, force: true }); });
  const http = request(app), base = '/api/quant/replay/sessions';
  let s = (await http.post(base).send({ market: 'crypto-perpetual', actionId: 'readers', instrumentId: 'BTC-USDT-SWAP' }).expect(201)).body.session;
  const body = { expectedRevision: 0, intent: 'short', orderType: 'limit', limitPrice: '51000', sizingMode: 'contracts', amount: '10' };
  await http.post(`${base}/${s.id}/preview`).send(body).expect(200);
  await http.post(`${base}/${s.id}/preview`).send({ ...body, elapsedMinutes: 99 }).expect(400);
  await http.post(`${base}/${s.id}/preview`).send({ ...body, expectedRevision: 1 }).expect(409);
  assert.equal((await http.get(`${base}/${s.id}/analysis`).expect(409)).body.error.code, 'REPLAY_COMPARISON_NOT_READY');
  assert.equal((await http.get(`${base}/${s.id}/ledger`).expect(200)).body.items.length, 1);
  s = (await http.post(`${base}/${s.id}/finish`).send({ actionId: 'finish', expectedRevision: s.revision }).expect(200)).body.session;
  s = (await http.post(`${base}/${s.id}/reviews/blind`).send({ actionId: 'blind', expectedRevision: s.revision, review: { thesis: '不交易', tradePlan: '等待' } }).expect(200)).body.session;
  s = (await http.post(`${base}/${s.id}/reveal`).send({ actionId: 'reveal', expectedRevision: s.revision }).expect(200)).body.session;
  const a = (await http.get(`${base}/${s.id}/analysis`).expect(200)).body;
  assert.equal(a.sessionId, s.id); assert.equal(a.revision, s.revision); assert.equal(a.analysis.returnPercent, '0.00000000');
  await http.get(`${base}/${s.id}/analysis?elapsedMinutes=999`).expect(400);
});

test('F6 take-profit-only addition does not inherit a protective stop that it replaces', t => {
  const c = context(t); let s = make(c, 'replace-stop').session;
  s = mutate(c, s, 'initial', { type: 'market-open', side: 'long', contracts: '10', protection: { stopLoss: { price: '45000', reference: 'mark' } } }).session;
  s = advance(c, s, 'initial-fill').session;
  s = mutate(c, s, 'add', { type: 'market-open', side: 'long', contracts: '2', protection: { takeProfit: { price: '60000', reference: 'last' } } }).session;
  s = advance(c, s, 'add-fill').session; assert.equal(s.protection.stopLoss, null);
  s = c.service.finish(s.id, { actionId: 'finish', expectedRevision: s.revision }).session;
  s = c.service.saveBlindReview(s.id, { actionId: 'blind', expectedRevision: s.revision, review: { thesis: '保留实际保护变更', tradePlan: '核对缺少止损的加仓' } }).session;
  s = c.service.reveal(s.id, { actionId: 'reveal', expectedRevision: s.revision }).session;
  const a = c.service.analysis(s.id).analysis;
  assert.equal(a.trades[0].plannedPricePnl, null); assert.equal(a.trades[0].comparisonStatus, 'missing-entry-plan');
});

test('limit-price amendment persists once, reconciles reserves, rejects stale writes and restores after restart',t=>{
  const c=context(t);let s=make(c).session;
  s=mutate(c,s,'limit',{type:'limit-open',side:'long',contracts:'2',limitPrice:'49000',protection:{stopLoss:{price:'48000',reference:'mark'}}}).session;
  const before=structuredClone(s),body={actionId:'amend',expectedRevision:s.revision,command:{type:'amend-limit',orderId:s.orders[0].id,limitPrice:'49500'}};
  const result=c.service.command(s.id,body);s=result.session;
  assert.equal(s.revision,before.revision+1);assert.equal(s.elapsedMinutes,0);assert.equal(s.account.position,null);
  assert.equal(s.orders[0].limitPrice,'49500');assert.equal(s.orders[0].remainingContracts,'2');
  assert.deepEqual(s.orders[0].attachedProtection,before.orders[0].attachedProtection);ledgerCheck(c,s);
  assert.equal(c.service.command(s.id,body).idempotent,true);
  assert.throws(()=>c.service.command(s.id,{...body,actionId:'stale'}),code('REPLAY_REVISION_CONFLICT'));
  assert.throws(()=>c.service.command(s.id,{actionId:'extra',expectedRevision:s.revision,command:{...body.command,contracts:'5'}}),code('INVALID_REQUEST'));
  c.reopen();assert.deepEqual(c.service.get(s.id).session,s);
  assert.deepEqual(c.service.command(s.id,body).session,s);ledgerCheck(c,s);
  assert.equal(c.service.audit(s.id,'traces',{limit:200}).items.filter(e=>e.type==='order-amended').length,1);
  assert.throws(()=>mutate(c,s,'no-cash',{type:'amend-limit',orderId:s.orders[0].id,limitPrice:'90000000'}));
  assert.deepEqual(c.service.get(s.id).session,s);
  s=mutate(c,s,'crossing-price',{type:'amend-limit',orderId:s.orders[0].id,limitPrice:'50010'}).session;
  assert.equal(s.account.position,null);assert.equal(s.elapsedMinutes,0);
  s=advance(c,s,'amended-fill').session;assert.equal(s.account.position.contracts,'2');
  s=c.service.finish(s.id,{actionId:'amended-finish',expectedRevision:s.revision}).session;
  s=c.service.saveBlindReview(s.id,{actionId:'amended-blind',expectedRevision:s.revision,review:{thesis:'改单复盘',tradePlan:'保留原保护'}}).session;
  s=c.service.reveal(s.id,{actionId:'amended-reveal',expectedRevision:s.revision}).session;
  const analysis=c.service.analysis(s.id).analysis;assert.equal(analysis.finalEquity,s.summary.accountEquity);assert.equal(analysis.trades.length,1);ledgerCheck(c,s);
  c.snapshotSource.disable();c.reopen();assert.deepEqual(c.service.analysis(s.id).analysis,analysis);
});


test('quantity amendment persists once with exact remaining size and rejects stale or invalid changes',t=>{
  const c=context(t);let s=make(c).session;
  s=mutate(c,s,'qty-order',{type:'limit-open',side:'long',contracts:'2',limitPrice:'49000'}).session;
  const before=structuredClone(s),body={actionId:'qty-amend',expectedRevision:s.revision,command:{type:'amend-quantity',orderId:s.orders[0].id,remainingContracts:'3'}};
  s=c.service.command(s.id,body).session;
  assert.equal(s.orders[0].remainingContracts,'3');assert.equal(s.orders[0].filledContracts,'0');assert.equal(s.orders[0].contracts,'3');
  assert.equal(s.elapsedMinutes,0);assert.equal(s.account.position,null);ledgerCheck(c,s);
  assert.equal(c.service.command(s.id,body).idempotent,true);
  assert.throws(()=>c.service.command(s.id,{...body,actionId:'qty-stale'}),code('REPLAY_REVISION_CONFLICT'));
  assert.throws(()=>mutate(c,s,'qty-bad-step',{type:'amend-quantity',orderId:s.orders[0].id,remainingContracts:'0.001'}));
  assert.deepEqual(c.service.get(s.id).session,s);assert.notEqual(s.reservedBalance,before.reservedBalance);
  c.reopen();assert.deepEqual(c.service.get(s.id).session,s);assert.deepEqual(c.service.command(s.id,body).session,s);ledgerCheck(c,s);
  assert.equal(c.service.audit(s.id,'traces',{limit:200}).items.filter(e=>e.type==='order-quantity-amended').length,1);
});


test('combined preview is read-only and exact, then one atomic command persists and retries once',t=>{
  const c=context(t);let s=make(c).session;s=mutate(c,s,'combined-order',{type:'limit-open',side:'long',contracts:'2',limitPrice:'49000'}).session;
  const before=structuredClone(s),command={type:'amend-order',orderId:s.orders[0].id,limitPrice:'48000',remainingContracts:'3'};
  const traces=c.service.audit(s.id,'traces',{limit:200}),preview=c.service.preview(s.id,{expectedRevision:s.revision,command}).preview;
  assert.deepEqual(c.service.get(s.id).session,before);assert.deepEqual(c.service.audit(s.id,'traces',{limit:200}),traces);
  assert.equal(preview.before.reservedBalance,s.orders[0].reservedBalance);assert.equal(preview.after.filledContracts,'0');
  const body={actionId:'combined',expectedRevision:s.revision,command};s=c.service.command(s.id,body).session;
  assert.equal(s.revision,before.revision+1);assert.equal(s.orders[0].reservedBalance,preview.after.reservedBalance);assert.equal(s.orders[0].limitPrice,'48000');assert.equal(s.orders[0].remainingContracts,'3');ledgerCheck(c,s);
  assert.equal(c.service.command(s.id,body).idempotent,true);assert.throws(()=>c.service.preview(s.id,{expectedRevision:before.revision,command}),code('REPLAY_REVISION_CONFLICT'));
  c.reopen();assert.deepEqual(c.service.get(s.id).session,s);assert.deepEqual(c.service.command(s.id,body).session,s);
  assert.equal(c.service.audit(s.id,'traces',{limit:200}).items.filter(e=>e.type==='order-updated').length,1);
});
