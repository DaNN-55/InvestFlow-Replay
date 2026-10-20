import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";

export async function startOrderTestServer(port = 0, { tsCode = "000001.SZ" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "investflow-order-http-"));
  const candle = (i, overrides = {}) => ({ sequence: i + 1, tradeDate: `2024-before-${i}`, open: 10,
    high: 10.2, low: 9.9, close: 10, preClose: 10, pctChange: 0, limitType: "N", volume: 1000000,
    amount: 10000000, weekIndex: Math.floor(i / 5), monthIndex: Math.floor(i / 20), ...overrides });
  const bars = Array.from({ length: 270 }, (_, i) => candle(i, i < 250 ? {} : { tradeDate: i < 254 ? "2024-10-21" : "2024-10-22", volume: 1000 }));
  Object.assign(bars[250], { open: 10.1, low: 10.03, close: 10.1 });
  Object.assign(bars[253], { open: 9.7, high: 9.9, low: 9.6, close: 9.7, volume: 500 });
  Object.assign(bars[254], { open: 9.9, low: 9.85, close: 9.95, volume: 500 });
  Object.assign(bars[255], { open: 10, low: 9.9, volume: 500 });
  for (const bar of bars) bar.amount = bar.volume * bar.close;
  const engine = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/internal/replay/benchmarks")) {
      res.end(JSON.stringify({ sourceDataVersion: "fixed-orders-http", initialization: { state: "ready", ready: true },
        items: [{ code: "000001.SH", name: "上证指数", supportedGameLengths: [20, 60, 120] }] }));
    } else if (req.url === "/internal/replay/scenarios") {
      let body = "";
      req.on("data", (data) => { body += data; });
      req.on("end", () => {
        const payload = JSON.parse(body);
        res.end(JSON.stringify({ sourceDataVersion: "fixed-orders-http", tsCode, name: "测试股票", symbol: tsCode.split('.')[0], exchange: tsCode.endsWith('.SH') ? 'SSE' : 'SZSE',
          observationBars: 250, gameLength: 20, trainingDays: 20, interval: payload.interval ?? "1d", stepMinutes: 5, bars }));
      });
    } else if (req.url.startsWith("/internal/replay/cache/status")) {
      res.end(JSON.stringify({ state: "ready", market: {}, minute: {}, storage: {} }));
    } else res.end(JSON.stringify({ state: "ready" }));
  });
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const app = createApp({ dbPath: join(root, "replay.sqlite"), rankingDbPath: join(root, "ranking.sqlite"),
    storageRoot: root, workspaceRoot: root, tradeRecordsRoot: join(root, "records"), engineUrl: `http://127.0.0.1:${engine.address().port}` });
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, app, url: `http://127.0.0.1:${server.address().port}`, root,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.dispose();
      await new Promise((resolve) => engine.close(resolve));
      rmSync(root, { recursive: true, force: true });
    } };
}
