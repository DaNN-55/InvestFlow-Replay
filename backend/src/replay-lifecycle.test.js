import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReplayLifecycle } from "./replay-lifecycle.js";

function hybridSession({ revealedFutureBars, revision, status = "active" }) {
  return {
    observationBars: 2,
    revealedFutureBars,
    revision,
    status,
    snapshot: {
      interval: "hybrid",
      bars: [
        { tradeDate: "2026-08-01" },
        { tradeDate: "2026-08-02" },
        { tradeDate: "2026-08-03" },
        { tradeDate: "2026-08-03" },
        { tradeDate: "2026-08-03" },
        { tradeDate: "2026-08-04" },
      ],
    },
  };
}

describe("replay lifecycle", () => {
  it("owns hybrid whole-day advancement and internal step revisions", () => {
    const calls = [];
    const sessions = [
      hybridSession({ revealedFutureBars: 1, revision: 5 }),
      hybridSession({ revealedFutureBars: 2, revision: 6 }),
      hybridSession({ revealedFutureBars: 3, revision: 7 }),
    ];
    const lifecycle = createReplayLifecycle({
      database: {
        advanceReplaySession(command) {
          calls.push(command);
          return { session: sessions.shift(), advanced: true, idempotent: false };
        },
      },
      now: () => "2026-08-09T00:00:00.000Z",
    });

    const result = lifecycle.advanceSession({
      sessionId: "session-1",
      actionId: "advance-day",
      expectedRevision: 4,
      mode: "day",
    });

    assert.equal(result.session.revealedFutureBars, 3);
    assert.deepEqual(
      calls.map(({ actionId, expectedRevision }) => ({ actionId, expectedRevision })),
      [
        { actionId: "advance-day:0", expectedRevision: 4 },
        { actionId: "advance-day:1", expectedRevision: 5 },
        { actionId: "advance-day:2", expectedRevision: 6 },
      ],
    );
    assert.ok(calls.every((call) => call.requestPayload.mode === "day"));
  });

  it("does not replay internal steps for an idempotent day command", () => {
    const calls = [];
    const lifecycle = createReplayLifecycle({
      database: {
        advanceReplaySession(command) {
          calls.push(command);
          return {
            session: hybridSession({ revealedFutureBars: 1, revision: 5 }),
            advanced: true,
            idempotent: true,
          };
        },
      },
    });

    lifecycle.advanceSession({
      sessionId: "session-1",
      actionId: "advance-day",
      expectedRevision: 4,
      mode: "day",
    });

    assert.equal(calls.length, 1);
  });

  it("keeps order and finish timestamps behind the lifecycle seam", () => {
    const calls = [];
    const database = {
      submitReplayOrder(command) {
        calls.push(["order", command]);
        return { created: true };
      },
      finishReplaySession(command) {
        calls.push(["finish", command]);
        return { finished: true };
      },
    };
    const lifecycle = createReplayLifecycle({
      database,
      now: () => "2026-08-09T00:00:00.000Z",
    });

    lifecycle.submitOrder({
      sessionId: "session-1",
      actionId: "order-1",
      expectedRevision: 2,
      order: { side: "buy" },
      requestPayload: { expectedRevision: 2, side: "buy" },
    });
    lifecycle.finishSession({
      sessionId: "session-1",
      actionId: "finish-1",
      expectedRevision: 3,
      completionReason: "early",
      requestPayload: { expectedRevision: 3 },
    });

    assert.equal(calls[0][1].updatedAt, "2026-08-09T00:00:00.000Z");
    assert.equal(calls[1][1].updatedAt, "2026-08-09T00:00:00.000Z");
  });
});
