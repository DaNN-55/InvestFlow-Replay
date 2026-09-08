import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const setupUrl = new URL(
  "../../src/components/replay/ReplaySetupPanel.vue",
  import.meta.url,
);
test("replay setup presents the compact hero choices with one primary CTA", async () => {
  const setup = await readFile(setupUrl, "utf8");

  assert.doesNotMatch(setup, /ReplayPortfolioJourney/u);
  assert.doesNotMatch(setup, /交付闭环/u);
  assert.match(
    setup,
    /开始\{\{ form\.barInterval === "hybrid" \? "日内模拟" : "日线盲测" \}\}/u,
  );
  assert.match(setup, /replay-setup__hero/u);
  assert.match(setup, /grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 430px\)/u);
  assert.match(setup, /这次怎么练？/u);
  assert.match(setup, /调整资金与成本/u);
  assert.match(setup, /<UiDrawer/u);
  assert.match(setup, /:aria-pressed="form\.barInterval === '1d'"/u);
  assert.match(setup, /:aria-pressed="form\.barInterval === 'hybrid'"/u);
  assert.match(setup, /:aria-pressed="form\.gameLength === length"/u);
  assert.match(setup, /\.replay-setup__submit \{[\s\S]*?background: var\(--ql-color-primary\)/u);
});

test("the narrative change preserves replay modes and submitted configuration", async () => {
  const setup = await readFile(setupUrl, "utf8");

  assert.match(setup, /form\.barInterval === "hybrid"/u);
  assert.match(setup, /\[20, 60, 120\]/u);
  assert.match(setup, /initialCapital: Number\(form\.initialCapital\)/u);
  assert.match(setup, /costConfig: Object\.fromEntries/u);
  assert.match(setup, /trainingMode: "free"/u);
  assert.match(setup, /高级成本设置/u);
  assert.match(setup, /随机匿名历史行情/u);
  assert.match(setup, /marketProvider: \{/u);
});
