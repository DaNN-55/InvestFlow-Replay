import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReplayReviewCorrectionPayload,
  buildReplayReviewTimeline,
  getLatestReplayReviewSnapshot,
} from "../../src/utils/replayReviewCorrections.js";

const blindReview = {
  strategyName: "龙头战法",
  thesis: "原始核心判断内容足够长",
  tradePlan: "原始交易计划内容足够长",
  riskPlan: "原始风险计划内容足够长",
  confidence: 3,
  reasonTags: ["趋势", "量价"],
  stopLossPrice: 9.8,
  invalidationRule: {
    basis: "close",
    operator: "lte",
    threshold: 9.5,
    note: "收盘破位",
  },
};
const postReview = {
  outcome: "partial",
  executionReview: "原始执行复盘内容足够长",
  mistakes: "追高",
  lessons: "原始经验总结内容足够长",
  disciplineScore: 3,
  riskControlScore: 2,
  strategyAdjustment: "",
};
const corrections = [
  {
    id: "blind-correction-1",
    stage: "blind",
    revisionNumber: 1,
    fullReviewSnapshot: {
      ...blindReview,
      strategyName: "修正后关联的战法",
      confidence: 4,
    },
    changeNote: "补充当时遗漏的量能判断",
    createdAt: "2026-07-30T08:00:00.000Z",
  },
  {
    id: "post-correction-1",
    stage: "post",
    revisionNumber: 1,
    fullReviewSnapshot: { ...postReview, riskControlScore: 4 },
    changeNote: "重新核对止损执行记录",
    createdAt: "2026-07-30T09:00:00.000Z",
  },
];

describe("replay review corrections presentation", () => {
  it("keeps the original review and every correction in one timeline", () => {
    const stages = buildReplayReviewTimeline({
      blindReview,
      postReview,
      corrections,
      revealed: true,
    });

    assert.deepEqual(
      stages.map((stage) => ({
        stage: stage.stage,
        titles: stage.entries.map((entry) => entry.title),
      })),
      [
        {
          stage: "blind",
          titles: ["原始盲评", "第 1 次修正"],
        },
        {
          stage: "post",
          titles: ["原始事后复盘", "第 1 次修正"],
        },
      ],
    );
    assert.equal(
      stages[1].entries[1].changeNote,
      "重新核对止损执行记录",
    );
  });

  it("never exposes post-review originals or corrections before reveal", () => {
    const stages = buildReplayReviewTimeline({
      blindReview,
      postReview,
      corrections,
      revealed: false,
    });

    assert.deepEqual(stages.map((stage) => stage.stage), ["blind"]);
    assert.doesNotMatch(JSON.stringify(stages), /重新核对止损执行记录/u);
  });

  it("can show only appended corrections when originals are already displayed", () => {
    const stages = buildReplayReviewTimeline({
      blindReview,
      postReview,
      corrections,
      revealed: true,
      includeOriginal: false,
    });

    assert.deepEqual(
      stages.map((stage) => ({
        stage: stage.stage,
        titles: stage.entries.map((entry) => entry.title),
      })),
      [
        { stage: "blind", titles: ["第 1 次修正"] },
        { stage: "post", titles: ["第 1 次修正"] },
      ],
    );
    assert.deepEqual(
      buildReplayReviewTimeline({
        blindReview,
        postReview,
        corrections: [],
        revealed: true,
        includeOriginal: false,
      }),
      [],
    );
  });

  it("prefills from the latest same-stage correction with original fallback", () => {
    const effectiveBlindReview = getLatestReplayReviewSnapshot({
      stage: "blind",
      originalReview: blindReview,
      corrections,
    });
    assert.equal(effectiveBlindReview.strategyName, "修正后关联的战法");
    assert.equal(effectiveBlindReview.confidence, 4);
    assert.equal(
      getLatestReplayReviewSnapshot({
        stage: "post",
        originalReview: postReview,
        corrections: [],
      }),
      postReview,
    );
  });

  it("whitelists a linked blind correction without leaking display metadata", () => {
    const payload = buildReplayReviewCorrectionPayload({
      stage: "blind",
      snapshot: {
        ...blindReview,
        playbookId: "playbook-1",
        playbookVersionId: "version-1",
        playbookVersionNumber: 7,
        createdAt: "2026-07-30T08:00:00.000Z",
      },
      form: {
        ...blindReview,
        playbookId: "playbook-1",
        playbookVersionId: "version-1",
        invalidationEnabled: true,
        invalidationOperator: "lte",
        invalidationThreshold: 9.5,
        invalidationNote: "收盘破位",
        changeNote: " 修正对战法条件的描述 ",
      },
    });

    assert.deepEqual(payload, {
      strategyName: "龙头战法",
      playbookId: "playbook-1",
      playbookVersionId: "version-1",
      thesis: "原始核心判断内容足够长",
      tradePlan: "原始交易计划内容足够长",
      riskPlan: "原始风险计划内容足够长",
      confidence: 3,
      reasonTags: ["趋势", "量价"],
      stopLossPrice: 9.8,
      invalidationRule: {
        basis: "close",
        operator: "lte",
        threshold: 9.5,
        note: "收盘破位",
      },
      changeNote: "修正对战法条件的描述",
    });
    assert.equal("playbookVersionNumber" in payload, false);
    assert.equal("createdAt" in payload, false);
  });

  it("allows a blind correction to remove a mistaken playbook link", () => {
    const payload = buildReplayReviewCorrectionPayload({
      stage: "blind",
      snapshot: { ...blindReview, playbookId: "wrong", playbookVersionId: "wrong-v1" },
      form: { ...blindReview, playbookId: "", playbookVersionId: "", changeNote: "解除误关联" },
    });
    assert.equal("playbookId" in payload, false);
    assert.equal("playbookVersionId" in payload, false);
  });

  it("marks new blind fields as unrecorded for legacy reviews", () => {
    const [stage] = buildReplayReviewTimeline({
      blindReview: {
        strategyName: "旧战法",
        thesis: "旧记录的核心判断",
        tradePlan: "旧记录的交易计划",
        riskPlan: "旧记录的风险计划",
        confidence: 3,
      },
      revealed: false,
    });
    const values = Object.fromEntries(
      stage.entries[0].fields.map((field) => [field.label, field.value]),
    );

    assert.equal(values.判断理由, "未记录");
    assert.equal("止损价" in values, false);
    assert.equal("判断失效条件" in values, false);
  });
});
