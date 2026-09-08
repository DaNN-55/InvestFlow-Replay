import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


test("replay setup identifies fixture data and removes the intraday entry", async () => {
  const setup = await readFile(
    new URL("../../src/components/replay/ReplaySetupPanel.vue", import.meta.url),
    "utf8",
  );
  const view = await readFile(
    new URL("../../src/views/MarketReplayView.vue", import.meta.url),
    "utf8",
  );

  assert.match(view, /result\.provider \?\? result\.initialization\?\.provider/u);
  assert.match(view, /:market-provider="marketProvider"/u);
  assert.match(setup, /props\.marketProvider === "fixture"/u);
  assert.match(setup, /离线合成数据 · 不对应真实证券，也不代表真实市场/u);
  assert.match(
    setup,
    /<button\s+v-if="!isFixtureMarket"[\s\S]*?<strong>日内模拟<\/strong>/u,
  );
  assert.doesNotMatch(
    setup,
    /<button\s+v-if="!isFixtureMarket"[\s\S]*?<strong>日线演练<\/strong>/u,
  );
  assert.match(setup, /fixture && form\.barInterval !== "1d"/u);
});
