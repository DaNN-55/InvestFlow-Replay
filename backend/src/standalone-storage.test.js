import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { resolveStandaloneStoragePaths } from "./standalone-storage.js";

const projectRoot = resolve("/tmp/investflow-replay-project");

test("standalone storage paths default to project storage", () => {
  assert.deepEqual(resolveStandaloneStoragePaths(projectRoot), {
    dbPath: resolve(projectRoot, "storage/app/replay.sqlite"),
    rankingDbPath: resolve(projectRoot, "storage/app/ranking.sqlite"),
    storageRoot: resolve(projectRoot, "storage/app"),
    tradeRecordsRoot: resolve(projectRoot, "storage/trade-records"),
    workspaceRoot: projectRoot,
  });
});

test("standalone storage paths use a custom absolute root", () => {
  const customRoot = resolve("/tmp/investflow-replay-demo-storage");
  const paths = resolveStandaloneStoragePaths(projectRoot, customRoot);

  assert.deepEqual(paths, {
    dbPath: resolve(customRoot, "app/replay.sqlite"),
    rankingDbPath: resolve(customRoot, "app/ranking.sqlite"),
    storageRoot: resolve(customRoot, "app"),
    tradeRecordsRoot: resolve(customRoot, "trade-records"),
    workspaceRoot: projectRoot,
  });
  assert.equal(
    Object.values(paths).some((path) => path.startsWith(resolve(projectRoot, "storage"))),
    false,
  );
});
