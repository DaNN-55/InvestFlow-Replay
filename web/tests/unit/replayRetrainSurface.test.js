import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { api } from "../../src/services/api.js";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const apiSource = read("../../src/services/api.js");
const viewSource = read("../../src/views/MarketReplayView.vue");
const composableSource = read("../../src/composables/useReplayHistory.js");
const sessionComposableSource = read(
  "../../src/composables/useReplaySession.js",
);
const recordsSource = read(
  "../../src/components/replay-history/ReplayHistoryRecords.vue",
);
const filtersSource = read(
  "../../src/components/replay-history/ReplayHistoryFilters.vue",
);
const listSource = read(
  "../../src/components/replay-history/ReplayHistoryList.vue",
);
const detailSource = read(
  "../../src/components/replay-history/ReplayHistoryDetail.vue",
);
const contextUrl = new URL(
  "../../src/components/replay/ReplayAttemptContext.vue",
  import.meta.url,
);
const contextSource = readFileSync(contextUrl, "utf8");

describe("replay retrain frontend surface", () => {
  it("posts the retrain service to the encoded source-session endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestCall = null;
    globalThis.fetch = async (path, options) => {
      requestCall = { path, options };
      return {
        ok: true,
        status: 201,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ session: { id: "new-session" } }),
      };
    };
    try {
      const result = await api.retrainReplaySession("source/id");
      assert.equal(requestCall.path, "/api/quant/replay/sessions/source%2Fid/retrain");
      assert.equal(requestCall.options.method, "POST");
      assert.equal(result.session.id, "new-session");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.match(apiSource, /retrainReplaySession\(sessionId\)/u);
  });

  it("shows a legacy-safe first-attempt or a clearly excluded retrain context", () => {
    assert.equal(existsSync(contextUrl), true);
    assert.match(viewSource, /ReplayAttemptContext/u);
    assert.match(viewSource, /:attempt-info="session\.attemptInfo"/u);
    assert.match(contextSource, /getReplayAttemptPresentation/u);
    assert.match(contextSource, /首次匿名作答/u);
    assert.match(contextSource, /不计入首次盲测成绩/u);
    assert.match(contextSource, /overflow-wrap: anywhere/u);
  });

  it("passes all, first and retrain filters through the history query", () => {
    assert.match(composableSource, /const attemptKind = ref\("all"\)/u);
    assert.match(composableSource, /attemptKind: attemptKind\.value/u);
    assert.match(
      composableSource,
      /attemptKind\.value = filters\.attemptKind \?\? attemptKind\.value/u,
    );
    assert.match(filtersSource, /全部训练/u);
    assert.match(filtersSource, /首次盲测/u);
    assert.match(filtersSource, /已知复练/u);
    assert.match(recordsSource, /:attempt-kind="attemptKind"/u);
  });

  it("keeps retrain submission local, guarded and opens only the returned session", () => {
    assert.match(recordsSource, /const retrainStates = reactive\(\{\}\)/u);
    assert.match(recordsSource, /if \(current\.loading\)/u);
    assert.match(recordsSource, /api\.retrainReplaySession\(item\.id\)/u);
    assert.match(recordsSource, /result\.session\?\.id/u);
    assert.match(
      recordsSource,
      /investflow\.replay\.active-session-id/u,
    );
    assert.match(recordsSource, /@retrain="retrainReplay"/u);
    assert.match(detailSource, /v-if="item\.revealed"/u);
    assert.match(detailSource, /复练此行情/u);
    assert.match(detailSource, /:loading="retrainState\.loading"/u);
    assert.match(detailSource, /retrainState\.error/u);
    assert.match(sessionComposableSource, /async function syncStoredSession/u);
    assert.match(
      sessionComposableSource,
      /refreshSession\(\{ sessionId \}\)/u,
    );
    assert.match(viewSource, /onActivated\(syncStoredSession\)/u);
  });

  it("labels retrain scores without hiding them in list and detail", () => {
    assert.match(listSource, /getReplayAttemptPresentation\(item\.attemptInfo\)/u);
    assert.match(listSource, /复练成绩，不计入首次盲测统计/u);
    assert.match(detailSource, /attemptPresentation\.label/u);
    assert.match(detailSource, /attemptPresentation\.scoreNote/u);
    assert.match(detailSource, /item\.scoreCard/u);
    assert.match(detailSource, /@media \(max-width: 720px\)/u);
  });
});
