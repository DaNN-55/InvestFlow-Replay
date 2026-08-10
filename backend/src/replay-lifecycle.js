import { randomUUID } from "node:crypto";

function buildActionRequest(expectedRevision, extra = {}) {
  return {
    expectedRevision,
    ...extra,
  };
}

function lifecycleError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createReplayLifecycle({
  store,
  scenarioSource,
  createId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  async function createSession({
    gameLength,
    benchmarkCode,
    seed,
    interval,
    initialCapital,
    costConfig,
    trainingConfig,
  }) {
    const scenarioUsage = store.getScenarioUsage();
    const snapshot = await scenarioSource.createReplayScenario({
      gameLength,
      benchmarkCode,
      seed,
      interval,
      excludedTsCodes: scenarioUsage.usedTsCodes,
      recentWindowEndDates: scenarioUsage.recentWindowEndDates,
    });
    const validSnapshot =
      Number(snapshot?.observationBars) === 250 &&
      (interval === "hybrid"
        ? Number(snapshot?.trainingDays) === gameLength &&
          Number(snapshot?.gameLength) > 0
        : Number(snapshot?.gameLength) === gameLength) &&
      String(snapshot?.interval ?? "1d") === interval &&
      Array.isArray(snapshot?.bars) &&
      snapshot.bars.length >= 250 + Number(snapshot?.gameLength);
    if (!validSnapshot) {
      throw lifecycleError("行情演练场景数据不完整", 502);
    }

    const timestamp = now();
    const session = store.createSession({
      id: createId(),
      sourceDataVersion: String(snapshot.sourceDataVersion ?? ""),
      gameLength: Number(snapshot.gameLength),
      observationBars: 250,
      revealedFutureBars: 0,
      status: "active",
      revision: 0,
      snapshot,
      account: {
        initialCapital,
        cash: initialCapital,
        positionQuantity: 0,
        availableQuantity: 0,
        lockedQuantity: 0,
        averageCost: 0,
        realizedPnl: 0,
        totalFees: 0,
      },
      costConfig,
      trainingConfig,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    void scenarioSource.prefetchReplayStocks({
      excludedTsCodes: [
        ...scenarioUsage.usedTsCodes,
        String(snapshot.tsCode || ""),
      ],
      targetReserve: 12,
    }).catch(() => {});
    return session;
  }

  function retrainSession(sourceSessionId) {
    return store.retrainSession({
      sourceSessionId,
      id: createId(),
      createdAt: now(),
    });
  }

  function deleteSession(sessionId) {
    return store.deleteSession(sessionId, now());
  }

  function submitOrder({
    sessionId,
    actionId,
    expectedRevision,
    order,
    requestPayload,
  }) {
    return store.submitOrder({
      sessionId,
      actionId,
      expectedRevision,
      order,
      requestPayload,
      updatedAt: now(),
    });
  }

  function advanceOnce({ sessionId, actionId, expectedRevision, mode, step }) {
    return store.advanceSession({
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
    if (mode === "day" && store.advanceSessionThroughDay) {
      return store.advanceSessionThroughDay({
        sessionId,
        actionId,
        expectedRevision,
        updatedAt: now(),
      });
    }
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
    return store.finishSession({
      sessionId,
      actionId,
      expectedRevision,
      completionReason,
      requestPayload,
      updatedAt: now(),
    });
  }

  function requireSession(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) {
      throw lifecycleError("找不到行情演练会话", 404);
    }
    return session;
  }

  function linkBlindReviewToPlaybook(review, requestPayload) {
    if (!review.playbookId) {
      return { review: { ...review }, requestPayload: { ...requestPayload } };
    }
    const link = store.getPlaybookVersionLink(
      review.playbookId,
      review.playbookVersionId,
    );
    if (!link) {
      throw lifecycleError("playbookVersionId 不属于指定的 playbookId");
    }
    const linkedReview = {
      ...review,
      strategyName: link.playbookName,
      playbookVersionNumber: link.versionNumber,
    };
    return {
      review: linkedReview,
      requestPayload: { ...requestPayload, review: linkedReview },
    };
  }

  function getEffectiveBlindReview(session) {
    const latestBlindCorrection = (session.corrections ?? [])
      .filter((correction) => correction.stage === "blind")
      .at(-1);
    return latestBlindCorrection?.fullReviewSnapshot ??
      session.review?.blindReview ??
      null;
  }

  function applyPostReviewRules(session, review, requestPayload, { required }) {
    const blindReview = getEffectiveBlindReview(session);
    const requiresPlaybookFit =
      Boolean(String(blindReview?.playbookId ?? "").trim()) &&
      Boolean(String(blindReview?.playbookVersionId ?? "").trim());
    if (requiresPlaybookFit) {
      if (required && !Number.isSafeInteger(review.playbookFitScore)) {
        throw lifecycleError("关联参考战法的复盘必须提供 playbookFitScore");
      }
      return { review: { ...review }, requestPayload: { ...requestPayload } };
    }
    const { playbookFitScore: _ignored, ...reviewWithoutPlaybookFit } = review;
    const normalizedReview = {
      ...reviewWithoutPlaybookFit,
      strategyAdjustment: "",
    };
    return {
      review: normalizedReview,
      requestPayload: { ...requestPayload, review: normalizedReview },
    };
  }

  function saveBlindReview({ sessionId, normalized }) {
    requireSession(sessionId);
    const linked = linkBlindReviewToPlaybook(
      normalized.review,
      normalized.requestPayload,
    );
    return store.saveBlindReview({
      sessionId,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: linked.review,
      requestPayload: linked.requestPayload,
      updatedAt: now(),
    });
  }

  function savePostReview({ sessionId, normalized }) {
    const session = requireSession(sessionId);
    const reviewed = applyPostReviewRules(
      session,
      normalized.review,
      normalized.requestPayload,
      { required: true },
    );
    return store.savePostReview({
      sessionId,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: reviewed.review,
      requestPayload: reviewed.requestPayload,
      updatedAt: now(),
    });
  }

  function saveReviewDraft({ sessionId, stage, normalized }) {
    return store.saveReviewDraft({
      sessionId,
      stage,
      draft: normalized.draft,
      expectedRevision: normalized.expectedRevision,
      updatedAt: now(),
    });
  }

  function deleteReviewDraft({ sessionId, stage, expectedRevision }) {
    return store.deleteReviewDraft({
      sessionId,
      stage,
      expectedRevision,
      updatedAt: now(),
    });
  }

  function appendReviewCorrection({ sessionId, stage, normalized }) {
    const session = requireSession(sessionId);
    const reviewed = stage === "blind"
      ? linkBlindReviewToPlaybook(normalized.review, normalized.requestPayload)
      : applyPostReviewRules(session, normalized.review, normalized.requestPayload, {
        required: true,
      });
    return store.appendReviewCorrection({
      sessionId,
      stage,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: reviewed.review,
      changeNote: normalized.changeNote,
      requestPayload: reviewed.requestPayload,
      createdAt: now(),
    });
  }

  function updateReviewCorrection({
    sessionId,
    correctionId,
    stage,
    normalized,
  }) {
    const session = requireSession(sessionId);
    const reviewed = stage === "blind"
      ? linkBlindReviewToPlaybook(normalized.review, normalized.requestPayload)
      : applyPostReviewRules(session, normalized.review, normalized.requestPayload, {
        required: false,
      });
    return store.updateReviewCorrection({
      sessionId,
      correctionId,
      stage,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: reviewed.review,
      changeNote: normalized.changeNote,
      requestPayload: reviewed.requestPayload,
      updatedAt: now(),
    });
  }

  function deleteReviewCorrection({
    sessionId,
    correctionId,
    stage,
    actionId,
    expectedRevision,
  }) {
    return store.deleteReviewCorrection({
      sessionId,
      correctionId,
      stage,
      actionId,
      expectedRevision,
      updatedAt: now(),
    });
  }

  function revealSession({ sessionId, actionId, expectedRevision }) {
    return store.revealSession({
      sessionId,
      actionId,
      expectedRevision,
      requestPayload: buildActionRequest(expectedRevision),
      updatedAt: now(),
    });
  }

  return {
    createSession,
    retrainSession,
    deleteSession,
    submitOrder,
    advanceSession,
    finishSession,
    saveBlindReview,
    savePostReview,
    saveReviewDraft,
    deleteReviewDraft,
    appendReviewCorrection,
    updateReviewCorrection,
    deleteReviewCorrection,
    revealSession,
  };
}
