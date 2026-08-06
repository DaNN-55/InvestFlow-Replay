import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReplayScoreDimensions,
  buildReplayScoreMetrics,
  buildReplayScoreWeightSnapshot,
  formatReplayScoreMetric,
  isReplayPlaybookComplianceApplicable,
} from "../../src/utils/replayScorePresentation.js";

const v2ScoreCard = {
  algorithmVersion: "replay-score-v2",
  weights: {
    executionDiscipline: 30,
    riskControl: 25,
    playbookCompliance: 20,
    returnPerformance: 15,
    reviewQuality: 10,
  },
  breakdown: {
    executionDiscipline: 24,
    riskControl: 20,
    playbookCompliance: null,
    returnPerformance: 12,
    reviewQuality: 8,
  },
  applicability: {
    executionDiscipline: { applicable: true, reason: null },
    riskControl: { applicable: true, reason: null },
    playbookCompliance: {
      applicable: false,
      reason: "free_training",
    },
    returnPerformance: { applicable: true, reason: null },
    reviewQuality: { applicable: true, reason: null },
  },
  metrics: {
    totalReturnPct: 8.25,
    maxDrawdownPct: 3.5,
    totalTradingCosts: 123.45,
    realizedPnl: 8000,
    unrealizedPnl: -250,
    endingCapitalUtilizationPct: 50,
    averageCapitalUtilizationPct: 42.5,
    maxCapitalUtilizationPct: 80,
    stockBuyAndHoldReturnPct: 5,
    strategyVsStockBuyAndHoldPct: 3.25,
    indexBenchmarkReturnPct: null,
    indexExcessReturnPct: null,
    indexBenchmarkStatus: "unavailable",
  },
};

describe("replay score presentation", () => {
  it("presents v2 dimensions and preserves an inapplicable playbook score", () => {
    const dimensions = buildReplayScoreDimensions(v2ScoreCard);
    assert.ok(dimensions.every((dimension) => dimension.description));
    assert.deepEqual(dimensions.map((dimension) => {
      const comparable = { ...dimension };
      delete comparable.description;
      delete comparable.explain;
      return comparable;
    }), [
      {
        key: "executionDiscipline",
        label: "执行纪律",
        maximum: 30,
        value: 24,
        applicable: true,
        reason: null,
      },
      {
        key: "riskControl",
        label: "风险控制",
        maximum: 25,
        value: 20,
        applicable: true,
        reason: null,
      },
      {
        key: "playbookCompliance",
        label: "战法符合度",
        maximum: 20,
        value: null,
        applicable: false,
        reason: "自由演练不评价战法符合度",
      },
      {
        key: "returnPerformance",
        label: "收益表现",
        maximum: 15,
        value: 12,
        applicable: true,
        reason: null,
      },
      {
        key: "reviewQuality",
        label: "复盘质量",
        maximum: 10,
        value: 8,
        applicable: true,
        reason: null,
      },
    ]);
  });

  it("keeps the legacy five dimensions compatible", () => {
    assert.deepEqual(
      buildReplayScoreDimensions({
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
  });

  it("presents every v2 metric and explicit unavailable index copy", () => {
    const metrics = buildReplayScoreMetrics(v2ScoreCard);
    assert.ok(metrics.every((metric) => metric.description));
    assert.deepEqual(
      metrics.map((metric) => metric.key),
      [
        "totalReturnPct",
        "stockBuyAndHoldReturnPct",
        "strategyVsStockBuyAndHoldPct",
        "maxDrawdownPct",
        "realizedPnl",
        "unrealizedPnl",
        "totalTradingCosts",
        "endingCapitalUtilizationPct",
        "averageCapitalUtilizationPct",
        "maxCapitalUtilizationPct",
        "indexBenchmarkReturnPct",
        "indexExcessReturnPct",
      ],
    );
    assert.equal(formatReplayScoreMetric(metrics[0]), "+8.25%");
    assert.equal(formatReplayScoreMetric(metrics[4]), "+¥8000.00");
    assert.equal(formatReplayScoreMetric(metrics[5]), "-¥250.00");
    assert.equal(
      formatReplayScoreMetric(
        metrics.find((metric) => metric.key === "indexBenchmarkReturnPct"),
      ),
      "暂无指数数据",
    );
    assert.equal(
      formatReplayScoreMetric(
        metrics.find((metric) => metric.key === "indexExcessReturnPct"),
      ),
      "暂无指数数据",
    );
  });

  it("marks only concepts that need extra explanation", () => {
    const dimensions = buildReplayScoreDimensions(v2ScoreCard);
    const metrics = buildReplayScoreMetrics(v2ScoreCard);

    assert.deepEqual(
      dimensions.filter((dimension) => dimension.explain).map((dimension) => dimension.key),
      ["playbookCompliance"],
    );
    assert.deepEqual(
      metrics.filter((metric) => metric.explain).map((metric) => metric.key),
      [
        "stockBuyAndHoldReturnPct",
        "strategyVsStockBuyAndHoldPct",
        "maxDrawdownPct",
        "endingCapitalUtilizationPct",
        "averageCapitalUtilizationPct",
        "maxCapitalUtilizationPct",
        "indexBenchmarkReturnPct",
        "indexExcessReturnPct",
      ],
    );
    assert.equal(
      metrics.find((metric) => metric.key === "totalReturnPct").explain,
      false,
    );
    assert.equal(
      metrics.find((metric) => metric.key === "totalTradingCosts").explain,
      false,
    );
  });

  it("builds an immutable weight snapshot including applicability", () => {
    const weightSnapshot = buildReplayScoreWeightSnapshot(v2ScoreCard);
    assert.ok(weightSnapshot.every((entry) => entry.description));
    assert.deepEqual(weightSnapshot.map((entry) => {
      const comparable = { ...entry };
      delete comparable.description;
      return comparable;
    }), [
      {
        key: "executionDiscipline",
        label: "执行纪律",
        weight: 30,
        applicable: true,
      },
      {
        key: "riskControl",
        label: "风险控制",
        weight: 25,
        applicable: true,
      },
      {
        key: "playbookCompliance",
        label: "战法符合度",
        weight: 20,
        applicable: false,
      },
      {
        key: "returnPerformance",
        label: "收益表现",
        weight: 15,
        applicable: true,
      },
      {
        key: "reviewQuality",
        label: "复盘质量",
        weight: 10,
        applicable: true,
      },
    ]);
  });

  it("maps every backend applicability reason to user-facing Chinese", () => {
    const reasons = [
      ["free_training", "自由演练不评价战法符合度"],
      ["blank_playbook", "战法版本内容为空，不评价战法符合度"],
      ["legacy_missing_input", "旧记录缺少该评分输入"],
      ["future_internal_code", "该维度不适用"],
    ];

    for (const [reason, expected] of reasons) {
      const [dimension] = buildReplayScoreDimensions({
        algorithmVersion: "replay-score-v2",
        breakdown: { executionDiscipline: null },
        applicability: {
          executionDiscipline: { applicable: false, reason },
        },
      });
      assert.equal(dimension.reason, expected);
    }
  });

  it("uses history score applicability when the API omits playbook content", () => {
    const apiHistoryItem = {
      trainingConfig: {
        mode: "playbook",
        playbookId: "playbook-1",
        playbookVersionId: "version-1",
      },
      postReview: {
        playbookFitScore: 4,
      },
      scoreCard: {
        applicability: {
          playbookCompliance: {
            applicable: true,
            reason: null,
          },
        },
      },
    };

    assert.equal(
      isReplayPlaybookComplianceApplicable(apiHistoryItem),
      true,
    );
    assert.equal(
      isReplayPlaybookComplianceApplicable({
        ...apiHistoryItem,
        postReview: {},
        scoreCard: {
          applicability: {
            playbookCompliance: {
              applicable: false,
              reason: "blank_playbook",
            },
          },
        },
      }),
      false,
    );
    assert.equal(
      isReplayPlaybookComplianceApplicable({
        postReview: { playbookFitScore: 3 },
      }),
      true,
    );
  });
});
