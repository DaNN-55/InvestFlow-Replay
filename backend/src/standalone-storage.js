import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isProjectDemoStorage(projectRoot, storageRoot) {
  const expectedStorageRoot = resolve(projectRoot, ".demo-storage");
  if (storageRoot !== expectedStorageRoot) {
    return false;
  }

  try {
    const storageStat = lstatSync(storageRoot);
    return (
      storageStat.isDirectory() &&
      !storageStat.isSymbolicLink() &&
      realpathSync(storageRoot) === resolve(realpathSync(projectRoot), ".demo-storage")
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

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

export function describeStandaloneRuntime(projectRoot, configuredStorageRoot, marketProvider) {
  const storageRoot = configuredStorageRoot
    ? resolve(configuredStorageRoot)
    : resolve(projectRoot, "storage");
  const provider = String(marketProvider ?? "tdx").trim().toLowerCase();
  const demoMode = provider === "fixture" && isProjectDemoStorage(projectRoot, storageRoot);
  const relativeStorageRoot = relative(resolve(projectRoot), storageRoot);
  const customStorage = Boolean(configuredStorageRoot)
    && (
      relativeStorageRoot === ".."
      || relativeStorageRoot.startsWith(`..${sep}`)
      || isAbsolute(relativeStorageRoot)
    );

  return {
    demoMode,
    marketProvider: provider,
    storageIsolation: demoMode
      ? "project-demo-storage"
      : customStorage ? "custom-storage" : "default-storage",
  };
}
