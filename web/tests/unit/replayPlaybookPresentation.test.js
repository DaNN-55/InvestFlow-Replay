import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCandidateVersionDraft,
  getCandidateSessionId,
  getCandidateStatusPresentation,
  getCandidateSuggestion,
  getPlaybookVersionNumber,
  formatPlaybookTime,
} from "../../src/utils/replayPlaybookPresentation.js";

describe("replay playbook presentation", () => {
  it("builds an editable full version draft from current content and suggestion", () => {
    const draft = buildCandidateVersionDraft(
      {
        currentVersion: {
          versionNumber: 3,
          content: "规则一：只做主线。",
        },
      },
      {
        suggestion: "增加退潮期空仓条件。",
      },
    );

    assert.equal(draft.expectedVersionNumber, 3);
    assert.match(draft.content, /规则一：只做主线/u);
    assert.match(draft.content, /候选改进：\n增加退潮期空仓条件/u);
    assert.match(draft.changeSummary, /采纳源演练候选/u);
  });

  it("normalizes version, candidate state and source session fields", () => {
    assert.equal(
      getPlaybookVersionNumber({ currentVersion: { versionNumber: 2 } }),
      2,
    );
    assert.deepEqual(getCandidateStatusPresentation("accepted"), {
      label: "已采纳",
      tone: "success",
    });
    assert.equal(getCandidateSuggestion({ suggestion: "补充风控" }), "补充风控");
    assert.equal(getCandidateSessionId({ sessionId: "session-1" }), "session-1");
    assert.equal(formatPlaybookTime("2026-08-05T09:06:38.442Z"), "2026/08/05");
  });
});
