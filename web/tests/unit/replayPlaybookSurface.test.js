import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  assert.equal(existsSync(url), true, relativePath);
  return readFileSync(url, "utf8");
}

const apiSource = read("../../src/services/api.js");
const tradeRecordsViewSource = read("../../src/views/TradeRecordsView.vue");
const historyRecordsSource = read(
  "../../src/components/replay-history/ReplayHistoryRecords.vue",
);
const historyDetailSource = read(
  "../../src/components/replay-history/ReplayHistoryDetail.vue",
);
const panelSource = read(
  "../../src/components/replay-playbook/ReplayPlaybookPanel.vue",
);
const listSource = read(
  "../../src/components/replay-playbook/ReplayPlaybookList.vue",
);
const detailSource = read(
  "../../src/components/replay-playbook/ReplayPlaybookDetail.vue",
);
const versionFormSource = read(
  "../../src/components/replay-playbook/ReplayPlaybookVersionForm.vue",
);
const composableSource = read("../../src/composables/useReplayPlaybooks.js");
const reviewSource = read(
  "../../src/components/replay/ReplayReviewPanel.vue",
);
const marketViewSource = read("../../src/views/MarketReplayView.vue");

describe("replay playbook frontend surface", () => {
  it("places the playbook library beside replay history in the primary tabs", () => {
    assert.match(tradeRecordsViewSource, /primaryTab === 'replay'/u);
    assert.match(tradeRecordsViewSource, /primaryTab === 'playbooks'/u);
    assert.match(tradeRecordsViewSource, /ReplayHistoryRecords/u);
    assert.match(tradeRecordsViewSource, /ReplayPlaybookPanel/u);
    assert.doesNotMatch(tradeRecordsViewSource, /ReplayHistoryPanel/u);
  });

  it("exposes the full playbook API and readonly action composable", () => {
    for (const method of [
      "listReplayPlaybooks",
      "createReplayPlaybook",
      "renameReplayPlaybook",
      "deleteReplayPlaybook",
      "getReplayPlaybook",
      "createReplayPlaybookVersion",
      "deleteReplayPlaybookVersion",
      "createReplayPlaybookCandidate",
      "acceptReplayPlaybookCandidate",
      "rejectReplayPlaybookCandidate",
    ]) {
      assert.match(apiSource, new RegExp(`${method}\\(`, "u"));
    }
    assert.match(composableSource, /readonly\(playbooks\)/u);
    assert.match(composableSource, /async function loadPlaybooks/u);
    assert.match(composableSource, /function createVersion/u);
    assert.match(composableSource, /function deleteVersion/u);
    assert.match(composableSource, /function renamePlaybook/u);
    assert.match(composableSource, /function deletePlaybook/u);
    assert.match(composableSource, /function acceptCandidate/u);
    assert.match(composableSource, /function rejectCandidate/u);
  });

  it("keeps list, detail and version form responsibilities explicit", () => {
    assert.match(panelSource, /ReplayPlaybookList/u);
    assert.match(panelSource, /ReplayPlaybookDetail/u);
    assert.match(listSource, /新建战法/u);
    assert.match(listSource, /当前 v/u);
    assert.match(listSource, /条待处理/u);
    assert.match(listSource, /aria-label="战法操作"/u);
    assert.match(listSource, /修改名称/u);
    assert.match(listSource, /删除战法/u);
    assert.match(detailSource, /当前正文/u);
    assert.match(detailSource, /版本历史/u);
    assert.match(detailSource, /基于此版本修改/u);
    assert.match(detailSource, /删除此版本/u);
    assert.match(detailSource, /候选改进/u);
    assert.match(detailSource, /采纳并生成版本/u);
    assert.match(detailSource, /打开源演练/u);
    assert.match(versionFormSource, /完整新正文/u);
    assert.match(versionFormSource, /expectedVersionNumber/u);
    assert.match(versionFormSource, /旧版本不可覆盖/u);
    assert.match(panelSource, /@media \(max-width: 900px\)/u);
    assert.doesNotMatch(panelSource, /战法规则与演练改进/u);
    assert.match(panelSource, /ConfirmDialog/u);
    assert.match(panelSource, /UiModal/u);
  });

  it("clears the create form only after the parent confirms success", () => {
    assert.match(panelSource, /async function handleCreate\(payload\)/u);
    assert.match(panelSource, /await createPlaybook\(payload\)/u);
    assert.match(
      panelSource,
      /if \(result\) \{[\s\S]*?createSuccessToken\.value \+= 1/u,
    );
    assert.match(panelSource, /:create-success-token="createSuccessToken"/u);
    assert.match(listSource, /\(\) => props\.createSuccessToken/u);
    assert.match(listSource, /resetForm\(\)/u);
  });

  it("links blind reviews to a frozen playbook version while preserving legacy text", () => {
    assert.match(marketViewSource, /api\.listReplayPlaybooks/u);
    assert.match(marketViewSource, /onActivated\(loadReplayPlaybooks\)/u);
    assert.doesNotMatch(marketViewSource, /onMounted\(loadReplayPlaybooks\)/u);
    assert.match(marketViewSource, /:playbooks="playbooks"/u);
    assert.match(reviewSource, /关联战法（可选）/u);
    assert.match(reviewSource, /不关联战法 \/ 自由填写/u);
    assert.match(reviewSource, /自由填写战法名称（可选）/u);
    assert.match(reviewSource, /payload\.playbookId = selectedPlaybook\.value\.id/u);
    assert.match(
      reviewSource,
      /payload\.playbookVersionId = selectedPlaybook\.value\.currentVersion\.id/u,
    );
    assert.doesNotMatch(reviewSource, /payload\.playbookVersionNumber/u);
    assert.match(reviewSource, /关联战法 · v/u);
    assert.match(reviewSource, /const linkedVersionReady = computed/u);
    assert.match(reviewSource, /linkedVersionReady\.value/u);
    assert.match(reviewSource, /避免静默丢失关联/u);
  });

  it("turns linked post-review adjustments into controlled candidates", () => {
    assert.match(historyRecordsSource, /createReplayPlaybookCandidate/u);
    assert.match(historyRecordsSource, /\{ sessionId: item\.id \}/u);
    assert.doesNotMatch(historyRecordsSource, /status === 409/u);
    assert.match(historyRecordsSource, /candidateError\?\.message/u);
    assert.match(historyDetailSource, /一键加入候选改进/u);
    assert.match(historyDetailSource, /不能自动加入候选/u);
    assert.match(historyDetailSource, /等待人工处理/u);
    assert.match(panelSource, /investflow\.replay\.active-session-id/u);
    assert.match(panelSource, /router\.push\("\/decision\/market-replay"\)/u);
  });
});
