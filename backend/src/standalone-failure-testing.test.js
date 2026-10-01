import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import request from "supertest";

import { createApp } from "./app.js";

// Regression contracts from the failure audit. Do not skip or invert these
// assertions: docs/audits/failure-testing.md records the original bugs and fixes.
const recordsPath = "/api/quant/decision/trade-records";
const sessionsPath = "/api/quant/replay/sessions";
const recordInput = (id, extra = {}) => ({
  id, stockCode: "600000", stockName: "测试标的", accountType: "simulated",
  tradeType: "subjective", ...extra,
});
const eventInput = (extra = {}) => ({
  id: "execution-1", eventAt: "2026-09-01", action: "buy",
  price: 10, quantity: 100, fee: 0, ...extra,
});

function scenario() {
  return {
    sourceDataVersion: "failure-audit-fixture-v1", tsCode: "600000.SH",
    name: "隔离测试", interval: "1d", observationBars: 250, gameLength: 20,
    bars: Array.from({ length: 270 }, (_, index) => ({
      sequence: index + 1,
      tradeDate: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: 10, high: 11, low: 9, close: 10, preClose: 10,
      volume: 1000, amount: 10000, pctChange: 0,
      weekIndex: Math.floor(index / 5) + 1, monthIndex: Math.floor(index / 20) + 1,
    })),
  };
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "investflow-failure-test-"));
  const dbPath = join(root, "app", "replay.sqlite");
  const tradeRecordsRoot = join(root, "trade-records");
  let engineReply = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(scenario()));
  };
  const engine = createServer((req, res) => engineReply(req, res));
  let app;
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    app?.dispose();
    await new Promise((resolve) => engine.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const options = {
    dbPath, tradeRecordsRoot, workspaceRoot: root, storageRoot: join(root, "app"),
    engineUrl: `http://127.0.0.1:${engine.address().port}`,
  };
  async function open() {
    app = createApp(options);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
  }
  await open();
  return {
    root, dbPath, tradeRecordsRoot,
    get http() { return request(server); },
    reply(handler) { engineReply = handler; },
    async restart() {
      await new Promise((resolve) => server.close(resolve));
      server = null;
      app.dispose();
      await open();
    },
    inspect(operation) {
      const database = new DatabaseSync(dbPath);
      try { return operation(database); } finally { database.close(); }
    },
  };
}

test("F01 missing storage directories initialize an empty archive; missing records are 404", async (t) => {
  const f = await fixture(t);
  const empty = await f.http.get(recordsPath).expect(200);
  assert.deepEqual(empty.body.items, []);
  await f.http.get(`${recordsPath}/missing`).expect(404);
  await f.http.patch(`${recordsPath}/missing`).send({ note: "无记录" }).expect(404);
  await f.http.post(recordsPath).send(recordInput("first")).expect(201);
  await f.restart();
  const restored = await f.http.get(`${recordsPath}/first`).expect(200);
  assert.equal(restored.body.stockName, "测试标的");
});

test("F02 a damaged JSON file does not make an unrelated healthy record unreadable", async (t) => {
  const f = await fixture(t);
  await f.http.post(recordsPath).send(recordInput("healthy")).expect(201);
  const damagedPath = join(f.tradeRecordsRoot, "interrupted.json");
  writeFileSync(damagedPath, '{"id":"interrupted",');
  const response = await f.http.get(`${recordsPath}/healthy`);
  const listing = await f.http.get(recordsPath);
  t.diagnostic(JSON.stringify({ detailStatus: response.status, listStatus: listing.status, error: response.body.error }));
  assert.equal(readFileSync(damagedPath, "utf8"), '{"id":"interrupted",');
  assert.equal(response.status, 200, "one damaged sibling file must not block a valid record");
  assert.equal(response.body.id, "healthy");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.items.map((item) => item.id), ["healthy"]);
  assert.equal(listing.body.errors.length, 1);
  assert.equal(listing.body.errors[0].fileName, "interrupted.json");
  await f.http.post(recordsPath).send(recordInput("interrupted")).expect(409);
  assert.equal(readFileSync(damagedPath, "utf8"), '{"id":"interrupted",');
});

test("F02 a damaged existing ledger is reported and cannot be replaced through POST", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(recordsPath).send(recordInput("damaged-existing")).expect(201);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  writeFileSync(path, "{broken");
  await f.http.post(recordsPath).send(recordInput("damaged-existing")).expect(409);
  await f.http.delete(`${recordsPath}/damaged-existing`).expect(409);
  const listing = await f.http.get(recordsPath).expect(200);
  assert.deepEqual(listing.body.items, []);
  assert.equal(listing.body.errors[0].fileName, created.body.fileName);
  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("F03a rejecting an oversold initial ledger leaves no persisted record", async (t) => {
  const f = await fixture(t);
  await f.http.post(recordsPath).send(recordInput("healthy")).expect(201);
  const filesBefore = readdirSync(f.tradeRecordsRoot);
  const response = await f.http.post(recordsPath).send(recordInput("invalid", {
    executionEvents: [eventInput({ action: "sell" })],
  }));
  const listing = await f.http.get(recordsPath);
  t.diagnostic(JSON.stringify({ writeStatus: response.status, listStatus: listing.status, files: readdirSync(f.tradeRecordsRoot) }));
  assert.equal(response.status, 400);
  assert.deepEqual(readdirSync(f.tradeRecordsRoot), filesBefore, "a rejected create must not write an invalid ledger");
  assert.equal(listing.status, 200);
});

test("F03b rejecting an oversold PATCH preserves the previous file byte for byte", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(recordsPath).send(recordInput("existing")).expect(201);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  const previous = readFileSync(path, "utf8");
  const response = await f.http.patch(`${recordsPath}/existing`).send({
    executionEvents: [eventInput({ action: "sell" })],
  });
  const detail = await f.http.get(`${recordsPath}/existing`);
  t.diagnostic(JSON.stringify({ writeStatus: response.status, detailStatus: detail.status }));
  assert.equal(response.status, 400);
  assert.equal(readFileSync(path, "utf8"), previous, "a rejected update must preserve the saved record");
  assert.equal(detail.status, 200);
});

test("F03 a partial filesystem write leaves the saved file intact and removes temporary output", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(recordsPath).send(recordInput("io-failure")).expect(201);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  const previous = readFileSync(path, "utf8");
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (destination) => {
    originalWrite(destination, "{partial", "utf8");
    throw Object.assign(new Error("injected partial write"), { code: "EIO" });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await f.http.patch(`${recordsPath}/io-failure`).send({ stockName: "新名称" }).expect(500);
  assert.equal(readFileSync(path, "utf8"), previous);
  assert.deepEqual(readdirSync(f.tradeRecordsRoot), [created.body.fileName]);
  const restored = await f.http.get(`${recordsPath}/io-failure`).expect(200);
  assert.equal(restored.body.stockName, "测试标的");
});

test("F04 retrying the same execution event ID must not double the holding", async (t) => {
  const f = await fixture(t);
  await f.http.post(recordsPath).send(recordInput("retry")).expect(201);
  await f.http.post(`${recordsPath}/retry/execution-events`).send(eventInput()).expect(200);
  const repeated = await f.http.post(`${recordsPath}/retry/execution-events`).send(eventInput());
  const saved = await f.http.get(`${recordsPath}/retry`).expect(200);
  t.diagnostic(JSON.stringify({ retryStatus: repeated.status, events: saved.body.executionEvents.length, quantity: saved.body.ledger.positionQuantity }));
  assert.equal(saved.body.executionEvents.length, 1, "an execution ID identifies one ledger event");
  assert.equal(saved.body.ledger.positionQuantity, 100);
});

test("F04 concurrent and restarted retries remain idempotent; conflicting content never changes the file", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(recordsPath).send(recordInput("event-conflict")).expect(201);
  const eventPath = `${recordsPath}/event-conflict/execution-events`;
  const results = await Promise.all([
    f.http.post(eventPath).send(eventInput()),
    f.http.post(eventPath).send(eventInput()),
  ]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  const before = readFileSync(path, "utf8");
  await f.restart();
  const repeated = await f.http.post(eventPath).send(eventInput()).expect(200);
  assert.equal(repeated.body.ledger.positionQuantity, 100);
  assert.equal(repeated.body.executionEvents.length, 1);
  await f.http.post(eventPath).send(eventInput({ quantity: 200 })).expect(409);
  assert.equal(readFileSync(path, "utf8"), before);
  const independent = await f.http.post(eventPath).send(eventInput({ id: "execution-2" })).expect(200);
  assert.equal(independent.body.ledger.positionQuantity, 200);
  assert.equal(independent.body.executionEvents.length, 2);
});

test("F04 generic create and update cannot introduce duplicate execution IDs", async (t) => {
  const f = await fixture(t);
  const duplicateEvents = [eventInput(), eventInput()];
  await f.http.post(recordsPath).send(recordInput("duplicate", { executionEvents: duplicateEvents })).expect(400);
  assert.deepEqual(readdirSync(f.tradeRecordsRoot), []);
  const created = await f.http.post(recordsPath).send(recordInput("existing")).expect(201);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  const before = readFileSync(path, "utf8");
  await f.http.patch(`${recordsPath}/existing`).send({ executionEvents: duplicateEvents }).expect(400);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("F05 Chinese, emoji and path characters round-trip; overlong notes are rejected without writes", async (t) => {
  const f = await fixture(t);
  const name = "中文🧪/\\:*?\"<>| e\u0301";
  const note = "中🧪".repeat(333) + "!"; // exactly 1000 UTF-16 code units
  const created = await f.http.post(recordsPath).send(recordInput("unicode", { stockName: name })).expect(201);
  const saved = await f.http.post(`${recordsPath}/unicode/execution-events`).send(eventInput({ note })).expect(200);
  assert.equal(saved.body.stockName, name);
  assert.equal(saved.body.executionEvents[0].note, note);
  const path = join(f.tradeRecordsRoot, created.body.fileName);
  const previous = readFileSync(path, "utf8");
  await f.http.post(`${recordsPath}/unicode/execution-events`).send(eventInput({ id: "long", note: note + "!" })).expect(400);
  assert.equal(readFileSync(path, "utf8"), previous);
  await f.restart();
  const restored = await f.http.get(`${recordsPath}/unicode`).expect(200);
  assert.equal(restored.body.executionEvents[0].note, note);
  assert.equal(readdirSync(f.tradeRecordsRoot).length, 1);
});

test("F05 malformed and oversized JSON requests do not create files", async (t) => {
  const f = await fixture(t);
  await f.http.get(recordsPath).expect(200);
  await f.http.post(recordsPath).set("content-type", "application/json").send('{"broken":').expect(400);
  await f.http.post(recordsPath).send(recordInput("large", { note: "x".repeat(2 * 1024 * 1024) })).expect(413);
  assert.deepEqual(readdirSync(f.tradeRecordsRoot), []);
});

test("F06 disconnected, non-JSON and truncated engine responses fail without creating sessions", async (t) => {
  const f = await fixture(t);
  for (const [label, handler] of [
    ["disconnect", (req) => req.socket.destroy()],
    ["truncated JSON", (_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"bars":'); }],
    ["HTML success", (_req, res) => { res.setHeader("content-type", "text/html"); res.end("<html>Unavailable</html>"); }],
  ]) {
    f.reply(handler);
    const response = await f.http.post(sessionsPath).send({ gameLength: 20 });
    t.diagnostic(`${label}: ${response.status} ${response.body.error?.code}`);
    assert.ok(response.status >= 500 && response.status <= 599, label);
    assert.equal(typeof response.body.error.message, "string");
    assert.equal(f.inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM replay_sessions").get().count), 0);
  }
});

test("F07 incomplete scenario length is rejected before persistence", async (t) => {
  const f = await fixture(t);
  f.reply((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...scenario(), bars: [] }));
  });
  await f.http.post(sessionsPath).send({ gameLength: 20 }).expect(502);
  assert.equal(f.inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM replay_sessions").get().count), 0);
});

test("F07 bars with null OHLC must not become a persisted successful session", async (t) => {
  const f = await fixture(t);
  f.reply((_req, res) => {
    const payload = scenario();
    payload.bars = payload.bars.map((bar) => ({ ...bar, open: null, high: null, low: null, close: null }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  const response = await f.http.post(sessionsPath).send({ gameLength: 20 });
  const count = f.inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM replay_sessions").get().count);
  t.diagnostic(JSON.stringify({ status: response.status, sessions: count, firstBar: response.body.session?.bars?.[0] }));
  assert.equal(response.status, 502, "length alone does not make a usable market snapshot");
  assert.equal(count, 0);
});

test("F07 rejects malformed prices in future stock bars and benchmark bars before persistence", async (t) => {
  const f = await fixture(t);
  const mutations = [
    ["missing", (payload) => { delete payload.bars[250].open; }],
    ["empty", (payload) => { payload.bars[250].open = ""; }],
    ["numeric string", (payload) => { payload.bars[250].open = "10"; }],
    ["boolean", (payload) => { payload.bars[250].open = true; }],
    ["zero", (payload) => { payload.bars[250].open = 0; }],
    ["negative", (payload) => { payload.bars[250].open = -1; }],
    ["inconsistent OHLC", (payload) => { payload.bars[250].high = 5; }],
    ["benchmark null", (payload) => {
      payload.benchmark = { code: "000001.SH", bars: structuredClone(payload.bars.slice(249)) };
      payload.benchmark.bars[0].close = null;
    }],
  ];
  for (const [label, mutate] of mutations) {
    f.reply((_req, res) => {
      const payload = scenario();
      mutate(payload);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    const response = await f.http.post(sessionsPath).send({ gameLength: 20 });
    assert.equal(response.status, 502, label);
    assert.equal(f.inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM replay_sessions").get().count), 0, label);
  }
});

test("F08 corrupt SQLite account JSON fails closed without advancing or overwriting it", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(sessionsPath).send({ gameLength: 20 }).expect(201);
  const id = created.body.session.id;
  f.inspect((db) => db.prepare("UPDATE replay_sessions SET account_json = ? WHERE id = ?").run("{broken", id));
  // The production parser logs corrupt content; this is a synthetic fixture only.
  await f.http.get(`${sessionsPath}/${id}`).expect(500);
  await f.http.post(`${sessionsPath}/${id}/advance`).send({ actionId: "corrupt", expectedRevision: 0 }).expect(500);
  const row = f.inspect((db) => db.prepare("SELECT revision, revealed_future_bars, account_json FROM replay_sessions WHERE id = ?").get(id));
  assert.equal(row.revision, 0);
  assert.equal(row.revealed_future_bars, 0);
  assert.equal(row.account_json, "{broken");
});

test("F09 restarting the app retains order/advance idempotency and detects conflicting retries", async (t) => {
  const f = await fixture(t);
  const created = await f.http.post(sessionsPath).send({ gameLength: 20 }).expect(201);
  const id = created.body.session.id;
  const order = { actionId: "durable-order", expectedRevision: 0, side: "buy", quantity: 100 };
  const advance = { actionId: "durable-advance", expectedRevision: 1 };
  await f.http.post(`${sessionsPath}/${id}/orders`).send(order).expect(201);
  const first = await f.http.post(`${sessionsPath}/${id}/advance`).send(advance).expect(200);
  assert.equal(first.body.session.executions.length, 1);
  await f.restart();
  const retriedOrder = await f.http.post(`${sessionsPath}/${id}/orders`).send(order).expect(200);
  const retriedAdvance = await f.http.post(`${sessionsPath}/${id}/advance`).send(advance).expect(200);
  assert.equal(retriedOrder.body.idempotent, true);
  assert.equal(retriedAdvance.body.idempotent, true);
  assert.equal(retriedAdvance.body.session.revision, 2);
  assert.equal(retriedAdvance.body.session.revealedFutureBars, 1);
  assert.deepEqual(retriedAdvance.body.session.executions, first.body.session.executions);
  assert.deepEqual(retriedAdvance.body.session.account, first.body.session.account);
  await f.http.post(`${sessionsPath}/${id}/orders`).send({ ...order, quantity: 200 }).expect(409);
});
