import { computed, shallowRef } from "vue";

import { useReplayAutoplay } from "./useReplayAutoplay.js";
import { useReplayReviewDrafts } from "./useReplayReviewDrafts.js";
import { useReplaySession } from "./useReplaySession.js";

export function useReplayAttempt(options = {}) {
  const sessionController = options.sessionController ?? useReplaySession();
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
    const activities = [
      ["restoring", sessionController.isRestoring],
      ["creating", sessionController.isCreating],
      ["submitting", sessionController.isSubmitting],
      ["advancing", sessionController.isAdvancing],
      ["finishing", sessionController.isFinishing],
      ["revealing", sessionController.isRevealing],
      ["savingBlindReview", sessionController.isSavingBlindReview],
      ["savingPostReview", sessionController.isSavingPostReview],
      ["savingBlindCorrection", sessionController.isSavingBlindCorrection],
      ["savingPostCorrection", sessionController.isSavingPostCorrection],
      ["cancellingRetrain", sessionController.isCancellingRetrain],
    ];
    return activities.find(([, flag]) => flag.value)?.[0] ??
      (commandRunning.value ? "working" : null);
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
    return runWrite(async () => {
      await reviewDraftController.prepareFinal(stage);
      const savedSession = stage === "blind"
        ? await sessionController.saveBlindReview(review)
        : await sessionController.savePostReview(review);
      reviewDraftController.finishFinal(stage, Boolean(savedSession));
      return savedSession;
    });
  }

  const review = computed(() => ({
    drafts: reviewDraftController.drafts.value,
    statuses: reviewDraftController.statuses.value,
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
    advance,
    finish,
    skipAndRestart,
    reveal: () => runWrite(() => sessionController.revealSession()),
    cancelRetrain,
    queueReviewDraft: reviewDraftController.queueDraft,
    deleteReviewDraft: (stage) => runWrite(
      () => reviewDraftController.deleteDraft(stage),
      { pause: false },
    ),
    saveBlindReview: (payload) => saveReview("blind", payload),
    savePostReview: (payload) => saveReview("post", payload),
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
    sync: sessionController.syncStoredSession,
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
