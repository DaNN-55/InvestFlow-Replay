import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createApp } from "./app.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const port = Number(process.env.INVESTFLOW_REPLAY_BACKEND_PORT ?? 3110);
const engineUrl = process.env.INVESTFLOW_REPLAY_ENGINE_URL ?? "http://127.0.0.1:8775";
const allowedPaths = [
  /^\/api\/quant\/replay(?:\/|$)/,
  /^\/api\/quant\/decision\/execution-settings(?:\/|$)/,
  /^\/api\/quant\/decision\/trade-records(?:\/|$)/,
];

const app = express();
app.use((req, res, next) => {
  if (allowedPaths.some((pattern) => pattern.test(req.path))) {
    next();
    return;
  }
  res.status(404).json({ error: { code: "NOT_FOUND", message: "独立版仅开放行情演练与交易追踪接口" } });
});

const core = createApp({
  dbPath: resolve(projectRoot, "storage/app/replay.sqlite"),
  rankingDbPath: resolve(projectRoot, "storage/app/ranking.sqlite"),
  storageRoot: resolve(projectRoot, "storage/app"),
  tradeRecordsRoot: resolve(projectRoot, "storage/trade-records"),
  workspaceRoot: projectRoot,
  engineUrl,
});
app.use(core);

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`investflow-replay-backend listening on http://127.0.0.1:${port}`);
});
server.once("close", () => core.dispose());
