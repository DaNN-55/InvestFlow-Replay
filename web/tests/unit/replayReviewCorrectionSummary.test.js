import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const reviewSource = readFileSync(
  new URL(
    "../../src/components/replay/ReplayReviewPanel.vue",
    import.meta.url,
  ),
  "utf8",
);

describe("replay review correction summary", () => {
  it("shows the latest blind-review correction in the revealed summary", () => {
    assert.match(
      reviewSource,
      /const currentBlindReview = computed\(\(\) =>[\s\S]*?stage: "blind"/u,
    );
    assert.match(reviewSource, /\{\{ currentBlindReview\.thesis \}\}/u);
    assert.match(reviewSource, /当前盲评修正版/u);
  });

  it("shows the latest post-review correction in the revealed summary", () => {
    assert.match(
      reviewSource,
      /const currentPostReview = computed\(\(\) =>[\s\S]*?stage: "post"/u,
    );
    assert.match(reviewSource, /\{\{ currentPostReview\.executionReview \}\}/u);
    assert.match(reviewSource, /当前事后复盘修正版/u);
  });

  it("keeps the original review and first score as immutable audit records", () => {
    assert.match(reviewSource, /原始盲评和首次评分均已冻结/u);
    assert.match(reviewSource, /:blind-review="blindReview"/u);
  });
});
