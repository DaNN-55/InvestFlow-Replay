import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../../src/App.vue", import.meta.url);

test("standalone shell uses a compact accessible icon navigation", async () => {
  const source = await readFile(appUrl, "utf8");

  assert.match(source, /ChartCandlestick/u);
  assert.match(source, /ClipboardList/u);
  assert.match(source, /aria-label="行情演练"/u);
  assert.match(source, /aria-label="交易追踪"/u);
  assert.match(source, /height: 44px/u);
  assert.doesNotMatch(source, />行情演练<|>交易追踪</u);
});
