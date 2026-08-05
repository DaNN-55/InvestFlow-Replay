import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReplayHistoryScoreDimensions,
  formatReplayCompletionReason,
  formatReplayHistoryIdentity,
  getReplayAttemptPresentation,
  getReplayHistoryStatePresentation,
} from "../../src/utils/replayHistoryPresentation.js";

describe("replay history presentation", () => {
  it("maps every review state to a stable Chinese label", () => {
    assert.deepEqual(
      [
        "active",
        "awaiting_blind",
        "awaiting_reveal",
        "awaiting_post",
        "reviewed",
        "skipped",
      ].map((state) => getReplayHistoryStatePresentation(state).label),
      ["演练中", "待盲评", "待揭晓", "待事后复盘", "已评分", "主动空仓"],
    );
    assert.equal(
      getReplayHistoryStatePresentation("unknown").label,
      "未知状态",
    );
  });

  it("keeps hidden sessions anonymous and revealed sessions identifiable", () => {
    assert.equal(
      formatReplayHistoryIdentity({
        id: "12345678-abcd",
        revealed: false,
      }),
      "匿名演练 · 12345678",
    );
    assert.equal(
      formatReplayHistoryIdentity({
        id: "revealed-id",
        revealed: true,
        reveal: {
          name: "特锐德",
          tsCode: "300001.SZ",
        },
      }),
      "特锐德 · 300001.SZ",
    );
  });

  it("presents replay completion reasons in Chinese", () => {
    assert.equal(formatReplayCompletionReason("early"), "提前交卷");
    assert.equal(formatReplayCompletionReason("natural"), "自然完成");
    assert.equal(formatReplayCompletionReason("no_opportunity"), "无交易机会");
    assert.equal(formatReplayCompletionReason(null), "尚未完成");
  });

  it("treats legacy sessions as first attempts and separates retrain scores", () => {
    assert.deepEqual(getReplayAttemptPresentation(null), {
      kind: "first",
      attemptNumber: 1,
      label: "首次盲测 · 计入首次成绩",
      shortLabel: "首次盲测",
      scoreNote: "计入首次盲测统计",
      countsTowardFirstScore: true,
    });
    assert.deepEqual(
      getReplayAttemptPresentation({
        attemptNumber: 3,
        kind: "retrain",
        countsTowardFirstScore: false,
        sourceSessionId: "source-session",
      }),
      {
        kind: "retrain",
        attemptNumber: 3,
        label: "已知场景复练 · 第 3 次",
        shortLabel: "复练 · 第 3 次",
        scoreNote: "复练成绩，不计入首次盲测统计",
        countsTowardFirstScore: false,
      },
    );
  });

  it("builds the five score dimensions without inventing missing values", () => {
    assert.deepEqual(
      buildReplayHistoryScoreDimensions({
        breakdown: {
          return: 12.5,
          benchmark: 7.5,
          drawdown: 20,
          discipline: 20,
          reviewCompleteness: 15,
        },
      }).map(({ key, label, value, maximum }) => ({
        key,
        label,
        value,
        maximum,
      })),
      [
        { key: "return", label: "收益表现", value: 12.5, maximum: 25 },
        { key: "benchmark", label: "基准表现", value: 7.5, maximum: 15 },
        { key: "drawdown", label: "回撤控制", value: 20, maximum: 20 },
        { key: "discipline", label: "执行纪律", value: 20, maximum: 25 },
        {
          key: "reviewCompleteness",
          label: "复盘完整度",
          value: 15,
          maximum: 15,
        },
      ],
    );
    assert.deepEqual(buildReplayHistoryScoreDimensions(null), []);
  });

  it("supports the v2 risk and playbook dimensions", () => {
    const dimensions = buildReplayHistoryScoreDimensions({
      algorithmVersion: "replay-score-v2",
      breakdown: {
        executionDiscipline: 24,
        riskControl: 20,
        playbookCompliance: null,
        returnPerformance: 12,
        reviewQuality: 8,
      },
      applicability: {
        playbookCompliance: {
          applicable: false,
          reason: "自由演练不评价战法符合度",
        },
      },
    });

    assert.deepEqual(
      dimensions.map(({ key, label, maximum, applicable }) => ({
        key,
        label,
        maximum,
        applicable,
      })),
      [
        {
          key: "executionDiscipline",
          label: "执行纪律",
          maximum: 30,
          applicable: true,
        },
        {
          key: "riskControl",
          label: "风险控制",
          maximum: 25,
          applicable: true,
        },
        {
          key: "playbookCompliance",
          label: "战法符合度",
          maximum: 20,
          applicable: false,
        },
        {
          key: "returnPerformance",
          label: "收益表现",
          maximum: 15,
          applicable: true,
        },
        {
          key: "reviewQuality",
          label: "复盘质量",
          maximum: 10,
          applicable: true,
        },
      ],
    );
  });
});
