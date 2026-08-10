import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  describeStandaloneRuntime,
  resolveStandaloneStoragePaths,
} from "./standalone-storage.js";

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

test("standalone runtime reports demo mode only for fixture with project demo storage", () => {
  assert.deepEqual(
    describeStandaloneRuntime(projectRoot, resolve(projectRoot, ".demo-storage"), "fixture"),
    {
      demoMode: true,
      marketProvider: "fixture",
      storageIsolation: "project-demo-storage",
    },
  );
  assert.equal(
    describeStandaloneRuntime(projectRoot, resolve(projectRoot, "storage"), "fixture").demoMode,
    false,
  );
  assert.equal(
    describeStandaloneRuntime(projectRoot, resolve(projectRoot, ".demo-storage"), "tdx").demoMode,
    false,
  );
});

test("standalone runtime rejects a symlinked demo storage root", (t) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "investflow-replay-runtime-"));
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  mkdirSync(resolve(temporaryRoot, "storage"));
  symlinkSync(resolve(temporaryRoot, "storage"), resolve(temporaryRoot, ".demo-storage"));

  assert.deepEqual(
    describeStandaloneRuntime(
      temporaryRoot,
      resolve(temporaryRoot, ".demo-storage"),
      "fixture",
    ),
    {
      demoMode: false,
      marketProvider: "fixture",
      storageIsolation: "default-storage",
    },
  );
});
