import {
  onScopeDispose,
  readonly,
  shallowRef,
  watch,
} from "vue";

import { api } from "../services/api.js";

export const REPLAY_REVIEW_DRAFT_STATUS_LABELS = Object.freeze({
  unsaved: "未保存",
  saving: "保存中",
  saved: "已自动保存",
  failed: "保存失败",
});

const STAGES = ["blind", "post"];

function unwrapDraft(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (Object.hasOwn(record, "data")) {
    return record.data;
  }
  if (Object.hasOwn(record, "draft")) {
    return record.draft;
  }
  return record;
}

function readDraftRevision(record) {
  if (!record || typeof record !== "object") {
    return 0;
  }
  if (!Object.hasOwn(record, "revision")) {
    if (
      Object.hasOwn(record, "data") ||
      Object.hasOwn(record, "draft") ||
      Object.hasOwn(record, "stage") ||
      Object.hasOwn(record, "updatedAt")
    ) {
      throw new Error("服务端草稿缺少 revision");
    }
    return 0;
  }
  const revision = record.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("服务端草稿 revision 无效");
  }
  return revision;
}

function requireDraftRevision(record) {
  if (
    !record ||
    typeof record !== "object" ||
    !Object.hasOwn(record, "revision")
  ) {
    throw new Error("服务端草稿缺少 revision");
  }
  return readDraftRevision(record);
}

export function useReplayReviewDrafts({
  session,
  apiClient = api,
  debounceMs = 600,
} = {}) {
  const drafts = shallowRef({ blind: null, post: null });
  const statuses = shallowRef({ blind: "unsaved", post: "unsaved" });
  const timers = { blind: null, post: null };
  const inFlight = { blind: null, post: null };
  const generations = { blind: 0, post: 0 };
  const finalizing = { blind: false, post: false };
  const dirty = { blind: false, post: false };
  const revisions = { blind: 0, post: 0 };
  let activeSessionId = "";

  function replaceDraft(stage, draft) {
    drafts.value = { ...drafts.value, [stage]: draft };
  }

  function replaceStatus(stage, status) {
    statuses.value = { ...statuses.value, [stage]: status };
  }

  function clearTimer(stage) {
    if (timers[stage] != null) {
      clearTimeout(timers[stage]);
      timers[stage] = null;
    }
  }

  function restore(nextSession) {
    for (const stage of STAGES) {
      clearTimer(stage);
      generations[stage] += 1;
      finalizing[stage] = false;
      dirty[stage] = false;
    }
    activeSessionId = nextSession?.id ?? "";
    const serverDrafts = nextSession?.reviewDrafts ?? {};
    const blind = unwrapDraft(serverDrafts.blind);
    const post = unwrapDraft(serverDrafts.post);
    revisions.blind = readDraftRevision(serverDrafts.blind);
    revisions.post = readDraftRevision(serverDrafts.post);
    drafts.value = { blind, post };
    statuses.value = {
      blind: blind ? "saved" : "unsaved",
      post: post ? "saved" : "unsaved",
    };
  }

  function restoreStage(stage) {
    if (
      !activeSessionId ||
      dirty[stage] ||
      finalizing[stage]
    ) {
      return;
    }
    const serverDraft = session.value?.reviewDrafts?.[stage];
    const draft = unwrapDraft(serverDraft);
    revisions[stage] = readDraftRevision(serverDraft);
    replaceDraft(stage, draft);
    replaceStatus(stage, draft ? "saved" : "unsaved");
  }

  async function persist(stage, generation, sessionId, draft) {
    timers[stage] = null;
    if (
      finalizing[stage] ||
      generation !== generations[stage] ||
      sessionId !== activeSessionId ||
      session.value?.id !== sessionId
    ) {
      return;
    }
    const activeRequest = inFlight[stage];
    if (activeRequest) {
      await activeRequest.catch(() => {});
      if (
        !finalizing[stage] &&
        generation === generations[stage] &&
        sessionId === activeSessionId &&
        session.value?.id === sessionId
      ) {
        await persist(stage, generation, sessionId, draft);
      }
      return;
    }
    replaceStatus(stage, "saving");
    const expectedRevision = revisions[stage];
    const request = Promise.resolve().then(() =>
      apiClient.saveReplayReviewDraft(
        sessionId,
        stage,
        draft,
        expectedRevision,
      ),
    );
    inFlight[stage] = request;
    try {
      const result = await request;
      const nextRevision = requireDraftRevision(result?.draft);
      if (sessionId === activeSessionId) {
        revisions[stage] = nextRevision;
      }
      if (
        finalizing[stage] ||
        generation !== generations[stage] ||
        sessionId !== activeSessionId
      ) {
        return;
      }
      replaceDraft(stage, unwrapDraft(result?.draft) ?? draft);
      replaceStatus(stage, "saved");
      dirty[stage] = false;
    } catch {
      if (
        !finalizing[stage] &&
        generation === generations[stage] &&
        sessionId === activeSessionId
      ) {
        replaceStatus(stage, "failed");
      }
    } finally {
      if (inFlight[stage] === request) {
        inFlight[stage] = null;
      }
    }
  }

  function queueDraft(stage, draft) {
    if (
      !STAGES.includes(stage) ||
      !activeSessionId ||
      finalizing[stage]
    ) {
      return;
    }
    clearTimer(stage);
    generations[stage] += 1;
    const generation = generations[stage];
    const sessionId = activeSessionId;
    replaceDraft(stage, draft);
    replaceStatus(stage, "unsaved");
    dirty[stage] = true;
    timers[stage] = setTimeout(
      () => persist(stage, generation, sessionId, draft),
      debounceMs,
    );
  }

  async function deleteDraft(stage) {
    if (!STAGES.includes(stage) || !activeSessionId) {
      return false;
    }
    clearTimer(stage);
    generations[stage] += 1;
    const generation = generations[stage];
    const sessionId = activeSessionId;
    const previous = drafts.value[stage];
    replaceDraft(stage, null);
    replaceStatus(stage, "saving");
    dirty[stage] = true;
    try {
      const activeRequest = inFlight[stage];
      if (activeRequest) {
        await activeRequest;
      }
      if (
        generation !== generations[stage] ||
        sessionId !== activeSessionId ||
        session.value?.id !== sessionId
      ) {
        return false;
      }
      const result = await apiClient.deleteReplayReviewDraft(
        sessionId,
        stage,
        revisions[stage],
      );
      const nextRevision = result?.revision;
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) {
        throw new Error("服务端草稿 revision 无效");
      }
      revisions[stage] = nextRevision;
      if (
        generation === generations[stage] &&
        sessionId === activeSessionId
      ) {
        replaceStatus(stage, "unsaved");
        dirty[stage] = false;
      }
      return true;
    } catch {
      if (
        generation === generations[stage] &&
        sessionId === activeSessionId
      ) {
        replaceDraft(stage, previous);
        replaceStatus(stage, "failed");
        dirty[stage] = false;
      }
      return false;
    }
  }

  async function prepareFinal(stage) {
    if (!STAGES.includes(stage)) {
      return;
    }
    clearTimer(stage);
    generations[stage] += 1;
    finalizing[stage] = true;
    if (inFlight[stage]) {
      await inFlight[stage].catch(() => {});
    }
  }

  function finishFinal(stage, saved) {
    if (!STAGES.includes(stage)) {
      return;
    }
    finalizing[stage] = false;
    if (saved) {
      replaceDraft(stage, null);
      replaceStatus(stage, "saved");
      dirty[stage] = false;
      return;
    }
    const draft = drafts.value[stage];
    if (draft) {
      queueDraft(stage, draft);
    }
  }

  function dispose() {
    for (const stage of STAGES) {
      clearTimer(stage);
      generations[stage] += 1;
    }
    activeSessionId = "";
  }

  watch(
    () => session.value?.id,
    () => restore(session.value),
    { immediate: true },
  );
  watch(
    () => [
      session.value?.id,
      session.value?.reviewDrafts?.blind?.updatedAt ?? "",
      session.value?.reviewDrafts?.blind?.revision ?? 0,
      session.value?.reviewDrafts?.post?.updatedAt ?? "",
      session.value?.reviewDrafts?.post?.revision ?? 0,
    ],
    ([
      sessionId,
      blindUpdatedAt,
      blindRevision,
      postUpdatedAt,
      postRevision,
    ], previous) => {
      if (!previous || sessionId !== previous[0]) {
        return;
      }
      if (
        blindUpdatedAt !== previous[1] ||
        blindRevision !== previous[2]
      ) {
        restoreStage("blind");
      }
      if (
        postUpdatedAt !== previous[3] ||
        postRevision !== previous[4]
      ) {
        restoreStage("post");
      }
    },
  );
  onScopeDispose(dispose);

  return {
    drafts: readonly(drafts),
    statuses: readonly(statuses),
    queueDraft,
    deleteDraft,
    prepareFinal,
    finishFinal,
    restore,
    dispose,
  };
}
