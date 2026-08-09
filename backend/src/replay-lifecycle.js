function buildActionRequest(expectedRevision, extra = {}) {
  return {
    expectedRevision,
    ...extra,
  };
}

export function createReplayLifecycle({
  database,
  now = () => new Date().toISOString(),
}) {
  function submitOrder({
    sessionId,
    actionId,
    expectedRevision,
    order,
    requestPayload,
  }) {
    return database.submitReplayOrder({
      sessionId,
      actionId,
      expectedRevision,
      order,
      requestPayload,
      updatedAt: now(),
    });
  }

  function advanceOnce({ sessionId, actionId, expectedRevision, mode, step }) {
    return database.advanceReplaySession({
      sessionId,
      actionId: `${actionId}:${step}`,
      expectedRevision,
      requestPayload: buildActionRequest(expectedRevision, { mode }),
      updatedAt: now(),
    });
  }

  function advanceSession({
    sessionId,
    actionId,
    expectedRevision,
    mode = "minute",
  }) {
    let result = advanceOnce({
      sessionId,
      actionId,
      expectedRevision,
      mode,
      step: 0,
    });
    if (!result) {
      return null;
    }

    const isHybrid = result.session?.snapshot?.interval === "hybrid";
    if (mode !== "day" || !isHybrid || !result.advanced || result.idempotent) {
      return result;
    }

    const firstSequence =
      Number(result.session.observationBars) +
      Number(result.session.revealedFutureBars);
    const targetTradeDate = String(
      result.session.snapshot?.bars?.[firstSequence - 1]?.tradeDate ?? "",
    );
    let step = 1;
    while (
      result.session.status !== "completed" &&
      String(
        result.session.snapshot?.bars?.[
          Number(result.session.observationBars) +
            Number(result.session.revealedFutureBars)
        ]?.tradeDate ?? "",
      ) === targetTradeDate
    ) {
      result = advanceOnce({
        sessionId,
        actionId,
        expectedRevision: Number(result.session.revision),
        mode,
        step,
      });
      step += 1;
    }
    return result;
  }

  function finishSession({
    sessionId,
    actionId,
    expectedRevision,
    completionReason = "early",
    requestPayload,
  }) {
    return database.finishReplaySession({
      sessionId,
      actionId,
      expectedRevision,
      completionReason,
      requestPayload,
      updatedAt: now(),
    });
  }

  return {
    submitOrder,
    advanceSession,
    finishSession,
  };
}
