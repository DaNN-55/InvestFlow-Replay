export function reviewStageLocked(session, stage) {
  const review = session?.review ?? {};
  return stage === "blind"
    ? Boolean(session?.revealed || review.blindSaved || review.blindReview)
    : Boolean(review.postSaved || review.postReview);
}

export function createReviewDraftFlow({ sessionId, epoch, draft, revision, locked }) {
  return { sessionId, epoch, draft, revision, phase: locked ? "finalized" : "editing",
    version: 0, cleanVersion: 0, hydration: 0, request: null, deletion: null, saveReady: false, issue: null };
}

export function transitionReviewDraft(state, event) {
  switch (event.type) {
    case "edited":
      return { ...state, draft: event.draft, version: state.version + 1, saveReady: false, issue: null };
    case "deleteRequested":
      return { ...state, draft: null, version: state.version + 1, saveReady: false, issue: null,
        deletion: { version: state.version + 1, previous: state.draft } };
    case "saveDue":
      return event.version === state.version && state.phase === "editing" ? { ...state, saveReady: true } : state;
    case "requestStarted":
      return { ...state, request: event.request,
        deletion: event.request.kind === "delete" ? null : state.deletion,
        saveReady: event.request.kind === "save" ? false : state.saveReady };
    case "requestSucceeded": {
      if (state.request !== event.request) return state;
      const latest = state.version === event.request.version && state.phase === "editing";
      return { ...state, request: null, revision: event.revision,
        ...(latest ? { draft: event.request.kind === "delete" ? null : event.draft,
          cleanVersion: state.version, issue: state.issue?.kind === "draft" ? null : state.issue } : {}) };
    }
    case "requestFailed": {
      if (state.request !== event.request) return state;
      const latest = state.version === event.request.version && state.phase === "editing";
      const rollback = latest && event.request.kind === "delete";
      return { ...state, request: null,
        ...(latest ? { issue: { kind: "draft", message: event.message } } : {}),
        ...(rollback ? { draft: event.request.previous, cleanVersion: state.version, hydration: state.hydration + 1 } : {}) };
    }
    case "restored":
      if (state.phase !== "editing" || state.request || state.deletion || state.version !== state.cleanVersion || event.revision < state.revision) return state;
      return { ...state, draft: event.draft, revision: event.revision, hydration: state.hydration + 1, issue: null };
    case "finalStarted":
      return { ...state, phase: "finalizing", draft: event.payload, version: state.version + 1, saveReady: false, issue: null };
    case "checking":
      return { ...state, phase: "checking", saveReady: false };
    case "confirmed":
      return { ...state, phase: "finalized", draft: event.owned ? null : state.draft,
        saveReady: false, deletion: null, issue: null };
    case "notSaved":
      return { ...state, phase: "editing", revision: Math.max(state.revision, event.revision), saveReady: false,
        issue: { kind: "final", message: "正式记录尚未保存，内容已保留，请确认后重新提交。" } };
    case "uncertain":
      return { ...state, phase: "uncertain", saveReady: false,
        issue: { kind: "confirmation", message: "提交结果尚未确认，请重新核对后继续。" } };
    default:
      throw new Error(`Unknown review draft event: ${event.type}`);
  }
}

export function reviewDraftView(state) {
  const finalizing = ["finalizing", "checking"].includes(state.phase);
  const latestRequest = state.request?.version === state.version || state.deletion?.version === state.version;
  const status = state.phase === "finalized" ? "saved"
    : state.phase === "uncertain" ? "uncertain" : state.issue?.kind === "draft" ? "failed"
      : finalizing || latestRequest ? "saving"
        : state.version !== state.cleanVersion ? "unsaved" : state.draft ? "saved" : "unsaved";
  return { phase: state.phase, status, canEdit: Boolean(state.sessionId) && state.phase === "editing",
    canDelete: Boolean(state.sessionId) && state.phase === "editing" && !state.deletion && state.request?.kind !== "delete",
    finalizing, needsConfirmation: state.phase === "uncertain",
    restoreToken: `${state.epoch}:${state.hydration}`,
    allowPrefill: state.phase === "editing" && state.version === 0 && state.revision === 0 && !state.draft,
    message: state.issue && state.issue.kind !== "draft" ? state.issue.message : "" };
}
