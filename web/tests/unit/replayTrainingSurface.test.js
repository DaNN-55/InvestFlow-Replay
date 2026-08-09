import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const setupSource = readSource(
  "../../src/components/replay/ReplaySetupPanel.vue",
);
const contextUrl = new URL(
  "../../src/components/replay/ReplayTrainingContext.vue",
  import.meta.url,
);
const viewSource = readSource("../../src/views/MarketReplayView.vue");
const reviewSource = readSource(
  "../../src/components/replay/ReplayReviewPanel.vue",
);
const historyListSource = readSource(
  "../../src/components/replay-history/ReplayHistoryList.vue",
);
const historyDetailSource = readSource(
  "../../src/components/replay-history/ReplayHistoryDetail.vue",
);

describe("free replay training surface", () => {
  it("creates new training only in free mode without a specialist entry", () => {
    assert.match(setupSource, /trainingMode: "free"/u);
    assert.doesNotMatch(setupSource, /战法专项/u);
    assert.doesNotMatch(setupSource, /专项战法设置/u);
    assert.doesNotMatch(setupSource, /playbookVersionId/u);
  });

  it("removes the retired specialist context from the replay route", () => {
    assert.equal(existsSync(contextUrl), false);
    assert.doesNotMatch(viewSource, /ReplayTrainingContext/u);
    assert.match(viewSource, /:playbooks="playbooks"/u);
  });

  it("offers an optional frozen playbook reference during free review", () => {
    assert.match(reviewSource, /参考战法（可选）/u);
    assert.match(
      reviewSource,
      /payload\.playbookId = selectedPlaybook\.value\.id/u,
    );
    assert.match(
      reviewSource,
      /payload\.playbookVersionId = selectedPlaybook\.value\.currentVersion\.id/u,
    );
    assert.match(reviewSource, /保存后冻结/u);
    assert.doesNotMatch(reviewSource, /isPlaybookTraining/u);
  });

  it("does not label retired specialist sessions in history", () => {
    assert.doesNotMatch(historyListSource, /formatTrainingLabel/u);
    assert.doesNotMatch(historyListSource, /专项/u);
    assert.doesNotMatch(historyDetailSource, /专项战法/u);
    assert.doesNotMatch(historyDetailSource, /trainingConfig\?\.mode/u);
  });
});
