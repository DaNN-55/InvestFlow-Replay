import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, shallowRef } from "vue";
import { useReplayReviewDrafts } from "../../src/composables/useReplayReviewDrafts.js";
import { useReplaySession } from "../../src/composables/useReplaySession.js";
import { useReplayAttempt } from "../../src/composables/useReplayAttempt.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function practice(id = "A", revision = 0, draft = null) {
  return { id, status: "completed", review: {}, reviewDrafts: { blind: { data: draft, revision } } };
}
function setup(t, apiClient = {}, initial = practice()) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope(), session = shallowRef(initial);
  t.after(() => scope.stop());
  const c = scope.run(() => useReplayReviewDrafts({ session, apiClient, debounceMs: 10 }));
  const advance = async () => { t.mock.timers.tick(10); await flush(); };
  return { c, session, advance };
}

for (const returnToA of [false, true]) test(`a deleted draft reply cannot change a ${returnToA ? "reloaded A" : "different B"} revision`, async t => {
  const deletion = deferred(), saves = [];
  const { c, session, advance } = setup(t, {
    deleteReplayReviewDraft: async () => deletion.promise,
    saveReplayReviewDraft: async (id, stage, data, revision) => {
      saves.push({ id, revision }); return { draft: { data, revision: revision + 1 } };
    },
  }, practice("A", 5, { thesis: "old A" }));
  const deleting = c.deleteDraft("blind");
  session.value = practice("B"); await nextTick();
  if (returnToA) { session.value = practice("A", 10); await nextTick(); }
  deletion.resolve({ revision: 6 }); await deleting;
  c.queueDraft("blind", { thesis: "new input" }); await advance();
  assert.deepEqual(saves, [{ id: returnToA ? "A" : "B", revision: returnToA ? 10 : 0 }]);
});

test("input during deletion waits and uses the accepted tombstone revision", async t => {
  const deletion = deferred(), saves = [];
  const { c, advance } = setup(t, {
    deleteReplayReviewDraft: async () => deletion.promise,
    saveReplayReviewDraft: async (_id, _stage, data, revision) => {
      saves.push({ data, revision }); return { draft: { data, revision: revision + 1 } };
    },
  }, practice("A", 3, { thesis: "old" }));
  const deleting = c.deleteDraft("blind");
  c.queueDraft("blind", { thesis: "new" }); await advance();
  assert.deepEqual(saves, []);
  deletion.resolve({ revision: 4 }); await deleting; await flush();
  assert.deepEqual(saves, [{ data: { thesis: "new" }, revision: 4 }]);
  assert.equal(c.drafts.value.blind.thesis, "new");
});

test("finalization drains a pending draft, captures the click, and freezes after confirmation", async t => {
  const pending = deferred(), events = [];
  const { c, session, advance } = setup(t, {
    saveReplayReviewDraft: async (_id, _stage, data) => { events.push("draft"); await pending.promise; return { draft: { data, revision: 1 } }; },
  });
  c.queueDraft("blind", { thesis: "earlier" }); await advance();
  const payload = { thesis: "clicked" };
  const finalizing = c.finalize("blind", payload, {
    submit: async value => { events.push(["final", value.thesis]); return { ...session.value, review: { blindSaved: true } }; },
    read: async () => { throw new Error("unexpected read"); },
  });
  payload.thesis = "mutated later";
  c.queueDraft("blind", { thesis: "ignored while frozen" });
  assert.equal(c.stages.value.blind.canEdit, false);
  assert.deepEqual(events, ["draft"]);
  pending.resolve(); await finalizing; await advance();
  assert.deepEqual(events, ["draft", ["final", "clicked"]]);
  assert.equal(c.stages.value.blind.phase, "finalized");
  assert.equal(c.drafts.value.blind, null);
});

test("an unconfirmed final commit is read without restarting autosave", async t => {
  let saves = 0, submissions = 0, reads = 0;
  const { c, session, advance } = setup(t, { saveReplayReviewDraft: async () => { saves++; throw new Error("must not save"); } });
  const result = await c.finalize("blind", { thesis: "clicked" }, {
    submit: async () => { submissions++; throw new Error("lost response"); },
    read: async id => { reads++; return { ...session.value, id, review: { blindSaved: true } }; },
  });
  await advance();
  assert.equal(result.review.blindSaved, true);
  assert.equal(c.stages.value.blind.phase, "finalized");
  assert.equal(saves, 0); assert.equal(submissions, 1); assert.equal(reads, 1);
  assert.equal(c.drafts.value.blind.thesis, "clicked");
});

test("a failed result check releases busy, blocks edits, and retries only a read", async t => {
  const { c, session, advance } = setup(t);
  let posts = 0;
  await c.finalize("blind", { thesis: "kept" }, {
    submit: async () => { posts++; return null; }, read: async () => null,
  });
  assert.equal(c.stages.value.blind.phase, "uncertain");
  assert.equal(c.stages.value.blind.finalizing, false);
  assert.equal(c.stages.value.blind.canEdit, false);
  assert.equal(await c.deleteDraft("blind"), false);
  c.queueDraft("blind", { thesis: "must not replace" }); await advance();
  assert.equal(c.drafts.value.blind.thesis, "kept");
  await c.confirmFinal("blind", async () => ({ ...session.value, review: { blindSaved: true } }));
  assert.equal(posts, 1);
  assert.equal(c.stages.value.blind.phase, "finalized");
});

test("finalization drains a delete and accepts only one final submission", async t => {
  const deletion = deferred(), events = [];
  const { c, session } = setup(t, { deleteReplayReviewDraft: async () => { events.push("delete"); return deletion.promise; } });
  const deleting = c.deleteDraft("blind"); await flush();
  const callbacks = { submit: async () => { events.push("final"); return { ...session.value, review: { blindSaved: true } }; }, read: async () => null };
  const finalizing = c.finalize("blind", { thesis: "captured" }, callbacks);
  assert.equal(await c.finalize("blind", { thesis: "duplicate" }, callbacks), null);
  assert.deepEqual(events, ["delete"]);
  deletion.resolve({ revision: 1 }); await deleting; await finalizing;
  assert.deepEqual(events, ["delete", "final"]);
});

test("a verified unsaved final result restores editing and autosaves the captured content", async t => {
  const saves = [];
  const { c, session, advance } = setup(t, { saveReplayReviewDraft: async (_id, _stage, data, revision) => {
    saves.push({ data, revision }); return { draft: { data, revision: revision + 1 } };
  } });
  assert.equal(await c.finalize("blind", { thesis: "kept after failure" }, { submit: async () => null, read: async () => session.value }), null);
  assert.equal(c.stages.value.blind.canEdit, true);
  await advance();
  assert.deepEqual(saves, [{ data: { thesis: "kept after failure" }, revision: 0 }]);
});

for (const manual of [false, true]) test(`an unsaved ${manual ? "manual" : "automatic"} confirmation adopts a lost draft write revision without replacing the click snapshot`, async t => {
  const writes = [];
  let revision = 0, stored = null, submissions = 0;
  const { c, session, advance } = setup(t, {
    saveReplayReviewDraft: async (_id, _stage, data, expectedRevision) => {
      writes.push({ data, revision: expectedRevision });
      assert.equal(expectedRevision, revision);
      stored = data; revision++;
      if (writes.length === 1) throw new Error("committed but response lost");
      return { draft: { data, revision } };
    },
  });
  c.queueDraft("blind", { thesis: "earlier committed draft" }); await advance();
  assert.equal(c.statuses.value.blind, "failed");
  const token = c.stages.value.blind.restoreToken;
  const read = async () => {
    session.value = practice("A", revision, stored);
    return session.value;
  };
  await c.finalize("blind", { thesis: "captured at final click" }, {
    submit: async () => { submissions++; return null; }, read: manual ? async () => null : read,
  });
  if (manual) {
    assert.equal(c.stages.value.blind.phase, "uncertain");
    await advance(); assert.equal(writes.length, 1);
    await c.confirmFinal("blind", read);
  }
  assert.equal(c.stages.value.blind.restoreToken, token);
  assert.deepEqual(c.drafts.value.blind, { thesis: "captured at final click" });
  await advance();
  assert.deepEqual(writes, [
    { data: { thesis: "earlier committed draft" }, revision: 0 },
    { data: { thesis: "captured at final click" }, revision: 1 },
  ]);
  assert.equal(c.statuses.value.blind, "saved");
  assert.equal(submissions, 1);
});

test("an unsaved confirmation accepts a deletion tombstone revision and retains the captured content", async t => {
  const writes = [];
  const { c, session, advance } = setup(t, {
    saveReplayReviewDraft: async (_id, _stage, data, revision) => {
      writes.push({ data, revision }); return { draft: { data, revision: revision + 1 } };
    },
  }, practice("A", 1, { thesis: "before another window deleted" }));
  const token = c.stages.value.blind.restoreToken;
  await c.finalize("blind", { thesis: "captured content" }, { submit: async () => null, read: async () => {
    session.value = practice("A", 2, null); return session.value;
  } });
  await advance();
  assert.deepEqual(writes, [{ data: { thesis: "captured content" }, revision: 2 }]);
  assert.equal(c.stages.value.blind.restoreToken, token);
  assert.equal(c.statuses.value.blind, "saved");
});

test("a failed deletion restores the old text only when there is no newer input", async t => {
  const deletion = deferred();
  const { c } = setup(t, { deleteReplayReviewDraft: async () => deletion.promise }, practice("A", 1, { thesis: "original" }));
  const token = c.stages.value.blind.restoreToken;
  const deleting = c.deleteDraft("blind"); await flush(); deletion.reject(new Error("offline"));
  assert.equal(await deleting, false);
  assert.equal(c.drafts.value.blind.thesis, "original");
  assert.notEqual(c.stages.value.blind.restoreToken, token);
  assert.equal(c.statuses.value.blind, "failed");
});

test("late save replies cannot restore a draft after disposing its owner", async t => {
  const reply = deferred();
  const { c, advance } = setup(t, { saveReplayReviewDraft: async () => reply.promise });
  c.queueDraft("blind", { thesis: "old" }); await advance();
  c.dispose(); reply.resolve({ draft: { data: { thesis: "old" }, revision: 1 } }); await flush();
  assert.equal(c.drafts.value.blind, null);
  assert.equal(c.stages.value.blind.canEdit, false);
});

test("switching sessions while a final submit settles cannot clear the new draft", async t => {
  const reply = deferred();
  const { c, session } = setup(t);
  const finalizing = c.finalize("blind", { thesis: "A captured" }, { submit: async () => reply.promise, read: async () => null });
  session.value = practice("B", 2, { thesis: "B retained" }); await nextTick();
  reply.resolve({ ...practice(), review: { blindSaved: true } }); await finalizing;
  assert.equal(c.drafts.value.blind.thesis, "B retained");
  assert.equal(c.stages.value.blind.canEdit, true);
});

test("an in-flight final confirmation remains a review activity rather than a page restoration", async t => {
  const entered = deferred(), reply = deferred(), scope = effectScope();
  t.after(() => scope.stop());
  let reads = 0;
  const controller = useReplaySession({ restoreOnMount: false,
    storage: { getItem: () => "A", setItem() {}, removeItem() {} },
    client: {
      getReplaySession: async () => { if (++reads === 1) return { session: practice() }; entered.resolve(); return reply.promise; },
      saveReplayBlindReview: async () => { throw new Error("response lost"); },
    },
  });
  await controller.syncStoredSession();
  const drafts = scope.run(() => useReplayReviewDrafts({ session: controller.session }));
  const attempt = useReplayAttempt({ sessionController: controller, reviewDraftController: drafts,
    autoplayController: { playing: shallowRef(false), speed: shallowRef("1"), message: shallowRef(""), pause() {}, toggle() {}, setSpeed() {} } });
  const saving = attempt.commands.saveBlindReview({ thesis: "captured" });
  await entered.promise;
  const activity = attempt.state.value.activity;
  reply.resolve({ session: { ...practice(), review: { blindSaved: true } } }); await saving;
  assert.equal(activity, "savingBlindReview");
  assert.equal(attempt.state.value.isBusy, false);
});
