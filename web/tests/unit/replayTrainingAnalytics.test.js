import assert from "node:assert/strict";
import test from "node:test";
import { formatTrainingMetric, trainingBucketWidth, trainingCohortLabel, trainingSampleDate, REPLAY_ISSUE_TAGS } from "../../src/utils/replayTrainingAnalytics.js";
import { buildReplayReviewCorrectionPayload, getLatestReplayReviewSnapshot } from "../../src/utils/replayReviewCorrections.js";

test("training analysis distinguishes no sample from zero returns and labels cohorts by actual sample size", () => {
  assert.equal(formatTrainingMetric(null), "—");
  assert.equal(formatTrainingMetric(0), "0.00%");
  assert.equal(formatTrainingMetric(-1.25), "-1.25%");
  assert.equal(trainingCohortLabel({ n: 0 }), "暂无样本");
  assert.equal(trainingCohortLabel({ n: 3, from: "2026-10-01", to: "2026-10-20" }), "2026-10-01 至 2026-10-20 · 3 次");
  assert.equal(trainingSampleDate("2026-10-19T17:00:00Z"), "2026-10-20");
  assert.equal(trainingSampleDate(null), "—");
  assert.equal(trainingBucketWidth(0, 0), "0%");
  assert.equal(trainingBucketWidth(2, 4), "50%");
});

test("confirmed issue tags can be cleared by correction without overwriting original review", () => {
  const original = { outcome: "partial", issueTags: ["追涨"], mistakes: "旧问题" };
  const form = { outcome: "partial", issueTags: [], executionReview: "保留执行过程记录", mistakes: "修正问题", lessons: "复盘后补充经验并保留原记录", disciplineScore: 3, riskControlScore: 4, changeNote: "重新确认" };
  const payload = buildReplayReviewCorrectionPayload({ stage: "post", form, snapshot: original, playbookFitApplicable: false });
  assert.deepEqual(payload.issueTags, []);
  const corrected = getLatestReplayReviewSnapshot({ stage: "post", originalReview: original, corrections: [{ stage: "post", fullReviewSnapshot: payload }] });
  assert.deepEqual(corrected.issueTags, []);
  assert.deepEqual(original.issueTags, ["追涨"]);
  assert.deepEqual(REPLAY_ISSUE_TAGS, ["提前入场", "追涨", "仓位过大", "退出犹豫", "偏离计划", "无明确依据"]);
});
