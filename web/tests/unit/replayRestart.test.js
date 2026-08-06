import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReplayRestartOptions } from "../../src/utils/replayRestart.js";

describe("buildReplayRestartOptions", () => {
  it("preserves the current replay configuration without carrying account results", () => {
    const options = buildReplayRestartOptions({
      interval: "hybrid",
      gameLength: 20,
      benchmarkCode: "000001.SH",
      account: { initialCapital: 100000, cash: 82345 },
      costConfig: {
        commissionRate: 0.0003,
        minCommission: 5,
        stampTaxRate: 0.0005,
        transferFeeRate: 0.00001,
        slippageBps: 2,
      },
      trainingConfig: { mode: "free" },
    });

    assert.deepEqual(options, {
      interval: "hybrid",
      gameLength: 20,
      benchmarkCode: "000001.SH",
      initialCapital: 100000,
      costConfig: {
        commissionRate: 0.0003,
        minCommission: 5,
        stampTaxRate: 0.0005,
        transferFeeRate: 0.00001,
        slippageBps: 2,
      },
      trainingMode: "free",
    });
  });

  it("restarts a legacy strategy drill as free training", () => {
    const options = buildReplayRestartOptions({
      interval: "1d",
      gameLength: 60,
      benchmarkCode: "000001.SH",
      account: { initialCapital: 200000 },
      costConfig: {},
      trainingConfig: {
        mode: "playbook",
        playbookId: "playbook-1",
        playbookVersionId: "version-3",
      },
    });

    assert.equal(options.trainingMode, "free");
    assert.equal("playbookId" in options, false);
    assert.equal("playbookVersionId" in options, false);
  });
});
