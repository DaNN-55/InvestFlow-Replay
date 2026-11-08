import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
} from "vue";

import { api } from "../services/api.js";
import { createReviewDraftFlow, transitionReviewDraft, reviewDraftView, reviewStageLocked } from "../utils/replayReviewDraftFlow.js";

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

export function useReplayReviewDrafts({ session, apiClient = api, debounceMs = 600 } = {}) {
  const flows = shallowRef({});
  const timers = { blind: null, post: null };
  const work = { blind: null, post: null };
  const deletions = { blind: null, post: null };
  let epoch = 0;

  const drafts = computed(() => Object.fromEntries(STAGES.map(stage => [stage, flows.value[stage].draft])));
  const stages = computed(() => Object.fromEntries(STAGES.map(stage => [stage, reviewDraftView(flows.value[stage])])));
  const statuses = computed(() => Object.fromEntries(STAGES.map(stage => [stage, stages.value[stage].status])));
  const current = context => context.epoch === epoch && context.sessionId === session.value?.id;
  function dispatch(stage, event) {
    flows.value = { ...flows.value, [stage]: transitionReviewDraft(flows.value[stage], event) };
  }
  function clearTimer(stage) {
    if (timers[stage] !== null) clearTimeout(timers[stage]);
    timers[stage] = null;
  }
  function restore(nextSession) {
    epoch++;
    for (const stage of STAGES) {
      clearTimer(stage);
      work[stage] = null;
      deletions[stage]?.resolve(false);
      deletions[stage] = null;
    }
    flows.value = Object.fromEntries(STAGES.map(stage => {
      const record = nextSession?.reviewDrafts?.[stage];
      return [stage, createReviewDraftFlow({ sessionId: nextSession?.id ?? "", epoch,
        draft: unwrapDraft(record), revision: readDraftRevision(record), locked: reviewStageLocked(nextSession, stage) })];
    }));
  }
  function schedule(stage) {
    clearTimer(stage);
    const context = flows.value[stage];
    timers[stage] = setTimeout(() => {
      timers[stage] = null;
      if (!current(context)) return;
      dispatch(stage, { type: "saveDue", version: context.version });
      drain(stage);
    }, debounceMs);
  }
  function drain(stage) {
    const state = flows.value[stage];
    if (work[stage] || !current(state)) return;
    const deletion = state.deletion;
    const saving = state.phase === "editing" && state.saveReady && state.version !== state.cleanVersion;
    if (!deletion && !saving) return;
    const request = { sessionId: state.sessionId, epoch: state.epoch, kind: deletion ? "delete" : "save",
      version: deletion?.version ?? state.version, previous: deletion?.previous,
      draft: state.draft, revision: state.revision };
    const job = { request, promise: null };
    work[stage] = job;
    dispatch(stage, { type: "requestStarted", request });
    job.promise = Promise.resolve().then(async () => {
      let accepted = false;
      try {
        const result = request.kind === "delete"
          ? await apiClient.deleteReplayReviewDraft(request.sessionId, stage, request.revision)
          : await apiClient.saveReplayReviewDraft(request.sessionId, stage, request.draft, request.revision);
        const revision = request.kind === "delete" ? result?.revision : requireDraftRevision(result?.draft);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("服务端草稿 revision 无效");
        if (current(request)) {
          dispatch(stage, { type: "requestSucceeded", request, revision, draft: unwrapDraft(result?.draft) ?? request.draft });
          accepted = true;
        }
      } catch (error) {
        if (current(request)) dispatch(stage, { type: "requestFailed", request, message: error?.message ?? "草稿保存失败" });
      } finally {
        const waiting = deletions[stage];
        if (request.kind === "delete" && waiting?.epoch === request.epoch && waiting.version === request.version) {
          waiting.resolve(accepted); deletions[stage] = null;
        }
        if (work[stage] === job) { work[stage] = null; drain(stage); }
      }
      return accepted;
    });
  }
  function queueDraft(stage, draft) {
    if (!STAGES.includes(stage) || !stages.value[stage].canEdit) return;
    dispatch(stage, { type: "edited", draft });
    schedule(stage);
  }
  function deleteDraft(stage) {
    if (!STAGES.includes(stage) || !stages.value[stage].canDelete) return Promise.resolve(false);
    clearTimer(stage);
    dispatch(stage, { type: "deleteRequested" });
    const context = flows.value[stage];
    const promise = new Promise(resolve => { deletions[stage] = { epoch, version: context.version, resolve }; });
    drain(stage);
    return promise;
  }
  async function checkFinal(stage, read, context) {
    if (!current(context)) return null;
    dispatch(stage, { type: "checking" });
    let latest, revision;
    try {
      latest = await read(context.sessionId);
      if (latest?.id === context.sessionId && !reviewStageLocked(latest, stage)) {
        revision = readDraftRevision(latest.reviewDrafts?.[stage]);
      }
    } catch { latest = null; /* Keep the captured draft until a read can confirm the outcome. */ }
    if (!current(context)) return null;
    if (!latest || latest.id !== context.sessionId) {
      dispatch(stage, { type: "uncertain" });
      return null;
    }
    if (reviewStageLocked(latest, stage)) {
      dispatch(stage, { type: "confirmed", owned: false });
      return latest;
    }
    dispatch(stage, { type: "notSaved", revision });
    schedule(stage);
    return null;
  }
  async function finalize(stage, payload, { submit, read }) {
    if (!STAGES.includes(stage) || !stages.value[stage].canEdit) return null;
    clearTimer(stage);
    const snapshot = structuredClone(payload);
    dispatch(stage, { type: "finalStarted", payload: snapshot });
    const context = flows.value[stage];
    while (current(context) && (work[stage] || flows.value[stage].deletion)) {
      drain(stage);
      if (work[stage]) await work[stage].promise;
    }
    if (!current(context)) return null;
    if (reviewStageLocked(session.value, stage)) {
      dispatch(stage, { type: "confirmed", owned: false });
      return session.value;
    }
    let saved = null;
    try { saved = await submit(snapshot); } catch { /* Reconcile even if an injected submitter rejects unexpectedly. */ }
    if (!current(context)) return null;
    if (saved?.id === context.sessionId && reviewStageLocked(saved, stage)) {
      dispatch(stage, { type: "confirmed", owned: true });
      return saved;
    }
    return checkFinal(stage, read, context);
  }
  function confirmFinal(stage, read) {
    if (!STAGES.includes(stage) || flows.value[stage].phase !== "uncertain") return Promise.resolve(null);
    return checkFinal(stage, read, flows.value[stage]);
  }
  function dispose() {
    restore(null);
  }
  watch(() => session.value?.id, () => restore(session.value), { immediate: true, flush: "sync" });
  watch(() => STAGES.map(stage => [session.value?.id, session.value?.reviewDrafts?.[stage]?.revision,
    session.value?.reviewDrafts?.[stage]?.updatedAt, reviewStageLocked(session.value, stage)]), (values, previous) => {
    if (values[0][0] !== previous?.[0][0]) return;
    for (let i = 0; i < STAGES.length; i++) {
      if (values[i].every((value, index) => value === previous?.[i][index])) continue;
      const stage = STAGES[i], state = flows.value[stage];
      if (["finalizing", "checking"].includes(state.phase)) continue;
      if (reviewStageLocked(session.value, stage)) {
        clearTimer(stage);
        dispatch(stage, { type: "confirmed", owned: false });
        deletions[stage]?.resolve(false); deletions[stage] = null;
      } else {
        const record = session.value?.reviewDrafts?.[stage];
        dispatch(stage, { type: "restored", draft: unwrapDraft(record), revision: readDraftRevision(record) });
      }
    }
  }, { flush: "sync" });
  onScopeDispose(dispose);
  return { drafts, statuses, stages, queueDraft, deleteDraft, finalize, confirmFinal, restore, dispose };
}
