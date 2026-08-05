import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as presentation from "../../src/utils/tradeRecordPresentation.js";

describe("standalone trade record creation", () => {
  it("builds a flexible draft without diagnosis data", () => {
    const payload = presentation.buildStandaloneTradeRecordPayload?.({
      stockCode: " 600519 ",
      stockName: " 贵州茅台 ",
      accountType: "live",
      tradeType: "subjective",
      strategyProfile: {
        key: "custom",
        name: " 趋势回调 ",
        version: " v2 ",
        summary: "",
        entryRules: "",
        exitRules: "",
        riskRules: "",
      },
    });

    assert.deepEqual(payload, {
      stockCode: "600519",
      stockName: "贵州茅台",
      accountType: "live",
      tradeType: "subjective",
      status: "draft",
      strategyProfile: {
        key: "custom",
        name: "趋势回调",
        version: "v2",
        summary: "",
        entryRules: "",
        exitRules: "",
        riskRules: "",
      },
    });
  });

  it("omits an empty optional strategy profile", () => {
    const payload = presentation.buildStandaloneTradeRecordPayload?.({
      stockCode: "002829",
      stockName: "星网宇达",
      accountType: "simulated",
      tradeType: "system",
      strategyProfile: { name: "" },
    });

    assert.equal(payload.strategyProfile, null);
  });
});
