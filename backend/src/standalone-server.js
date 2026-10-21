import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFrozenOkxSource } from "./replay-crypto-session.js";
import { createOkxHistoryPoolSource } from './replay-crypto-pool.js';
import { DEFAULT_CRYPTO_DATA_ROOT } from './replay-crypto-data.js';
import { createApp } from "./app.js";
import { resolveStandaloneStoragePaths } from "./standalone-storage.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const port = Number(process.env.INVESTFLOW_REPLAY_BACKEND_PORT ?? 3110);
const engineUrl = process.env.INVESTFLOW_REPLAY_ENGINE_URL ?? "http://127.0.0.1:8775";
const dataRoot = resolve(process.env.INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT || DEFAULT_CRYPTO_DATA_ROOT);
const sampleSource = createFrozenOkxSource({ dataRoot });
const app = createApp({
  ...resolveStandaloneStoragePaths(
    projectRoot,
    process.env.INVESTFLOW_REPLAY_STORAGE_ROOT,
  ),
  engineUrl,
  cryptoSnapshotSource: process.env.INVESTFLOW_REPLAY_CRYPTO_SOURCE === 'sample' ? sampleSource
    : createOkxHistoryPoolSource({ poolRoot: resolve(dataRoot, 'crypto-pool'), legacySource: sampleSource }),
});
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`investflow-replay-backend listening on http://127.0.0.1:${port}`);
});
server.once("close", () => app.dispose());
