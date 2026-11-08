import { computed, shallowRef } from "vue";

import { useReplayAutoplay } from "./useReplayAutoplay.js";
import { useReplayReviewDrafts } from "./useReplayReviewDrafts.js";
import { useReplaySession } from "./useReplaySession.js";

export function useReplayAttempt(options = {}) {
  const sessionController = options.sessionController ?? useReplaySession({ restoreOnMount: false });
  const reviewDraftController = options.reviewDraftController ??
    useReplayReviewDrafts({ session: sessionController.session });
  const currentBlindDraft = computed(
    () => reviewDraftController.drafts.value.blind,
  );
  const autoplayController = options.autoplayController ?? useReplayAutoplay({
    session: sessionController.session,
    isBusy: sessionController.isBusy,
    errorMessage: sessionController.errorMessage,
    statusMessage: sessionController.statusMessage,
    advanceSession: sessionController.advanceSession,
    blindDraft: currentBlindDraft,
  });

  const commandRunning = shallowRef(false);

  const activity = computed(() => {
    if (reviewDraftController.stages.value.blind.finalizing) return "savingBlindReview";
    if (reviewDraftController.stages.value.post.finalizing) return "savingPostReview";
    return sessionController.activity.value ?? (commandRunning.value ? "working" : null);
  });

  const state = computed(() => ({
    hasSession: sessionController.hasSession.value,
    isCompleted: sessionController.isCompleted.value,
    isRevealed: sessionController.isRevealed.value,
    isBusy: sessionController.isBusy.value || commandRunning.value,
    activity: activity.value,
  }));

  const messages = computed(() => ({
    error: sessionController.errorMessage.value,
    status: sessionController.statusMessage.value,
    primary:
      sessionController.errorMessage.value ||
      sessionController.statusMessage.value,
  }));

  async function runWrite(command, { pause = true } = {}) {
    if (commandRunning.value || sessionController.isBusy.value) {
      return null;
    }
    commandRunning.value = true;
    if (pause) {
      autoplayController.pause();
    }
    try {
      return await command();
    } finally {
      commandRunning.value = false;
    }
  }

  function submitOrder(order) {
    return runWrite(() => sessionController.submitOrder(order));
  }

  function advance(mode = "minute") {
    return runWrite(() => sessionController.advanceSession(mode));
  }

  function finish() {
    return runWrite(() => sessionController.finishSession());
  }

  function skipAndRestart() {
    return runWrite(() => sessionController.skipSessionAndRestart());
  }

  function cancelRetrain() {
    return runWrite(() => sessionController.cancelRetrain());
  }

  function saveReview(stage, review) {
    return runWrite(() => reviewDraftController.finalize(stage, review, {
      submit: payload => stage === "blind"
        ? sessionController.saveBlindReview(payload)
        : sessionController.savePostReview(payload),
      read: sessionId => sessionController.refreshSession({ sessionId }),
    }));
  }

  const review = computed(() => ({
    drafts: reviewDraftController.drafts.value,
    statuses: reviewDraftController.statuses.value,
    stages: reviewDraftController.stages.value,
  }));

  const autoplay = computed(() => ({
    playing: autoplayController.playing.value,
    speed: autoplayController.speed.value,
    message: autoplayController.message.value,
  }));

  const commands = Object.freeze({
    create: (payload) => runWrite(
      () => sessionController.createSession(payload),
      { pause: false },
    ),
    submitOrder,
    cancelOrder: (orderId) => runWrite(() => sessionController.cancelOrder(orderId)),
    advance,
    finish,
    skipAndRestart,
    reveal: () => runWrite(() => sessionController.revealSession()),
    cancelRetrain,
    queueReviewDraft: reviewDraftController.queueDraft,
    deleteReviewDraft: reviewDraftController.deleteDraft,
    saveBlindReview: (payload) => saveReview("blind", payload),
    savePostReview: (payload) => saveReview("post", payload),
    confirmReview: stage => runWrite(() => reviewDraftController.confirmFinal(stage,
      sessionId => sessionController.refreshSession({ sessionId })), { pause: false }),
    addBlindCorrection: (payload) => runWrite(
      () => sessionController.addBlindReviewCorrection(payload),
    ),
    addPostCorrection: (payload) => runWrite(
      () => sessionController.addPostReviewCorrection(payload),
    ),
    updateCorrection: (...args) => runWrite(
      () => sessionController.updateReviewCorrection(...args),
    ),
    deleteCorrection: (...args) => runWrite(
      () => sessionController.deleteReviewCorrection(...args),
    ),
    toggleAutoplay: autoplayController.toggle,
    setAutoplaySpeed: autoplayController.setSpeed,
    sync: () => runWrite(() => sessionController.syncStoredSession(), { pause: false }),
    resume: (id) => runWrite(() => sessionController.resumeSession(id)),
      startNew: () => runWrite(() => sessionController.startNewSession()),
    clearMessages: sessionController.clearMessages,
  });

  return {
    session: sessionController.session,
    state,
    messages,
    review,
    autoplay,
    commands,
  };
}
