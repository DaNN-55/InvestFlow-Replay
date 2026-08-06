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
const contextSource = readFileSync(contextUrl, "utf8");
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

describe("replay playbook training surface", () => {
  it("creates new training only in free mode without a specialist entry", () => {
    assert.match(setupSource, /trainingMode: "free"/u);
    assert.doesNotMatch(setupSource, /战法专项/u);
    assert.doesNotMatch(setupSource, /专项战法设置/u);
    assert.doesNotMatch(setupSource, /playbookVersionId/u);
  });

  it("keeps the route view as a composition surface for frozen context", () => {
    assert.equal(existsSync(contextUrl), true);
    assert.match(viewSource, /ReplayTrainingContext/u);
    assert.match(
      viewSource,
      /<ReplayTrainingContext :training-config="session\.trainingConfig" \/>/u,
    );
    assert.match(viewSource, /:playbooks="playbooks"/u);
  });

  it("shows the frozen playbook name, version and original plain text", () => {
    assert.match(contextSource, /trainingConfig\?\.mode === "playbook"/u);
    assert.match(contextSource, /trainingConfig\.playbookName/u);
    assert.match(contextSource, /playbookVersionNumber/u);
    assert.match(contextSource, /\{\{ playbookContent \}\}/u);
    assert.match(contextSource, /战法后续修改不会影响本局记录/u);
    assert.doesNotMatch(contextSource, /v-html/u);
    assert.match(contextSource, /@media \(max-width: 480px\)/u);
    assert.match(contextSource, /overflow-wrap: anywhere/u);
  });

  it("prevents a specialist blind review from rebinding to a newer version", () => {
    assert.match(
      reviewSource,
      /props\.session\.trainingConfig \?\? \{ mode: "free" \}/u,
    );
    assert.match(
      reviewSource,
      /payload\.playbookId = trainingConfig\.value\.playbookId/u,
    );
    assert.match(
      reviewSource,
      /payload\.playbookVersionId = trainingConfig\.value\.playbookVersionId/u,
    );
    assert.match(reviewSource, /盲评只能使用本局版本，不能改绑/u);
    assert.match(
      reviewSource,
      /v-if="!isPlaybookTraining && !selectedPlaybook"/u,
    );
  });

  it("labels specialist sessions in both history list and detail", () => {
    assert.match(historyListSource, /item\?\.trainingConfig/u);
    assert.match(historyListSource, /专项 · \{\{ formatTrainingLabel\(item\) \}\}/u);
    assert.match(
      historyDetailSource,
      /item\.trainingConfig\?\.mode === 'playbook'/u,
    );
    assert.match(historyDetailSource, /item\.trainingConfig\.playbookName/u);
    assert.match(historyDetailSource, /playbookVersionNumber/u);
  });
});
