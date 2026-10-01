import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, shallowRef } from "vue";

import { useReplaySession } from "../../src/composables/useReplaySession.js";
import { useReplayReviewDrafts } from "../../src/composables/useReplayReviewDrafts.js";

const storageKey = "investflow.replay.active-session-id";

function memoryStorage(id = "session-1") {
  const values = new Map([[storageKey, id]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function activeSession(extra = {}) {
  return {
    id: "session-1", status: "active", revision: 0, revealedFutureBars: 0,
    interval: "1d", gameLength: 20, benchmarkCode: "000001.SH",
    account: { initialCapital: 100000 }, pendingOrders: [], executions: [], ...extra,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("F11 rapid advance clicks issue one request while the first is in flight", async () => {
  const response = deferred();
  let calls = 0;
  const controller = useReplaySession({
    restoreOnMount: false, storage: memoryStorage(),
    client: {
      getReplaySession: async () => ({ session: activeSession() }),
      advanceReplaySession: async () => { calls += 1; return response.promise; },
    },
  });
  await controller.syncStoredSession();
  const first = controller.advanceSession();
  const second = await controller.advanceSession();
  assert.equal(second, null);
  assert.equal(calls, 1);
  assert.equal(controller.isBusy.value, true);
  response.resolve({ session: activeSession({ revision: 1, revealedFutureBars: 1 }) });
  await first;
  assert.equal(controller.session.value.revealedFutureBars, 1);
  assert.equal(controller.isBusy.value, false);
});

test("F11 an advance committed before response loss is reconciled on retry without a second advance", async () => {
  let serverSession = activeSession();
  let commits = 0;
  const requests = [];
  const controller = useReplaySession({
    restoreOnMount: false, storage: memoryStorage(),
    client: {
      getReplaySession: async () => ({ session: structuredClone(serverSession) }),
      async advanceReplaySession(_id, command) {
        requests.push(command);
        if (command.expectedRevision !== serverSession.revision) {
          throw Object.assign(new Error("revision conflict"), { status: 409 });
        }
        commits += 1;
        serverSession = activeSession({ revision: 1, revealedFutureBars: 1 });
        throw new TypeError("connection lost after commit");
      },
    },
  });
  await controller.syncStoredSession();
  await controller.advanceSession();
  assert.equal(controller.session.value.revision, 0);
  assert.match(controller.errorMessage.value, /connection lost/);
  await controller.advanceSession();
  assert.equal(requests.length, 2);
  assert.equal(commits, 1);
  assert.equal(controller.session.value.revision, 1);
  assert.equal(controller.session.value.revealedFutureBars, 1);
  assert.match(controller.statusMessage.value, /已刷新到最新进度/);
  assert.equal(controller.isBusy.value, false);
});

test("F12 finishing succeeds but replacement creation fails: keep the completed session recoverable", async () => {
  const storage = memoryStorage();
  const completed = activeSession({ status: "completed", revision: 1 });
  const controller = useReplaySession({
    restoreOnMount: false, storage,
    client: {
      getReplaySession: async () => ({ session: activeSession() }),
      finishReplaySession: async () => ({ session: completed }),
      createReplaySession: async () => { throw new Error("engine offline"); },
    },
  });
  await controller.syncStoredSession();
  assert.equal(await controller.skipSessionAndRestart(), null);
  assert.equal(controller.session.value.status, "completed");
  assert.equal(storage.getItem(storageKey), "session-1");
  assert.match(controller.errorMessage.value, /上一局已记录.*新行情创建失败/);
  assert.equal(controller.isBusy.value, false);
});

test("F12 cancelled retrain remains recoverable when loading its source fails", async (t) => {
  const storage = memoryStorage("retrain-1");
  let deleted = false;
  let offline = true;
  const reads = [];
  const client = {
    async getReplaySession(id) {
      reads.push(id);
      if (id === "retrain-1") {
        if (deleted) throw Object.assign(new Error("not found"), { status: 404 });
        return { session: activeSession({ id, attemptInfo: { sourceSessionId: "source-1" } }) };
      }
      if (offline) throw new TypeError("source request disconnected");
      return { session: activeSession({ id: "source-1", status: "completed" }) };
    },
    async deleteReplaySession(id) { assert.equal(id, "retrain-1"); deleted = true; },
  };
  const controller = useReplaySession({ client, storage, restoreOnMount: false });
  await controller.syncStoredSession();
  await controller.cancelRetrain();
  assert.equal(deleted, true);
  assert.match(controller.errorMessage.value, /disconnected/);
  assert.equal(controller.session.value, null);
  assert.equal(storage.getItem(storageKey), "source-1");
  t.diagnostic(JSON.stringify({ activeId: controller.session.value?.id, storedId: storage.getItem(storageKey) }));
  offline = false;
  const restored = useReplaySession({ client, storage, restoreOnMount: false });
  await restored.syncStoredSession();
  t.diagnostic(JSON.stringify({ reads, restoredId: restored.session.value?.id ?? null }));
  // A completed delete must not leave the deleted session as the restart target.
  assert.equal(restored.session.value?.id, "source-1");
  assert.equal(storage.getItem(storageKey), "source-1");
});

test("F12 failed retrain deletion keeps the original session and recovery ID", async () => {
  const storage = memoryStorage("retrain-1");
  const controller = useReplaySession({
    storage, restoreOnMount: false,
    client: {
      getReplaySession: async () => ({ session: activeSession({ id: "retrain-1", attemptInfo: { sourceSessionId: "source-1" } }) }),
      deleteReplaySession: async () => { throw new TypeError("delete disconnected"); },
    },
  });
  await controller.syncStoredSession();
  await controller.cancelRetrain();
  assert.equal(controller.session.value.id, "retrain-1");
  assert.equal(storage.getItem(storageKey), "retrain-1");
  assert.match(controller.errorMessage.value, /delete disconnected/);
  assert.equal(controller.isBusy.value, false);
});

test("F12 the source ID is durable before its pending load finishes", async () => {
  const storage = memoryStorage("retrain-1");
  const sourceLoad = deferred();
  const sourceStarted = deferred();
  const controller = useReplaySession({
    storage, restoreOnMount: false,
    client: {
      async getReplaySession(id) {
        if (id === "retrain-1") {
          return { session: activeSession({ id, attemptInfo: { sourceSessionId: "source-1" } }) };
        }
        sourceStarted.resolve();
        return sourceLoad.promise;
      },
      deleteReplaySession: async () => {},
    },
  });
  await controller.syncStoredSession();
  const pending = controller.cancelRetrain();
  await sourceStarted.promise;
  assert.equal(storage.getItem(storageKey), "source-1");
  assert.equal(controller.session.value, null);
  sourceLoad.resolve({ session: activeSession({ id: "source-1" }) });
  await pending;
  assert.equal(controller.session.value.id, "source-1");
  assert.equal(controller.isBusy.value, false);
});

test("F13 a lost acknowledgement followed by a competing draft update preserves both versions on conflict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope();
  t.after(() => scope.stop());
  const session = shallowRef(activeSession({ reviewDrafts: {
    blind: { data: null, revision: 0, updatedAt: "initial" },
    post: { data: null, revision: 0, updatedAt: "initial" },
  } }));
  const calls = [];
  let serverRevision = 0;
  let serverDraft;
  const controller = scope.run(() => useReplayReviewDrafts({
    session, debounceMs: 10,
    apiClient: {
      async saveReplayReviewDraft(_id, _stage, draft, expectedRevision) {
        calls.push(expectedRevision);
        if (expectedRevision !== serverRevision) {
          throw Object.assign(new Error("draft conflict"), { status: 409 });
        }
        serverRevision += 1;
        serverDraft = structuredClone(draft);
        throw new TypeError("acknowledgement lost");
      },
    },
  }));
  async function flushSave() {
    t.mock.timers.tick(10);
    // Drain the promise chain created by persist(), without wall-clock sleeps.
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.queueDraft("blind", { thesis: "已提交但响应丢失" });
  await flushSave();
  assert.equal(controller.statuses.value.blind, "failed");
  const latest = { thesis: "断线后继续写的新判断🧪" };
  controller.queueDraft("blind", latest);
  // Another tab commits before this tab retries: silently overwriting it is unsafe.
  serverRevision += 1;
  serverDraft = { thesis: "另一页已经保存的判断" };
  session.value = { ...session.value, reviewDrafts: {
    ...session.value.reviewDrafts,
    blind: { data: serverDraft, revision: serverRevision, updatedAt: "committed" },
  } };
  await nextTick();
  await flushSave();
  assert.equal(calls.length, 2);
  t.diagnostic(JSON.stringify({ requestedRevisions: calls, serverRevision }));
  assert.equal(serverRevision, 2);
  assert.deepEqual(serverDraft, { thesis: "另一页已经保存的判断" });
  assert.deepEqual(controller.drafts.value.blind, latest);
  assert.equal(controller.statuses.value.blind, "failed");
});
