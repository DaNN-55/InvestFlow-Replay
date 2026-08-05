import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateTradeLicense, resolveTradeRecordLifecycle } from "./trade-license.js";

describe("backend calculateTradeLicense", () => {
  it("matches the authoritative two-to-one license calculation", () => {
    const result = calculateTradeLicense({
      triggerPrice: 20,
      failurePrice: 19,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 30,
      lotSize: 100,
    });

    assert.deepEqual(
      {
        valid: result.valid,
        plannedEntryLow: result.plannedEntryLow,
        plannedEntryHigh: result.plannedEntryHigh,
        plannedQuantity: result.plannedQuantity,
        estimatedMaxLossAmount: result.estimatedMaxLossAmount,
      },
      {
        valid: true,
        plannedEntryLow: 20,
        plannedEntryHigh: 20.66,
        plannedQuantity: 300,
        estimatedMaxLossAmount: 498,
      },
    );
  });

  it("rejects a position cap above one hundred percent", () => {
    const result = calculateTradeLicense({
      triggerPrice: 20,
      failurePrice: 19,
      targetPrice: 24,
      accountEquity: 100000,
      minRewardRiskRatio: 2,
      maxAccountRiskPct: 0.5,
      maxPositionPct: 101,
      lotSize: 100,
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.code === "INVALID_POSITION_CAP"));
  });
});

describe("resolveTradeRecordLifecycle", () => {
  it("expires only signed licenses after their planned trade date", () => {
    assert.equal(resolveTradeRecordLifecycle({
      status: "planned",
      validForTradeDate: "2026-07-14",
      licenseSnapshot: { calculationVersion: 1 },
    }, "2026-07-15").status, "expired");
    assert.equal(resolveTradeRecordLifecycle({
      status: "planned",
      validForTradeDate: "2026-07-14",
      licenseSnapshot: null,
    }, "2026-07-15").status, "planned");
  });
});
