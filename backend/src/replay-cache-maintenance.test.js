import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";

test("cache updates preserve frozen sessions and deleted sessions remain seen after page entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-maintenance-"));
  let price = 10;
  let statusRequest;
  const prefetchRequests = [];
  const benchmark = { code: "000001.SH", name: "上证指数", supportedGameLengths: [20, 60, 120] };
  const engine = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/internal/replay/benchmarks")) {
      res.end(JSON.stringify({ items: [benchmark], initialization: { ready: true, state: "ready" } }));
    } else if (req.url === "/internal/replay/scenarios") {
      const bars = Array.from({ length: 270 }, (_, i) => ({ sequence: i + 1, tradeDate: "2026-09-01", open: price, high: price + 1, low: price - 1, close: price, volume: 10000, amount: price * 10000 }));
      res.end(JSON.stringify({ sourceDataVersion: `cache-${price}`, tsCode: "600000.SH", name: "样本股票", interval: "hybrid", observationBars: 250, gameLength: 20, trainingDays: 20, bars, benchmark: { ...benchmark, bars: bars.slice(249) } }));
    } else if (req.url === "/internal/replay/cache/status") {
      statusRequest = payload;
      res.end(JSON.stringify({ state: "partial", coverage: { boards: [] } }));
    } else {
      prefetchRequests.push(payload);
      res.end(JSON.stringify({ available: true }));
    }
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  const app = createApp({ dbPath: join(root, "ledger.sqlite"), rankingDbPath: join(root, "ranking.sqlite"), storageRoot: root, workspaceRoot: root, tradeRecordsRoot: join(root, "records"), engineUrl: `http://127.0.0.1:${engine.address().port}` });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const client = request(server);
    const created = await client.post("/api/quant/replay/sessions").send({ gameLength: 20, interval: "hybrid", benchmarkCode: benchmark.code });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const path = `/api/quant/replay/sessions/${created.body.session.id}`;
    const before = (await client.get(path).expect(200)).body;
    price = 30;
    await client.get("/api/quant/replay/cache/status").expect(200);
    assert.deepEqual((await client.get(path).expect(200)).body, before);
    assert.deepEqual(statusRequest.excludedTsCodes, ["600000.SH"]);
    assert.equal(statusRequest.benchmarkCode, benchmark.code);
    await client.delete(path).expect(200);
    await client.get("/api/quant/replay/cache/status").expect(200);
    assert.deepEqual(statusRequest.excludedTsCodes, ["600000.SH"]);
    await client.get("/api/quant/replay/benchmarks").expect(200);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(prefetchRequests.some(value => value.interval === "hybrid" && value.benchmarkCode === benchmark.code && value.excludedTsCodes.includes("600000.SH")));
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.dispose();
    await new Promise(resolve => engine.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
