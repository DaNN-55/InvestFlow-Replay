import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const setupUrl = new URL(
  "../../src/components/replay/ReplaySetupPanel.vue",
  import.meta.url,
);
const journeyUrl = new URL(
  "../../src/components/replay/ReplayPortfolioJourney.vue",
  import.meta.url,
);

test("replay setup presents the five-step portfolio journey with one primary CTA", async () => {
  const [setup, journey] = await Promise.all([
    readFile(setupUrl, "utf8"),
    readFile(journeyUrl, "utf8"),
  ]);

  assert.match(setup, /<ReplayPortfolioJourney :market-provider="marketProvider" \/>/u);
  assert.match(
    setup,
    /开始\{\{ form\.barInterval === "hybrid" \? "日内模拟" : "日线盲测" \}\}/u,
  );

  for (const step of ["研究假设", "行情演练", "模拟执行", "复盘", "规则迭代"]) {
    assert.match(journey, new RegExp(step, "u"));
  }

  assert.match(journey, /通达信模式 · 真实历史数据/u);
  assert.match(journey, /优先使用本地缓存，按需连接通达信补齐/u);
  assert.match(journey, /离线 Demo · 合成数据/u);
  assert.match(journey, /不对应真实证券或真实市场/u);
  assert.match(journey, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(setup, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/u);
  assert.match(setup, /replay-setup__form-wide/u);
});

test("the narrative change preserves replay modes and submitted configuration", async () => {
  const setup = await readFile(setupUrl, "utf8");

  assert.match(setup, /form\.barInterval === "hybrid"/u);
  assert.match(setup, /\[20, 60, 120\]/u);
  assert.match(setup, /initialCapital: Number\(form\.initialCapital\)/u);
  assert.match(setup, /costConfig: Object\.fromEntries/u);
  assert.match(setup, /trainingMode: "free"/u);
  assert.match(setup, /高级成本设置/u);
  assert.match(setup, /离线合成数据 · 不对应真实证券，也不代表真实市场/u);
});
