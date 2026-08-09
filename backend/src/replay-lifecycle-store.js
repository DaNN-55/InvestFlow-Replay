export function createReplayLifecycleStore(database) {
  return {
    getSession: (sessionId) => database.getReplaySession(sessionId),
    getScenarioUsage: () => database.getReplayScenarioUsage(),
    createSession: (session) => database.createReplaySession(session),
    retrainSession: (command) => database.retrainReplaySession(command),
    deleteSession: (sessionId, deletedAt) =>
      database.deleteReplaySession(sessionId, deletedAt),
    getPlaybookVersionLink: (playbookId, versionId) =>
      database.getReplayPlaybookVersionLink(playbookId, versionId),
    submitOrder: (command) => database.submitReplayOrder(command),
    advanceSession: (command) => database.advanceReplaySession(command),
    finishSession: (command) => database.finishReplaySession(command),
    saveBlindReview: (command) => database.saveReplayBlindReview(command),
    savePostReview: (command) => database.saveReplayPostReview(command),
    saveReviewDraft: (command) => database.saveReplayReviewDraft(command),
    deleteReviewDraft: (command) => database.deleteReplayReviewDraft(command),
    appendReviewCorrection: (command) =>
      database.appendReplayReviewCorrection(command),
    updateReviewCorrection: (command) =>
      database.updateReplayReviewCorrection(command),
    deleteReviewCorrection: (command) =>
      database.deleteReplayReviewCorrection(command),
    revealSession: (command) => database.revealReplaySession(command),
  };
}
