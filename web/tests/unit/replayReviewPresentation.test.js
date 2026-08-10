import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReplayBlindReviewPayload } from "../../src/utils/replayReviewPresentation.js";
import * as replayReviewPresentation from "../../src/utils/replayReviewPresentation.js";

describe("replay blind review payload", () => {
  it("uses decision reasons that match the buy or sell direction", () => {
    assert.deepEqual(replayReviewPresentation.REPLAY_BUY_REASON_TAG_OPTIONS, [
      "趋势",
      "突破",
      "回踩",
      "量价",
      "情绪",
      "基本面",
      "风险",
    ]);
    assert.deepEqual(replayReviewPresentation.REPLAY_SELL_REASON_TAG_OPTIONS, [
      "触发止损",
      "触发止盈",
      "逻辑失效",
      "趋势转弱",
      "量价异常",
      "仓位调整",
      "纪律退出",
    ]);
  });

  it("only enables the trading-desk review entry after the answer is revealed", () => {
    assert.deepEqual(
      replayReviewPresentation.getReplayReviewEntryState?.({ revealed: false }),
      {
        available: false,
        label: "揭晓后查看复盘",
      },
    );
    assert.deepEqual(
      replayReviewPresentation.getReplayReviewEntryState?.({ revealed: true }),
      {
        available: true,
        label: "查看复盘",
      },
    );
  });

  it("prefills the whole-session blind review from the latest buy decision", () => {
    assert.deepEqual(
      replayReviewPresentation.buildReplayBlindReviewPrefill?.({
        executions: [
          {
            side: "buy",
            sequence: 3,
            decision: {
              reasonTags: ["趋势"],
              confidence: 3,
              thesis: "较早的买入判断",
              plan: "较早的买入计划",
              riskPlan: "较早的风险计划",
            },
          },
          {
            side: "sell",
            sequence: 8,
            decision: { thesis: "卖出判断不用于整局买入前提" },
          },
        ],
        pendingOrders: [
          {
            side: "buy",
            scheduledSequence: 6,
            decision: {
              reasonTags: ["回踩", "量价", "回踩"],
              confidence: 4,
              thesis: " 最近一次买入判断 ",
              plan: " 最近一次买入计划 ",
              riskPlan: " 最近一次风险计划 ",
              stopLossPrice: 9.8,
              invalidationRule: {
                basis: "close",
                operator: "lte",
                threshold: 9.5,
                note: "收盘跌破结构低点",
              },
            },
          },
        ],
      }),
      {
        reasonTags: ["回踩", "量价"],
        confidence: 4,
        thesis: "最近一次买入判断",
        tradePlan: "最近一次买入计划",
        riskPlan: "最近一次风险计划",
        stopLossPrice: 9.8,
        invalidationRule: {
          basis: "close",
          operator: "lte",
          threshold: 9.5,
          note: "收盘跌破结构低点",
        },
      },
    );
  });

  it("builds a buy order with its own normalized decision snapshot", () => {
    const payload = replayReviewPresentation.buildReplayOrderSubmission?.({
      side: "buy",
      inputMode: "shares",
      quantity: "200",
      reasonTags: ["趋势", "趋势", "量价"],
      confidence: "4",
      thesis: " 趋势重新转强，量价配合，计划在下一开盘试仓。 ",
      plan: " 首次买入两百股，确认走势后再决定是否加仓。 ",
      riskPlan: " 跌破最近结构低点说明判断错误，执行止损。 ",
      stopLossPrice: "9.80",
      invalidationEnabled: false,
    });

    assert.deepEqual(payload, {
      side: "buy",
      quantity: 200,
      decision: {
        reasonTags: ["趋势", "量价"],
        confidence: 4,
        thesis: "趋势重新转强，量价配合，计划在下一开盘试仓。",
        plan: "首次买入两百股，确认走势后再决定是否加仓。",
        riskPlan: "跌破最近结构低点说明判断错误，执行止损。",
        stopLossPrice: 9.8,
        invalidationRule: null,
      },
    });
  });

  it("builds a sell order with sell-specific reasoning", () => {
    const payload = replayReviewPresentation.buildReplayOrderSubmission?.({
      side: "sell",
      inputMode: "ratio",
      ratio: "0.5",
      reasonTags: ["风险"],
      confidence: "3",
      thesis: " 原有上涨逻辑减弱，先降低持仓风险。 ",
      plan: " 卖出一半仓位，等待后续价格确认。 ",
      exitType: "reduce_risk",
      remainingPositionPlan: " 剩余仓位跌破防守位全部退出。 ",
    });

    assert.deepEqual(payload, {
      side: "sell",
      positionRatio: 0.5,
      decision: {
        reasonTags: ["风险"],
        confidence: 3,
        thesis: "原有上涨逻辑减弱，先降低持仓风险。",
        plan: "卖出一半仓位，等待后续价格确认。",
        exitType: "reduce_risk",
        remainingPositionPlan: "剩余仓位跌破防守位全部退出。",
      },
    });
  });

  it("submits the current structured final fields without prediction inputs", () => {
    assert.deepEqual(
      buildReplayBlindReviewPayload({
        playbookId: "playbook-1",
        playbookVersionId: "version-2",
        strategyName: " 龙头战法 ",
        thesis: " 核心判断 ",
        tradePlan: " 交易计划 ",
        riskPlan: " 风险计划 ",
        confidence: "4",
        reasonTags: ["趋势", "突破", "趋势"],
        stopLossPrice: "9.80",
        invalidationRule: {
          basis: "close",
          operator: "lte",
          threshold: "9.50",
          note: " 收盘破位 ",
        },
      }),
      {
        playbookId: "playbook-1",
        playbookVersionId: "version-2",
        strategyName: "龙头战法",
        thesis: "核心判断",
        tradePlan: "交易计划",
        riskPlan: "风险计划",
        confidence: 4,
        reasonTags: ["趋势", "突破"],
        stopLossPrice: 9.8,
        invalidationRule: {
          basis: "close",
          operator: "lte",
          threshold: 9.5,
          note: "收盘破位",
        },
      },
    );
  });

  it("omits an unfinished invalidation threshold from autosave drafts", () => {
    const payload = buildReplayBlindReviewPayload({
      strategyName: "",
      thesis: "",
      tradePlan: "",
      riskPlan: "",
      confidence: 3,
      reasonTags: [],
      stopLossPrice: "",
      invalidationRule: {
        basis: "close",
        operator: "lte",
        threshold: "",
        note: "等待补价格",
      },
    });

    assert.deepEqual(payload.invalidationRule, {
      basis: "close",
      operator: "lte",
      note: "等待补价格",
    });
  });
});
