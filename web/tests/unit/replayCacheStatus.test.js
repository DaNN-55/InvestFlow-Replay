import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatCacheBytes, formatCacheTime, replayCacheProgress } from "../../src/utils/replayCacheStatus.js";

test("formats cache storage and active progress", () => {
  assert.equal(formatCacheBytes(1536), "1.5 KB");
  assert.deepEqual(
    replayCacheProgress({ activeTask: { state: "running", completed: 3, total: 12 } }),
    { completed: 3, total: 12, percent: 25 },
  );
  assert.equal(replayCacheProgress({ activeTask: { state: "ready", completed: 12, total: 12 } }), null);
  assert.equal(formatCacheTime("2026-08-10T09:00:00Z"), "2026/08/10");
});

test("renders an accessible dismissible cache status surface in the app shell", async () => {
  const app = await readFile(new URL("../../src/App.vue", import.meta.url), "utf8");
  const component = await readFile(
    new URL("../../src/components/ReplayCacheStatus.vue", import.meta.url),
    "utf8",
  );

  assert.match(app, /ReplayCacheStatus/u);
  assert.match(component, /aria-label="行情缓存状态"/u);
  assert.match(component, /股票日线/u);
  assert.match(component, /1分钟缓存/u);
  assert.match(component, /存储占用/u);
  assert.match(component, /:aria-expanded="open"/u);
  assert.match(component, /document\.addEventListener\("pointerdown"/u);
  assert.match(component, /@media \(max-width: 720px\)[\s\S]*position: fixed/u);
});
