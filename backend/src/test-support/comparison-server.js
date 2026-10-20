import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

import { createApp } from "../app.js";

function isoDate(index) {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}

function scenarioFor(payload = {}) {
  const gameLength = Number(payload.gameLength ?? 20);
  const bars = Array.from({ length: 250 + gameLength }, (_, index) => ({
    sequence: index + 1,
    tradeDate: isoDate(index),
    open: 10,
    high: 10.2,
    low: 9.8,
    close: index === 250 ? 10.1 : 10,
    preClose: 10,
    volume: 100000,
    amount: 1000000,
    weekIndex: Math.floor(index / 5) + 1,
    monthIndex: Math.floor(index / 20) + 1,
  }));
  const benchmarkCode = String(payload.benchmarkCode ?? "000001.SH");
  const benchmarkBars = Array.from({ length: gameLength + 1 }, (_, index) => ({
    sequence: 250 + index,
    tradeDate: bars[249 + index]?.tradeDate,
    open: 3000,
    high: 3050,
    low: 2950,
    close: 3000 + index,
    preClose: 3000,
    volume: 100000,
    amount: 1000000,
  }));
  return {
    sourceDataVersion: "comparison-fixed-v1",
    tsCode: "600000.SH",
    symbol: "600000",
    exchange: "SSE",
    name: "对照测试股票",
    interval: payload.interval ?? "1d",
    observationBars: 250,
    gameLength,
    trainingDays: gameLength,
    bars,
    benchmark: { code: benchmarkCode, name: "对照指数", bars: benchmarkBars },
  };
}

function blindReview() {
  return {
    strategyName: "趋势突破",
    thesis: "价格突破整理区间，量能同步放大，预期延续上行。",
    tradePlan: "突破后分批买入，次日确认强度，弱于预期则停止加仓。",
    riskPlan: "跌回整理区间立即止损，单次风险不超过计划范围。",
    confidence: 4,
    trendView: "bullish",
    outlook: "bullish",
    reasonTags: ["突破", "放量"],
    stopLossPrice: null,
    invalidationRule: null,
  };
}

function postReview() {
  return {
    outcome: "partial",
    executionReview: "开仓按计划执行，但没有等待更明确的次日确认信号。",
    mistakes: "仓位建立略早，未充分确认突破后的承接强度。",
    lessons: "后续需要把次日承接和量价确认写进执行清单。",
    disciplineScore: 4,
    riskControlScore: 4,
    strategyAdjustment: "增加次日承接确认条件。",
  };
}

async function finishRevealReview(client, session, prefix, { advance = false } = {}) {
  let current = session;
  if (advance) {
    const stepped = await client.post(`/api/quant/replay/sessions/${session.id}/advance`).send({ actionId: `${prefix}-advance`, expectedRevision: current.revision });
    current = stepped.body.session;
  }
  const finished = await client.post(`/api/quant/replay/sessions/${session.id}/finish`).send({ actionId: `${prefix}-finish`, expectedRevision: current.revision });
  current = finished.body.session;
  const blind = await client.post(`/api/quant/replay/sessions/${session.id}/reviews/blind`).send({ actionId: `${prefix}-blind`, expectedRevision: current.revision, ...blindReview() });
  current = blind.body.session;
  const revealed = await client.post(`/api/quant/replay/sessions/${session.id}/reveal`).send({ actionId: `${prefix}-reveal`, expectedRevision: current.revision });
  current = revealed.body.session;
  const post = await client.post(`/api/quant/replay/sessions/${session.id}/reviews/post`).send({ actionId: `${prefix}-post`, expectedRevision: current.revision, ...postReview() });
  return post.body.session;
}

export async function startComparisonTestServer(port = 0) {
  const root = mkdtempSync(join(tmpdir(), "investflow-replay-comparison-"));
  const engine = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/internal/replay/scenarios" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => res.end(JSON.stringify(scenarioFor(JSON.parse(body || "{}")))));
      return;
    }
    if (url.pathname === "/internal/replay/benchmarks") {
      res.end(JSON.stringify({ initialization: { ready: true }, items: [{ code: "000001.SH", name: "上证指数", supportedGameLengths: [20, 60, 120] }] }));
      return;
    }
    res.end(JSON.stringify({ state: "ready", market: {}, minute: {}, storage: {} }));
  });
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const app = createApp({
    dbPath: join(root, "replay.sqlite"),
    rankingDbPath: join(root, "ranking.sqlite"),
    storageRoot: root,
    workspaceRoot: root,
    tradeRecordsRoot: join(root, "records"),
    engineUrl: `http://127.0.0.1:${engine.address().port}`,
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const client = request(server);
  const sessionIds = {};
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    app.dispose();
    await new Promise((resolve) => engine.close(resolve));
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const firstResponse = await client.post("/api/quant/replay/sessions").send({ gameLength: 20, benchmarkCode: "000001.SH" });
    if (!firstResponse.body.session) throw new Error(`comparison first create failed: ${firstResponse.status} ${JSON.stringify(firstResponse.body)}`);
    const first = firstResponse.body.session;
    sessionIds.first = first.id;
    const order = await client.post(`/api/quant/replay/sessions/${first.id}/orders`).send({ actionId: "comparison-order", expectedRevision: 0, side: "buy", quantity: 5000 });
    const advanced = await client.post(`/api/quant/replay/sessions/${first.id}/advance`).send({ actionId: "comparison-advance", expectedRevision: order.body.session.revision });
    await finishRevealReview(client, advanced.body.session, "first");
    const retrain2 = (await client.post(`/api/quant/replay/sessions/${first.id}/retrain`).send({})).body.session;
    sessionIds.retrain2 = retrain2.id;
    await finishRevealReview(client, retrain2, "retrain2", { advance: true });
    const retrain3 = (await client.post(`/api/quant/replay/sessions/${retrain2.id}/retrain`).send({})).body.session;
    sessionIds.retrain3 = retrain3.id;
    await finishRevealReview(client, retrain3, "retrain3", { advance: true });
    const hidden = (await client.post(`/api/quant/replay/sessions/${retrain3.id}/retrain`).send({})).body.session;
    sessionIds.hidden = hidden.id;
    const isolated = (await client.post("/api/quant/replay/sessions").send({ gameLength: 20, benchmarkCode: "399001.SZ" })).body.session;
    sessionIds.isolated = isolated.id;
    await finishRevealReview(client, isolated, "isolated");
  } catch (error) {
    await close();
    throw error;
  }
  return {
    server,
    app,
    root,
    url: `http://127.0.0.1:${server.address().port}`,
    sessionIds,
    close,
  };
}
