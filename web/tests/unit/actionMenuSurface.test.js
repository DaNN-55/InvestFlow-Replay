import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  assert.equal(existsSync(url), true, relativePath);
  return readFileSync(url, "utf8");
}

const actionMenuUrl = new URL(
  "../../src/components/ui/UiActionMenu.vue",
  import.meta.url,
);

const menuConsumers = [
  ["../../src/views/TradeRecordsView.vue", 1],
  ["../../src/components/TradeExecutionEventsPanel.vue", 1],
  ["../../src/components/replay/ReplayReviewTimeline.vue", 1],
  ["../../src/components/replay-history/ReplayHistoryDetail.vue", 1],
  ["../../src/components/replay-playbook/ReplayPlaybookList.vue", 1],
  ["../../src/components/replay-playbook/ReplayPlaybookDetail.vue", 2],
];

describe("shared action menu surface", () => {
  it("teleports popovers outside clipping containers and clamps them to the viewport", () => {
    assert.equal(existsSync(actionMenuUrl), true);
    const source = readFileSync(actionMenuUrl, "utf8");
    assert.match(source, /<Teleport to="body">/u);
    assert.match(source, /position:\s*fixed/u);
    assert.match(source, /document\.documentElement\.clientWidth/u);
    assert.match(source, /document\.documentElement\.clientHeight/u);
    assert.match(source, /availableAbove/u);
    assert.match(source, /availableBelow/u);
    assert.match(
      source,
      /min-height:\s*var\(--ui-action-menu-trigger-size\)/u,
    );
  });

  it("routes every ellipsis action menu through the shared popover", () => {
    for (const [relativePath, expectedCount] of menuConsumers) {
      const source = read(relativePath);
      const actualCount = source.match(/<UiActionMenu\b/gu)?.length ?? 0;
      assert.equal(actualCount, expectedCount, relativePath);
    }
  });
});
