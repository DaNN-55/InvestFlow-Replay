import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, shallowRef } from "vue";

import { useReplayAttempt } from "../../src/composables/useReplayAttempt.js";
import { useReplaySession } from "../../src/composables/useReplaySession.js";

const SESSION_STORAGE_KEY = "investflow.replay.active-session-id";

function createSessionController(calls) {
  const session = shallowRef({ id: "session-1", status: "active" });
  const flag = shallowRef(false);
  return {
    session,
    hasSession: computed(() => Boolean(session.value?.id)),
    isCompleted: computed(() => session.value?.status === "completed"),
    isRevealed: computed(() => Boolean(session.value?.revealed)),
    isBusy: flag,
    isRestoring: flag,
    isCreating: flag,
    isSubmitting: flag,
    isAdvancing: flag,
    isFinishing: flag,
    isRevealing: flag,
    isSavingBlindReview: flag,
    isSavingPostReview: flag,
    isSavingBlindCorrection: flag,
    isSavingPostCorrection: flag,
    isCancellingRetrain: flag,
    errorMessage: shallowRef(""),
    statusMessage: shallowRef("ready"),
    createSession: async () => null,
    submitOrder: async (order) => {
      calls.push(["submit", order]);
      return session.value;
    },
    advanceSession: async (mode) => {
      calls.push(["advance", mode]);
      return session.value;
    },
    finishSession: async () => {
      calls.push(["finish"]);
      return session.value;
    },
    skipSessionAndRestart: async () => {
      calls.push(["skip"]);
      return session.value;
    },
    revealSession: async () => session.value,
    cancelRetrain: async () => {
      calls.push(["cancel-retrain"]);
      return session.value;
    },
    saveBlindReview: async (review) => {
      calls.push(["save-blind", review]);
      return session.value;
    },
    savePostReview: async (review) => {
      calls.push(["save-post", review]);
      return null;
    },
    addBlindReviewCorrection() {},
    addPostReviewCorrection() {},
    updateReviewCorrection() {},
    deleteReviewCorrection() {},
    syncStoredSession() {},
    startNewSession() {},
    clearMessages() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function createDraftController(calls) {
  return {
    drafts: shallowRef({ blind: { thesis: "draft" }, post: null }),
    statuses: shallowRef({ blind: "saved", post: "unsaved" }),
    queueDraft() {},
    deleteDraft() {},
    async prepareFinal(stage) {
      calls.push(["prepare", stage]);
    },
    finishFinal(stage, saved) {
      calls.push(["finish-final", stage, saved]);
    },
  };
}

function createAutoplayController(calls) {
  return {
    playing: shallowRef(true),
    speed: shallowRef("normal"),
    message: shallowRef("自动播放中"),
    pause() {
      calls.push(["pause"]);
    },
    toggle() {},
    setSpeed() {},
  };
}

describe("replay attempt workflow", () => {
  it("exposes grouped observable state instead of internal controllers", () => {
    const calls = [];
    const attempt = useReplayAttempt({
      sessionController: createSessionController(calls),
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    assert.deepEqual(Object.keys(attempt), [
      "session",
      "state",
      "messages",
      "review",
      "autoplay",
      "commands",
    ]);
    assert.deepEqual(Object.keys(attempt.state.value), [
      "hasSession",
      "isCompleted",
      "isRevealed",
      "isBusy",
      "activity",
    ]);
    assert.equal(attempt.state.value.hasSession, true);
    assert.equal(attempt.state.value.activity, null);
    assert.equal(attempt.messages.value.primary, "ready");
    assert.equal(attempt.review.value.drafts.blind.thesis, "draft");
    assert.equal(attempt.autoplay.value.playing, true);
  });

  it("accepts only one write command until the active command settles", async () => {
    const calls = [];
    const pending = deferred();
    const sessionController = createSessionController(calls);
    sessionController.submitOrder = async (order) => {
      calls.push(["submit", order]);
      await pending.promise;
      return sessionController.session.value;
    };
    const attempt = useReplayAttempt({
      sessionController,
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    const first = attempt.commands.submitOrder({ side: "buy" });
    const second = await attempt.commands.advance("day");

    assert.equal(second, null);
    assert.equal(attempt.state.value.isBusy, true);
    assert.equal(attempt.state.value.activity, "working");
    assert.deepEqual(calls, [
      ["pause"],
      ["submit", { side: "buy" }],
    ]);

    pending.resolve();
    await first;
    assert.equal(attempt.state.value.isBusy, false);
    assert.equal(attempt.state.value.activity, null);
  });

  it("restores the stored session and refreshes a stale command conflict", async () => {
    const calls = [];
    let readCount = 0;
    const client = {
      async getReplaySession(sessionId) {
        readCount += 1;
        return {
          session: {
            id: sessionId,
            status: "active",
            revision: readCount,
          },
        };
      },
      async submitReplayOrder() {
        const error = new Error("stale revision");
        error.status = 409;
        throw error;
      },
    };
    const sessionController = useReplaySession({
      client,
      storage: createMemoryStorage({ [SESSION_STORAGE_KEY]: "session-1" }),
      restoreOnMount: false,
    });
    const attempt = useReplayAttempt({
      sessionController,
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    await attempt.commands.sync();
    assert.equal(attempt.session.value.revision, 1);

    const submitted = await attempt.commands.submitOrder({ side: "buy" });

    assert.equal(submitted, null);
    assert.equal(attempt.session.value.revision, 2);
    assert.match(attempt.messages.value.status, /已刷新到最新进度/u);
  });

  it("deletes an accidental retrain and restores its source session", async () => {
    const calls = [];
    const client = {
      async getReplaySession(sessionId) {
        calls.push(["get", sessionId]);
        if (sessionId === "retrain-1") {
          return {
            session: {
              id: sessionId,
              status: "completed",
              attemptInfo: { sourceSessionId: "source-1" },
            },
          };
        }
        return { session: { id: sessionId, status: "completed" } };
      },
      async deleteReplaySession(sessionId) {
        calls.push(["delete", sessionId]);
      },
    };
    const storage = createMemoryStorage({
      [SESSION_STORAGE_KEY]: "retrain-1",
    });
    const sessionController = useReplaySession({
      client,
      storage,
      restoreOnMount: false,
    });
    const attempt = useReplayAttempt({
      sessionController,
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    await attempt.commands.sync();
    const restored = await attempt.commands.cancelRetrain();

    assert.equal(restored.id, "source-1");
    assert.equal(attempt.session.value.id, "source-1");
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), "source-1");
    assert.deepEqual(calls, [
      ["get", "retrain-1"],
      ["pause"],
      ["delete", "retrain-1"],
      ["get", "source-1"],
    ]);
  });

  it("pauses autoplay before every manual market command", async () => {
    const calls = [];
    const attempt = useReplayAttempt({
      sessionController: createSessionController(calls),
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    await attempt.commands.submitOrder({ side: "buy" });
    await attempt.commands.advance("day");
    await attempt.commands.finish();
    await attempt.commands.skipAndRestart();
    await attempt.commands.cancelRetrain();

    assert.deepEqual(calls, [
      ["pause"], ["submit", { side: "buy" }],
      ["pause"], ["advance", "day"],
      ["pause"], ["finish"],
      ["pause"], ["skip"],
      ["pause"], ["cancel-retrain"],
    ]);
  });

  it("serializes draft finalization around both review saves", async () => {
    const calls = [];
    const attempt = useReplayAttempt({
      sessionController: createSessionController(calls),
      reviewDraftController: createDraftController(calls),
      autoplayController: createAutoplayController(calls),
    });

    await attempt.commands.saveBlindReview({ thesis: "blind" });
    await attempt.commands.savePostReview({ lesson: "post" });

    assert.deepEqual(calls, [
      ["pause"],
      ["prepare", "blind"],
      ["save-blind", { thesis: "blind" }],
      ["finish-final", "blind", true],
      ["pause"],
      ["prepare", "post"],
      ["save-post", { lesson: "post" }],
      ["finish-final", "post", false],
    ]);
  });
});
