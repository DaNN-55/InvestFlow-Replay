import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDiagnosisSnapshotSections,
  buildTradeReviewOverview,
} from "../../src/utils/tradeRecordPresentation.js";

function itemValue(section, label) {
  return section.items.find((item) => item.label === label)?.value;
}

describe("buildDiagnosisSnapshotSections", () => {
  it("presents frozen candidate, mode, objective evidence, and conclusion without legacy market hypotheses", () => {
    const snapshot = {
      candidateContext: {
        source: "market_scan",
        scanTradeDate: "20260710",
        sectorType: "ths_industry",
        sectorName: "航天装备",
        candidateRole: "连板龙头",
        strategy: "强势延续（复核）",
        mainlineScore: "72.73",
        leaderScore: "85",
      },
      recommendedModeId: "trend",
      selectedModeId: "leader_relay",
      selectionMismatch: true,
      modeAssessments: [
        {
          modeId: "leader_relay",
          modeName: "龙头接力",
          stage: "分歧确认",
          readiness: "waiting",
          evidence: ["市场阶段 strong_flat 支持短线接力观察", "5 日内出现 3 次涨停"],
          counterEvidence: ["尚未重新转强"],
          missingData: ["封单金额"],
        },
        { modeId: "trend", modeName: "趋势突破", stage: "趋势运行", readiness: "confirmed" },
      ],
      tradingPlan: {
        actionLabel: "继续观察",
        initialPositionPct: 5,
        maxPositionPct: 10,
        exitConditions: ["跌破关键支撑则退出"],
      },
      newsSummary: {
        trendLabel: "风险发酵",
        adjustment: -15,
        negative: 3,
        total: 5,
        scoreDetails: [
          {
            title: "公司提示盈利质量风险",
            reason: "命中高风险关键词",
            source: "证券时报",
          },
        ],
      },
      marketDiscipline: "strong_flat",
      capitalBehaviorHypothesis: { label: "试盘观察" },
    };
    const record = {
      evaluationSnapshot: {
        technical: {
          trend: { label: "均线缠绕" },
          volume: { label: "放量上涨" },
        },
        capitalFlow: {
          input: {
            averageAmount20dYi: 11.84,
            amountRatio: 2.29,
            turnoverRate: 26.21,
            closePositionInRange: 0.55,
          },
          meta: { missingFields: ["tailSessionReturn"] },
        },
      },
    };

    const sections = buildDiagnosisSnapshotSections(snapshot, record);

    assert.deepEqual(sections.map((section) => section.key), ["source", "mode", "evidence", "conclusion"]);
    assert.equal(itemValue(sections[0], "来源"), "市场扫描");
    assert.equal(itemValue(sections[0], "板块类型"), "同花顺行业");
    assert.equal(itemValue(sections[1], "选择模式"), "龙头接力");
    assert.equal(itemValue(sections[1], "系统首选"), "趋势突破");
    assert.equal(sections[1].notes[0], "5 日内出现 3 次涨停");
    assert.equal(sections[1].notes[1], "风险：尚未重新转强");
    assert.equal(itemValue(sections[2], "成交放大"), "2.29 倍");
    assert.equal(itemValue(sections[3], "诊断动作"), undefined);
    assert.equal(itemValue(sections[3], "诊断首仓"), undefined);
    assert.equal(itemValue(sections[3], "诊断上限"), undefined);
    assert.ok(sections[3].notes.some((note) => note.includes("公司提示盈利质量风险")));
    assert.ok(sections.every((section) => !["市场纪律", "资金行为假设"].includes(section.title)));
    assert.ok(sections[1].notes.every((note) => !note.includes("市场阶段") && !note.includes("strong_flat")));
    assert.ok(sections.flatMap((section) => section.notes).every((note) => !note.includes("title:")));
  });

  it("labels diagnoses without a frozen scan context as independent", () => {
    const sections = buildDiagnosisSnapshotSections({ tradingPlan: { actionLabel: "暂不复核" } }, {});

    assert.equal(itemValue(sections[0], "来源"), "独立诊断");
  });
});

describe("buildTradeReviewOverview", () => {
  it("compares a completed trade with its license instead of duplicating the diagnosis snapshot", () => {
    const overview = buildTradeReviewOverview({
      stage: "reviewed",
      form: {
        plannedEntryLow: "10",
        plannedEntryHigh: "10.5",
        triggerPrice: "10",
        noChasePrice: "10.5",
        failurePrice: "9.5",
        targetPrice: "12",
        plannedQuantity: "1000",
        estimatedMaxLossAmount: "500",
        actualEntryDate: "2026-07-10",
        actualEntryPrice: "10.6",
        actualEntryQuantity: "1200",
        actualExitDate: "2026-07-13",
        actualExitPrice: "9.8",
        actualExitQuantity: "1200",
        exitSignalType: "failure",
        exitReason: "触发失败价",
        t1Review: "走势弱于预期",
      },
      record: {},
      snapshot: { tradingPlan: { actionLabel: "观察后介入" } },
      violations: [],
    });

    assert.equal(overview.title, "交易复盘总览");
    assert.deepEqual(overview.sections.map((section) => section.key), ["license", "execution", "deviation"]);
    assert.ok(overview.sections[2].rows.some((row) => row.label === "入场价格" && row.value === "超过不追价"));
    assert.ok(overview.sections[2].rows.some((row) => row.label === "买入数量" && row.value.includes("超计划")));
    assert.ok(overview.sections.every((section) => section.title !== "初始判断"));
    assert.ok(overview.metrics.some((metric) => metric.label === "计划执行度" && metric.value === "2 项偏差"));
  });

  it("does not treat a legacy subjective trade without a license baseline as execution violations", () => {
    const overview = buildTradeReviewOverview({
      stage: "reviewed",
      form: {
        actualEntryDate: "2026-07-06",
        actualEntryPrice: "15.41",
        actualEntryQuantity: "100",
        actualExitDate: "2026-07-07",
        actualExitPrice: "14.95",
        actualExitQuantity: "100",
      },
      record: { tradeType: "subjective" },
      snapshot: { tradingPlan: { actionLabel: "继续观察" } },
      violations: [],
    });

    assert.ok(overview.metrics.some((metric) => metric.label === "计划执行度" && metric.value === "无法核对"));
    assert.ok(overview.sections[0].rows.some((row) => row.label === "许可证状态" && row.value === "无许可记录"));
    assert.ok(overview.sections[2].rows.some((row) => row.label === "入场价格" && row.value === "无许可基准"));
    assert.ok(overview.sections[2].rows.some((row) => row.label === "买入数量" && row.value === "无许可基准"));
    assert.ok(overview.sections.flatMap((section) => section.rows).every((row) => row.label !== "诊断动作"));
    assert.ok(overview.sections.flatMap((section) => section.rows).every((row) => row.value !== "-"));
  });

  it("uses a cancellation summary without empty profit cards", () => {
    const overview = buildTradeReviewOverview({
      stage: "cancelled",
      form: {
        plannedEntryLow: "15",
        plannedEntryHigh: "15.66",
        triggerPrice: "15",
        noChasePrice: "15.66",
        entryNotes: "竞价低于预期，取消计划",
      },
      record: {},
      snapshot: {},
      violations: [],
    });

    assert.equal(overview.title, "取消复盘");
    assert.ok(overview.metrics.every((metric) => metric.value !== "--"));
    assert.deepEqual(overview.sections.map((section) => section.key), ["license", "cancellation"]);
    assert.ok(overview.sections[1].rows.some((row) => row.label === "取消原因" && row.value.includes("竞价低于预期")));
  });

  it("uses plan verification copy before an entry is recorded", () => {
    const overview = buildTradeReviewOverview({
      stage: "planned",
      form: {
        plannedEntryLow: "10",
        plannedEntryHigh: "10.5",
        plannedQuantity: "1000",
        estimatedMaxLossAmount: "500",
      },
      record: { licenseSnapshot: { issuedAt: "2026-07-13T05:00:00.000Z" } },
      snapshot: {},
      violations: [],
    });

    assert.equal(overview.title, "计划核对");
    assert.ok(overview.description.includes("买入许可证"));
    assert.ok(overview.metrics.every((metric) => metric.value !== "--"));
  });

  it("uses pending labels instead of empty metrics for an unfinished draft", () => {
    const overview = buildTradeReviewOverview({
      stage: "draft",
      form: {},
      record: {},
      snapshot: {},
      violations: [],
    });

    assert.ok(overview.metrics.every((metric) => metric.value !== "--"));
  });
});
