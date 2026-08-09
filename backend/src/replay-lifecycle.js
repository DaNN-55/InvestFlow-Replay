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

  function requireSession(sessionId) {
    const session = database.getReplaySession(sessionId);
    if (!session) {
      throw lifecycleError("找不到行情演练会话", 404);
    }
    return session;
  }

  function linkBlindReviewToPlaybook(review, requestPayload) {
    if (!review.playbookId) {
      return;
    }
    const link = database.getReplayPlaybookVersionLink(
      review.playbookId,
      review.playbookVersionId,
    );
    if (!link) {
      throw lifecycleError("playbookVersionId 不属于指定的 playbookId");
    }
    review.strategyName = link.playbookName;
    review.playbookVersionNumber = link.versionNumber;
    requestPayload.review = review;
  }

  function applyPostReviewRules(session, review, requestPayload, { required }) {
    const blindReview = session.review?.blindReview;
    const requiresPlaybookFit =
      Boolean(String(blindReview?.playbookId ?? "").trim()) &&
      Boolean(String(blindReview?.playbookVersionId ?? "").trim());
    if (requiresPlaybookFit) {
      if (required && !Number.isSafeInteger(review.playbookFitScore)) {
        throw lifecycleError("关联参考战法的复盘必须提供 playbookFitScore");
      }
      return;
    }
    delete review.playbookFitScore;
    review.strategyAdjustment = "";
    requestPayload.review = review;
  }

  function saveBlindReview({ sessionId, normalized }) {
    requireSession(sessionId);
    linkBlindReviewToPlaybook(normalized.review, normalized.requestPayload);
    return database.saveReplayBlindReview({
      sessionId,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: normalized.review,
      requestPayload: normalized.requestPayload,
      updatedAt: now(),
    });
  }

  function savePostReview({ sessionId, normalized }) {
    const session = requireSession(sessionId);
    applyPostReviewRules(session, normalized.review, normalized.requestPayload, {
      required: true,
    });
    return database.saveReplayPostReview({
      sessionId,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: normalized.review,
      requestPayload: normalized.requestPayload,
      updatedAt: now(),
    });
  }

  function saveReviewDraft({ sessionId, stage, normalized }) {
    return database.saveReplayReviewDraft({
      sessionId,
      stage,
      draft: normalized.draft,
      expectedRevision: normalized.expectedRevision,
      updatedAt: now(),
    });
  }

  function deleteReviewDraft({ sessionId, stage, expectedRevision }) {
    return database.deleteReplayReviewDraft({
      sessionId,
      stage,
      expectedRevision,
      updatedAt: now(),
    });
  }

  function appendReviewCorrection({ sessionId, stage, normalized }) {
    const session = requireSession(sessionId);
    if (stage === "blind") {
      linkBlindReviewToPlaybook(normalized.review, normalized.requestPayload);
    } else {
      applyPostReviewRules(session, normalized.review, normalized.requestPayload, {
        required: true,
      });
    }
    return database.appendReplayReviewCorrection({
      sessionId,
      stage,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: normalized.review,
      changeNote: normalized.changeNote,
      requestPayload: normalized.requestPayload,
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
    if (stage === "blind") {
      linkBlindReviewToPlaybook(normalized.review, normalized.requestPayload);
    } else {
      applyPostReviewRules(session, normalized.review, normalized.requestPayload, {
        required: false,
      });
    }
    normalized.requestPayload.review = normalized.review;
    return database.updateReplayReviewCorrection({
      sessionId,
      correctionId,
      stage,
      actionId: normalized.actionId,
      expectedRevision: normalized.expectedRevision,
      review: normalized.review,
      changeNote: normalized.changeNote,
      requestPayload: normalized.requestPayload,
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
    return database.deleteReplayReviewCorrection({
      sessionId,
      correctionId,
      stage,
      actionId,
      expectedRevision,
      updatedAt: now(),
    });
  }

  function revealSession({ sessionId, actionId, expectedRevision }) {
    return database.revealReplaySession({
      sessionId,
      actionId,
      expectedRevision,
      requestPayload: buildActionRequest(expectedRevision),
      updatedAt: now(),
    });
  }

  return {
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
