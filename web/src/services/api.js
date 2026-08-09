function createRequestError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: "application/json", "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
  if (!response.ok) {
    throw createRequestError(payload?.error?.message ?? `请求失败（${response.status}）`, {
      status: response.status,
      details: payload?.error?.details ?? null,
      raw,
    });
  }
  if (payload != null) return payload;
  throw createRequestError("服务返回格式异常：预期 JSON", { status: response.status, raw });
}

const replaySessionPath = (id) => `/api/quant/replay/sessions/${encodeURIComponent(id)}`;
const tradeRecordPath = (id) => `/api/quant/decision/trade-records/${encodeURIComponent(id)}`;
const json = (method, payload = undefined) => ({
  method,
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

export const api = {
  listReplayBenchmarks: ({ retry = false } = {}) =>
    request(`/api/quant/replay/benchmarks${retry ? "?retry=true" : ""}`),
  getReplayCacheStatus: () => request("/api/quant/replay/cache/status"),
  createReplaySession: (payload = {}) => request("/api/quant/replay/sessions", json("POST", payload)),
  listReplaySessions(params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== ""));
    return request(`/api/quant/replay/sessions?${query}`);
  },
  listReplayPlaybooks() { return request("/api/quant/replay/playbooks"); },
  createReplayPlaybook(payload) { return request("/api/quant/replay/playbooks", json("POST", payload)); },
  renameReplayPlaybook(id, payload) { return request(`/api/quant/replay/playbooks/${encodeURIComponent(id)}`, json("PATCH", payload)); },
  deleteReplayPlaybook(id) { return request(`/api/quant/replay/playbooks/${encodeURIComponent(id)}`, json("DELETE")); },
  getReplayPlaybook(id) { return request(`/api/quant/replay/playbooks/${encodeURIComponent(id)}`); },
  createReplayPlaybookVersion(id, payload) { return request(`/api/quant/replay/playbooks/${encodeURIComponent(id)}/versions`, json("POST", payload)); },
  deleteReplayPlaybookVersion(id, versionId) { return request(`/api/quant/replay/playbooks/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, json("DELETE")); },
  createReplayPlaybookCandidate(payload) { return request("/api/quant/replay/playbook-candidates", json("POST", payload)); },
  acceptReplayPlaybookCandidate(id, payload) { return request(`/api/quant/replay/playbook-candidates/${encodeURIComponent(id)}/accept`, json("POST", payload)); },
  rejectReplayPlaybookCandidate(id, payload = {}) { return request(`/api/quant/replay/playbook-candidates/${encodeURIComponent(id)}/reject`, json("POST", payload)); },
  getReplaySession: (id) => request(replaySessionPath(id)),
  deleteReplaySession(sessionId) { return request(replaySessionPath(sessionId), json("DELETE")); },
  retrainReplaySession(sessionId) { return request(`${replaySessionPath(sessionId)}/retrain`, json("POST")); },
  submitReplayOrder: (id, payload) => request(`${replaySessionPath(id)}/orders`, json("POST", payload)),
  advanceReplaySession: (id, payload) => request(`${replaySessionPath(id)}/advance`, json("POST", payload)),
  finishReplaySession: (id, payload) => request(`${replaySessionPath(id)}/finish`, json("POST", payload)),
  saveReplayBlindReview: (id, payload) => request(`${replaySessionPath(id)}/reviews/blind`, json("POST", payload)),
  saveReplayPostReview: (id, payload) => request(`${replaySessionPath(id)}/reviews/post`, json("POST", payload)),
  saveReplayReviewDraft: (id, stage, draft, expectedRevision) => request(`${replaySessionPath(id)}/reviews/${encodeURIComponent(stage)}/draft`, json("PUT", { draft, expectedRevision })),
  deleteReplayReviewDraft: (id, stage, expectedRevision) => request(`${replaySessionPath(id)}/reviews/${encodeURIComponent(stage)}/draft`, json("DELETE", { expectedRevision })),
  addReplayBlindReviewCorrection: (id, payload) => request(`${replaySessionPath(id)}/reviews/blind/corrections`, json("POST", payload)),
  addReplayPostReviewCorrection: (id, payload) => request(`${replaySessionPath(id)}/reviews/post/corrections`, json("POST", payload)),
  updateReplayReviewCorrection: (id, stage, correctionId, payload) => request(`${replaySessionPath(id)}/reviews/${encodeURIComponent(stage)}/corrections/${encodeURIComponent(correctionId)}`, json("PATCH", payload)),
  deleteReplayReviewCorrection: (id, stage, correctionId, payload) => request(`${replaySessionPath(id)}/reviews/${encodeURIComponent(stage)}/corrections/${encodeURIComponent(correctionId)}`, json("DELETE", payload)),
  revealReplaySession: (id, payload) => request(`${replaySessionPath(id)}/reveal`, json("POST", payload)),
  listTradeRecords(payload = {}) {
    const query = new URLSearchParams(Object.entries(payload).filter(([, value]) => value != null && value !== ""));
    return request(`/api/quant/decision/trade-records?${query}`);
  },
  getTradeRecord: (id) => request(tradeRecordPath(id)),
  saveTradeRecord: (payload = {}) => request("/api/quant/decision/trade-records", json("POST", payload)),
  updateTradeRecord: (id, payload = {}) => request(tradeRecordPath(id), json("PATCH", payload)),
  deleteTradeRecord: (id) => request(tradeRecordPath(id), json("DELETE", {})),
  searchDecisionStocks(queryText) {
    const query = new URLSearchParams({ query: String(queryText ?? "").trim() });
    return request(`/api/quant/decision/stocks/search?${query}`);
  },
  getDecisionExecutionSettings: () => request("/api/quant/decision/execution-settings"),
  saveDecisionExecutionSettings: (payload = {}) => request("/api/quant/decision/execution-settings", json("PUT", payload)),
  issueTradeLicense: (id) => request(`${tradeRecordPath(id)}/license`, json("POST", {})),
  recordTradeEntry: (id, payload = {}) => request(`${tradeRecordPath(id)}/entry`, json("POST", payload)),
  recordTradePriceObservation: (id, payload = {}) => request(`${tradeRecordPath(id)}/price-observation`, json("POST", payload)),
  recordTradeExecutionEvent: (id, payload = {}) => request(`${tradeRecordPath(id)}/execution-events`, json("POST", payload)),
  updateTradeExecutionEvent: (id, eventId, payload = {}) => request(`${tradeRecordPath(id)}/execution-events/${encodeURIComponent(eventId)}`, json("PATCH", payload)),
  deleteTradeExecutionEvent: (id, eventId) => request(`${tradeRecordPath(id)}/execution-events/${encodeURIComponent(eventId)}`, json("DELETE", {})),
  recordTradeExit: (id, payload = {}) => request(`${tradeRecordPath(id)}/exit`, json("POST", payload)),
  cancelTradeRecord: (id) => request(`${tradeRecordPath(id)}/cancel`, json("POST", {})),
};
