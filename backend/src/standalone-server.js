import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import {
  describeStandaloneRuntime,
  resolveStandaloneStoragePaths,
} from "./standalone-storage.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const port = Number(process.env.INVESTFLOW_REPLAY_BACKEND_PORT ?? 3110);
const engineUrl = process.env.INVESTFLOW_REPLAY_ENGINE_URL ?? "http://127.0.0.1:8775";
const runtime = describeStandaloneRuntime(
  projectRoot,
  process.env.INVESTFLOW_REPLAY_STORAGE_ROOT,
  process.env.INVESTFLOW_REPLAY_MARKET_PROVIDER,
);
const app = createApp({
  ...resolveStandaloneStoragePaths(
    projectRoot,
    process.env.INVESTFLOW_REPLAY_STORAGE_ROOT,
  ),
  engineUrl,
});
app.get("/api/quant/replay/runtime", (_req, res) => res.json(runtime));

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`investflow-replay-backend listening on http://127.0.0.1:${port}`);
});
server.once("close", () => app.dispose());
