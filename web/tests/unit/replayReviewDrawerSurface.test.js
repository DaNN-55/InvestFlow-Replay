import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const viewSource = readSource("../../src/views/MarketReplayView.vue");
const reviewSource = readSource(
  "../../src/components/replay/ReplayReviewPanel.vue",
);

describe("replay review drawer surface", () => {
  it("opens the two-stage review in a right drawer", () => {
    assert.match(viewSource, /import UiDrawer/u);
    assert.match(viewSource, /<UiDrawer[\s\S]*?:open="reviewDialogOpen"/u);
    assert.match(viewSource, /overlay-tone="transparent"/u);
    assert.match(
      viewSource,
      /\.market-replay-review-drawer[\s\S]*?width: min\(430px, calc\(100vw - 32px\)\)/u,
    );
    assert.doesNotMatch(viewSource, /import UiModal/u);
  });

  it("stacks the two review stages and omits the timeline in the drawer", () => {
    assert.match(
      reviewSource,
      /\.replay-review--modal \.replay-review__revealed[\s\S]*?grid-template-columns: 1fr/u,
    );
    assert.match(
      reviewSource,
      /<ReplayReviewTimeline\s+v-if="!modal"\s+editable\s+class="replay-review__timeline"[\s\S]*?:post-review="postReview"/u,
    );
    assert.match(
      reviewSource,
      /<ReplayReviewTimeline\s+v-if="!modal"\s+editable\s+:blind-review="blindReview"/u,
    );
  });

  it("restores drafts through the draft interface without a second server synchronization path", () => {
    assert.match(viewSource, /:draft-stages="review\.stages"/u);
    assert.match(reviewSource, /props\.reviewDrafts\?\.blind/u);
    assert.match(reviewSource, /props\.reviewDrafts\?\.post/u);
    assert.match(reviewSource, /draftStages\.blind\.restoreToken/u);
    assert.doesNotMatch(reviewSource, /props\.session\.reviewDrafts/u);
  });
});
