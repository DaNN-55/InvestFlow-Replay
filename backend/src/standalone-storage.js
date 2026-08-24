import { resolve } from "node:path";

export function resolveStandaloneStoragePaths(projectRoot, configuredStorageRoot) {
  const storageRoot = configuredStorageRoot
    ? resolve(configuredStorageRoot)
    : resolve(projectRoot, "storage");

  return {
    dbPath: resolve(storageRoot, "app/replay.sqlite"),
    rankingDbPath: resolve(storageRoot, "app/ranking.sqlite"),
    storageRoot: resolve(storageRoot, "app"),
    tradeRecordsRoot: resolve(storageRoot, "trade-records"),
    workspaceRoot: projectRoot,
  };
}
