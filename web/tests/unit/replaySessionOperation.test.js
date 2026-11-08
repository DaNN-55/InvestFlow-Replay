import assert from "node:assert/strict";
import test from "node:test";

import { useReplaySession } from "../../src/composables/useReplaySession.js";

const storageKey = "investflow.replay.active-session-id";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function session(id = "session-a", revision = 0) {
  return { id, revision, status: "active", review: { blindSaved: true } };
}

function memoryStorage() {
  const values = new Map([[storageKey, "session-a"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("deleting a correction claims the operation until the response settles", async () => {
  const pending = deferred();
  let advances = 0;
  const controller = useReplaySession({
    restoreOnMount: false, storage: memoryStorage(),
    client: {
      getReplaySession: async () => ({ session: session() }),
      deleteReplayReviewCorrection: async () => pending.promise,
      advanceReplaySession: async () => {
        advances += 1;
        return { session: session("session-a", 1) };
      },
    },
  });
  await controller.syncStoredSession();
  const deletion = controller.deleteReviewCorrection("correction-1", "blind");
  const busyDuringDelete = controller.isBusy.value;
  const extra = await controller.advanceSession();
  pending.resolve({ session: session("session-a", 1) });
  await deletion;

  assert.equal(busyDuringDelete, true);
  assert.equal(extra, null);
  assert.equal(advances, 0);
  assert.equal(controller.isBusy.value, false);
  assert.equal(controller.statusMessage.value, "复盘修正记录已删除。");
});

test("stored-session synchronization cannot replace an in-flight write target", async () => {
  const pending = deferred();
  const storage = memoryStorage();
  const reads = [];
  const controller = useReplaySession({
    restoreOnMount: false, storage,
    client: {
      getReplaySession: async (id) => {
        reads.push(id);
        return { session: session(id) };
      },
      advanceReplaySession: async () => pending.promise,
    },
  });
  await controller.syncStoredSession();
  const advancing = controller.advanceSession();
  storage.setItem(storageKey, "session-b");
  await controller.syncStoredSession();
  const visibleWhileAdvancing = controller.session.value.id;
  pending.resolve({ session: session("session-a", 1) });
  await advancing;

  assert.equal(visibleWhileAdvancing, "session-a");
  assert.deepEqual(reads, ["session-a"]);
  assert.equal(controller.session.value.revision, 1);
});

test("public refresh blocks clearing or replacing its target until it settles", async () => {
  const pending = deferred();
  const reads = [];
  const controller = useReplaySession({
    restoreOnMount: false, storage: memoryStorage(),
    client: {
      getReplaySession: async (id) => {
        reads.push(id);
        return pending.promise;
      },
    },
  });
  const refresh = controller.refreshSession();
  const busyWhileReading = controller.isBusy.value;
  controller.startNewSession();
  const extra = controller.resumeSession("session-b");
  pending.resolve({ session: session() });
  await Promise.all([refresh, extra]);

  assert.equal(busyWhileReading, true);
  assert.deepEqual(reads, ["session-a"]);
  assert.equal(controller.session.value.id, "session-a");
  assert.equal(controller.isBusy.value, false);
});

const operations = [
  ["create", "creating", "createReplaySession", (c) => c.createSession({}), {}],
  ["submit", "submitting", "submitReplayOrder", (c) => c.submitOrder({}), {}],
  ["cancel order", "submitting", "cancelReplayOrder", (c) => c.cancelOrder("order"), {}],
  ["advance", "advancing", "advanceReplaySession", (c) => c.advanceSession(), {}],
  ["finish", "finishing", "finishReplaySession", (c) => c.finishSession(), {}],
  ["restart", "finishing", "finishReplaySession", (c) => c.skipSessionAndRestart(), {}],
  ["reveal", "revealing", "revealReplaySession", (c) => c.revealSession(), { status: "completed" }],
  ["blind review", "savingBlindReview", "saveReplayBlindReview", (c) => c.saveBlindReview({}), { status: "completed", review: {} }],
  ["post review", "savingPostReview", "saveReplayPostReview", (c) => c.savePostReview({}), { revealed: true }],
  ["blind correction", "savingBlindCorrection", "addReplayBlindReviewCorrection", (c) => c.addBlindReviewCorrection({}), {}],
  ["post correction", "savingPostCorrection", "addReplayPostReviewCorrection", (c) => c.addPostReviewCorrection({}), { revealed: true, review: { postSaved: true } }],
  ["update correction", "savingBlindCorrection", "updateReplayReviewCorrection", (c) => c.updateReviewCorrection("correction", "blind", {}), {}],
  ["delete correction", "savingPostCorrection", "deleteReplayReviewCorrection", (c) => c.deleteReviewCorrection("correction", "post"), {}],
  ["cancel retrain", "cancellingRetrain", "deleteReplaySession", (c) => c.cancelRetrain(), { attemptInfo: { sourceSessionId: "source" } }],
];

for (const [label, activity, method, invoke, overrides] of operations) {
  test(`${label} publishes one activity and settles after success or failure`, async () => {
    let pending = deferred();
    const requests = [];
    const initial = {
      ...session(), interval: "1d", gameLength: 20, benchmarkCode: "000001.SH",
      account: { initialCapital: 100000 }, ...overrides,
    };
    const client = Object.fromEntries(operations.map(([, , name]) => [name, async () => {
      requests.push(name);
      return name === method ? pending.promise : { session: initial };
    }]));
    client.getReplaySession = async (id) => ({ session: { ...initial, id } });
    const controller = useReplaySession({ restoreOnMount: false, storage: memoryStorage(), client });
    await controller.syncStoredSession();
    const first = invoke(controller);
    assert.equal(controller.activity.value, activity);
    assert.equal(controller.isBusy.value, true);
    assert.equal(await controller.createSession({}), null);
    assert.equal(await controller.refreshSession(), null);
    assert.deepEqual(requests, [method]);
    pending.resolve({ session: initial });
    await first;
    assert.equal(controller.activity.value, null);
    assert.equal(controller.isBusy.value, false);

    pending = deferred();
    const second = invoke(controller);
    assert.equal(controller.activity.value, activity);
    assert.equal(controller.errorMessage.value, "");
    assert.equal(controller.statusMessage.value, "");
    pending.reject(new Error("request failed"));
    assert.equal(await second, null);
    assert.equal(controller.activity.value, null);
    assert.equal(controller.isBusy.value, false);
    assert.match(controller.errorMessage.value, /request failed/);
  });
}

for (const readFails of [false, true]) {
  test(`409 synchronization ${readFails ? "failure" : "success"} keeps the original activity and never resends`, async () => {
    const readStarted = deferred(), readReply = deferred();
    let writes = 0;
    const controller = useReplaySession({
      restoreOnMount: false, storage: memoryStorage(),
      client: {
        getReplaySession: async () => {
          if (!writes) return { session: session() };
          readStarted.resolve();
          return readReply.promise;
        },
        advanceReplaySession: async () => {
          writes += 1;
          throw Object.assign(new Error("conflict"), { status: 409 });
        },
      },
    });
    await controller.syncStoredSession();
    const advancing = controller.advanceSession();
    await readStarted.promise;
    controller.clearMessages();
    assert.equal(controller.activity.value, "advancing");
    assert.equal(controller.isBusy.value, true);
    assert.equal(await controller.advanceSession(), null);
    assert.equal(await controller.resumeSession("session-b"), null);
    if (readFails) readReply.reject(new Error("synchronization failed"));
    else readReply.resolve({ session: session("session-a", 3) });
    assert.equal(await advancing, null);
    assert.equal(writes, 1);
    assert.equal(controller.isBusy.value, false);
    assert.equal(controller.activity.value, null);
    if (readFails) assert.equal(controller.errorMessage.value, "synchronization failed");
    else {
      assert.equal(controller.session.value.revision, 3);
      assert.match(controller.statusMessage.value, /已刷新到最新进度/);
    }
  });
}

test("a missing public refresh clears the saved reference and releases the operation", async () => {
  const storage = memoryStorage();
  const controller = useReplaySession({
    restoreOnMount: false, storage,
    client: { getReplaySession: async () => { throw Object.assign(new Error("missing"), { status: 404 }); } },
  });
  assert.equal(await controller.refreshSession(), null);
  assert.equal(controller.session.value, null);
  assert.equal(storage.getItem(storageKey), null);
  assert.equal(controller.isBusy.value, false);
  assert.match(controller.errorMessage.value, /记录不存在/);
});
