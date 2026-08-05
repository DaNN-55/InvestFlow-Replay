import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, nextTick, shallowRef } from "vue";

import { useReplayReviewDrafts } from "../../src/composables/useReplayReviewDrafts.js";
import { api as workbenchApi } from "../../src/services/api.js";
import { buildReplayBlindReviewPayload } from "../../src/utils/replayReviewPresentation.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createApi() {
  const saves = [];
  const deletes = [];
  const revisions = { blind: 0, post: 0 };
  return {
    saves,
    deletes,
    async saveReplayReviewDraft(
      sessionId,
      stage,
      draft,
      expectedRevision,
    ) {
      saves.push({ sessionId, stage, draft, expectedRevision });
      assert.equal(expectedRevision, revisions[stage]);
      revisions[stage] += 1;
      return {
        saved: true,
        draft: {
          stage,
          data: draft,
          revision: revisions[stage],
          updatedAt: "now",
        },
      };
    },
    async deleteReplayReviewDraft(sessionId, stage, expectedRevision) {
      deletes.push({ sessionId, stage, expectedRevision });
      assert.equal(expectedRevision, revisions[stage]);
      revisions[stage] += 1;
      return { deleted: true, revision: revisions[stage] };
    },
  };
}

describe("replay review draft autosave", () => {
  it("sends the draft CAS revision through the real API client", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (path, options) => {
      calls.push({
        path,
        method: options.method,
        body: JSON.parse(options.body),
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () =>
          JSON.stringify(
            options.method === "DELETE"
              ? { deleted: true, revision: 8 }
              : {
                  saved: true,
                  draft: {
                    stage: "blind",
                    data: { thesis: "真实请求" },
                    revision: 8,
                    updatedAt: "now",
                  },
                },
          ),
      };
    };

    try {
      await workbenchApi.saveReplayReviewDraft(
        "session / 1",
        "blind",
        { thesis: "真实请求" },
        7,
      );
      await workbenchApi.deleteReplayReviewDraft(
        "session / 1",
        "blind",
        8,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(calls, [
      {
        path:
          "/api/quant/replay/sessions/session%20%2F%201/reviews/blind/draft",
        method: "PUT",
        body: {
          draft: { thesis: "真实请求" },
          expectedRevision: 7,
        },
      },
      {
        path:
          "/api/quant/replay/sessions/session%20%2F%201/reviews/blind/draft",
        method: "DELETE",
        body: { expectedRevision: 8 },
      },
    ]);
  });

  it("restores server drafts and saves only the latest debounced input", async () => {
    const api = createApi();
    const session = shallowRef({
      id: "session-1",
      reviewDrafts: {
        blind: {
          stage: "blind",
          data: { thesis: "服务端草稿" },
          revision: 0,
        },
      },
    });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 10 }),
    );

    assert.equal(state.drafts.value.blind.thesis, "服务端草稿");
    assert.equal(state.statuses.value.blind, "saved");

    state.queueDraft("blind", { thesis: "第一次输入" });
    state.queueDraft("blind", { thesis: "最终输入" });
    assert.equal(state.statuses.value.blind, "unsaved");
    await wait(25);

    assert.deepEqual(api.saves, [
      {
        sessionId: "session-1",
        stage: "blind",
        draft: { thesis: "最终输入" },
        expectedRevision: 0,
      },
    ]);
    assert.equal(state.statuses.value.blind, "saved");
    scope.stop();
  });

  it("cancels stale timers and restores the selected session draft", async () => {
    const api = createApi();
    const session = shallowRef({ id: "session-1", reviewDrafts: {} });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 15 }),
    );
    state.queueDraft("blind", { thesis: "不能写入旧会话" });

    session.value = {
      id: "session-2",
      reviewDrafts: {
        blind: { data: { thesis: "第二局草稿" }, revision: 0 },
      },
    };
    await nextTick();
    await wait(25);

    assert.deepEqual(api.saves, []);
    assert.equal(state.drafts.value.blind.thesis, "第二局草稿");
    assert.equal(state.statuses.value.blind, "saved");
    scope.stop();
  });

  it("restores a refreshed server draft for the same clean session", async () => {
    const api = createApi();
    const session = shallowRef({
      id: "session-1",
      reviewDrafts: {
        blind: {
          data: { thesis: "旧服务端草稿" },
          revision: 1,
          updatedAt: "2026-07-30T10:00:00.000Z",
        },
      },
    });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 10 }),
    );

    session.value = {
      ...session.value,
      reviewDrafts: {
        blind: {
          data: { thesis: "刷新后的服务端草稿" },
          revision: 2,
          updatedAt: "2026-07-30T10:01:00.000Z",
        },
      },
    };
    await nextTick();

    assert.equal(state.drafts.value.blind.thesis, "刷新后的服务端草稿");
    scope.stop();
  });

  it("does not let a stale debounce write after final submission starts", async () => {
    const api = createApi();
    const session = shallowRef({ id: "session-1", reviewDrafts: {} });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 10 }),
    );

    state.queueDraft("blind", { thesis: "即将冻结" });
    state.prepareFinal("blind");
    await wait(20);
    state.finishFinal("blind", true);

    assert.deepEqual(api.saves, []);
    assert.equal(state.drafts.value.blind, null);
    scope.stop();
  });

  it("autosaves an enabled invalidation rule before its price is filled", async () => {
    const api = createApi();
    const session = shallowRef({ id: "session-1", reviewDrafts: {} });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 10 }),
    );
    const draft = buildReplayBlindReviewPayload({
      strategyName: "",
      thesis: "",
      tradePlan: "",
      riskPlan: "",
      confidence: 3,
      reasonTags: [],
      invalidationRule: {
        basis: "close",
        operator: "lte",
        threshold: "",
        note: "",
      },
    });

    state.queueDraft("blind", draft);
    await wait(20);

    assert.equal(api.saves.length, 1);
    assert.deepEqual(api.saves[0].draft.invalidationRule, {
      basis: "close",
      operator: "lte",
      note: "",
    });
    scope.stop();
  });

  it("serializes saves and carries the accepted revision to the newest draft", async () => {
    const saves = [];
    let resolveFirst;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const api = {
      saveReplayReviewDraft(
        sessionId,
        stage,
        draft,
        expectedRevision,
      ) {
        saves.push({ sessionId, stage, draft, expectedRevision });
        if (saves.length === 1) {
          return firstResponse;
        }
        return Promise.resolve({
          saved: true,
          draft: {
            stage,
            data: draft,
            revision: 2,
            updatedAt: "second",
          },
        });
      },
      async deleteReplayReviewDraft() {
        return { deleted: false, revision: 0 };
      },
    };
    const session = shallowRef({ id: "session-1", reviewDrafts: {} });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 5 }),
    );

    state.queueDraft("blind", { thesis: "先发出的旧草稿" });
    await wait(10);
    state.queueDraft("blind", { thesis: "后输入的新草稿" });
    await wait(10);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].expectedRevision, 0);

    resolveFirst({
      saved: true,
      draft: {
        stage: "blind",
        data: saves[0].draft,
        revision: 1,
        updatedAt: "first",
      },
    });
    await wait(15);

    assert.deepEqual(saves, [
      {
        sessionId: "session-1",
        stage: "blind",
        draft: { thesis: "先发出的旧草稿" },
        expectedRevision: 0,
      },
      {
        sessionId: "session-1",
        stage: "blind",
        draft: { thesis: "后输入的新草稿" },
        expectedRevision: 1,
      },
    ]);
    assert.equal(state.drafts.value.blind.thesis, "后输入的新草稿");
    assert.equal(state.statuses.value.blind, "saved");
    scope.stop();
  });

  it("uses the tombstone revision after deleting an empty draft", async () => {
    const api = createApi();
    const session = shallowRef({ id: "session-1", reviewDrafts: {} });
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 5 }),
    );

    assert.equal(await state.deleteDraft("blind"), true);
    state.queueDraft("blind", { thesis: "删除之后的新输入" });
    await wait(15);

    assert.deepEqual(api.deletes, [
      {
        sessionId: "session-1",
        stage: "blind",
        expectedRevision: 0,
      },
    ]);
    assert.deepEqual(api.saves, [
      {
        sessionId: "session-1",
        stage: "blind",
        draft: { thesis: "删除之后的新输入" },
        expectedRevision: 1,
      },
    ]);
    scope.stop();
  });

  it("deletes a saved draft and clears pending work on disposal", async () => {
    const api = createApi();
    const session = shallowRef({
      id: "session-1",
      reviewDrafts: {
        post: {
          data: { lessons: "待删除" },
          revision: 4,
          updatedAt: "now",
        },
      },
    });
    api.deleteReplayReviewDraft = async (
      sessionId,
      stage,
      expectedRevision,
    ) => {
      api.deletes.push({ sessionId, stage, expectedRevision });
      return { deleted: true, revision: expectedRevision + 1 };
    };
    const scope = effectScope();
    const state = scope.run(() =>
      useReplayReviewDrafts({ session, apiClient: api, debounceMs: 10 }),
    );

    assert.equal(await state.deleteDraft("post"), true);
    assert.deepEqual(api.deletes, [
      {
        sessionId: "session-1",
        stage: "post",
        expectedRevision: 4,
      },
    ]);
    state.queueDraft("blind", { thesis: "卸载后不得写入" });
    scope.stop();
    await wait(20);

    assert.deepEqual(api.saves, []);
  });
});
