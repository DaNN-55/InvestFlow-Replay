import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateTradeLicense, resolveTradeRecordLifecycle } from "./trade-license.js";
import { calculateTradeLicense as calculateLicensePreview } from "../../web/src/utils/tradeLicense.js";

describe("backend calculateTradeLicense", () => {
  const validInput = {
    triggerPrice: 20,
    failurePrice: 19,
    targetPrice: 24,
    accountEquity: 100000,
    minRewardRiskRatio: 2,
    maxAccountRiskPct: 0.5,
    maxPositionPct: 30,
    lotSize: 100,
  };

  it("limits account risk to greater than zero and at most one hundred percent", () => {
    for (const maxAccountRiskPct of [0, -1, 100.01, 101]) {
      const result = calculateTradeLicense({ ...validInput, maxAccountRiskPct });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((item) => item.code === "INVALID_ACCOUNT_RISK"));
    }
    assert.equal(calculateTradeLicense({ ...validInput, maxAccountRiskPct: 100 }).valid, true);
  });

  it("matches the frontend preview across valid inputs and validation boundaries", () => {
    const cases = [
      {},
      { maxAccountRiskPct: 0.25 },
      { maxAccountRiskPct: 100 },
      { maxAccountRiskPct: 101 },
      { maxAccountRiskPct: 0 },
      { maxAccountRiskPct: null },
      { accountEquity: 0 },
      { accountEquity: 100 },
      { failurePrice: 21 },
      { minRewardRiskRatio: 10 },
      { maxPositionPct: 101 },
      { triggerPrice: "20", failurePrice: "19", targetPrice: "24" },
    ];
    for (const overrides of cases) {
      const input = { ...validInput, ...overrides };
      assert.deepEqual(calculateTradeLicense(input), calculateLicensePreview(input), JSON.stringify(overrides));
    }
  });

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
