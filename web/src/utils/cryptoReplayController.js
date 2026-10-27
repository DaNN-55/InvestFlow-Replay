import { errorText } from './cryptoReplayPresentation.js';
import { createCryptoSessionReader } from './cryptoSessionReader.js';
export const CRYPTO_STORAGE_KEY = 'investflow-crypto-attempt-v1';
function readSavedAttempt(storage) {
  try { return JSON.parse(storage.getItem(CRYPTO_STORAGE_KEY) ?? '{}') ?? {}; }
  catch { return {}; } // Storage may have an old or interrupted record.
}
export function createCryptoReplayController({ api, storage, uuid = () => crypto.randomUUID(), changed = () => {}, restoreSession = true }) {
  const saved = readSavedAttempt(storage);
  let targetSessionId = restoreSession ? saved.sessionId ?? null : null;
  const state = { session: null, busy: false, readStale: Boolean(targetSessionId), error: '', notice: '', pending: saved.pending ?? null, timeframe: 5, timeframes: [5], markets: {}, market: null, traces: [], ledger: [], history: [], analysis: null, analysisError: '', pool: null, poolError: '' };
  const reader = createCryptoSessionReader({ getSession: id => api.getReplaySession(id), readMarket: (id, params) => api.cryptoMarket(id, params), readAudit: (id, kind, params) => api.cryptoAudit(id, kind, params) });
  const publish = () => changed({ ...state });
  const persist = () => storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify({ sessionId: targetSessionId, pending: state.pending }));
  async function poolSummary() {
    try { return { pool: await api.cryptoPool?.() ?? null, poolError: '' }; }
    catch (error) { return { pool: null, poolError: `新场景目录暂不可用：${errorText(error)}。已保存练习仍按原版本恢复。` }; }
  }
  async function overview() {
    const [history, pool] = await Promise.all([api.listReplaySessions({ market: 'crypto-perpetual', pageSize: 30 }), poolSummary()]);
    Object.assign(state, { history: history.items ?? [], ...pool });
  }
  function clearVisible() {
    Object.assign(state, { session: null, market: null, markets: {}, traces: [], ledger: [], analysis: null, analysisError: '' });
  }
  function clearSession() {
    targetSessionId = null; reader.reset(); clearVisible(); state.readStale = false; persist();
  }
  function selectTarget(id) {
    if (targetSessionId !== id || (state.session && state.session.id !== id)) { reader.reset(); clearVisible(); }
    targetSessionId = id; state.readStale = true; persist();
  }
  async function data(session) {
    if (session?.id !== targetSessionId) throw new Error('读取的会话不匹配，请重新同步');
    const [batch, history, pool] = await Promise.all([
      reader.read({ session, periods: state.timeframes }),
      api.listReplaySessions({ market: 'crypto-perpetual', pageSize: 30 }), poolSummary(),
    ]);
    let analysis = null, analysisError = '';
    if (batch.session.revealed && api.cryptoAnalysis) {
      try {
        analysis = await api.cryptoAnalysis(batch.session.id);
        if (analysis.sessionId !== batch.session.id || analysis.revision !== batch.session.revision) throw new Error('复盘版本已变化，请重新同步');
      }
      catch (error) { analysis = null; analysisError = `派生复盘暂不可用：${errorText(error)}。原资金结果已保留。`; }
    }
    Object.assign(state, batch, { market: batch.markets[state.timeframe], history: history.items ?? [], ...pool, analysis, analysisError, readStale: false });
  }
  async function sync(id = targetSessionId) {
    if (state.busy) return false;
    state.busy = true; state.error = ''; state.notice = '';
    if (id) selectTarget(id);
    publish();
    try {
      if (id) {
        let result;
        try { result = await api.getReplaySession(id); }
        catch (error) {
          if (error.status !== 404) throw error;
          clearSession();
          await overview(); state.notice = '原练习已删除或不在当前存储中，请从历史练习恢复。'; return true;
        }
        await data(result.session);
      } else await overview();
      return true;
    } catch (error) {
      state.error = errorText(error); return false;
    } finally { state.busy = false; publish(); }
  }
  const calls = { create: (p) => api.createReplaySession(p.body), command: (p) => api.cryptoAction(p.id,p.body), advance: (p) => api.advanceReplaySession(p.id,p.body), finish: (p) => api.finishReplaySession(p.id,p.body), blind: (p) => api.saveReplayBlindReview(p.id,p.body), reveal: (p) => api.revealReplaySession(p.id,p.body), post: (p) => api.saveReplayPostReview(p.id,p.body), retrain: (p) => api.cryptoRetrain(p.id,p.body) };
  async function send(p) {
    if (state.busy) return false;
    state.busy = true; state.error = ''; state.notice = ''; publish();
    let acknowledged = false;
    try {
      state.pending = p; persist(); publish(); // Keep the exact durable intent before sending.
      const result = await calls[p.kind](p);
      targetSessionId = result.session.id;
      state.pending = null; acknowledged = true; selectTarget(targetSessionId); publish();
      // An idempotent response is an old commit; always read the current server version.
      const latest = await api.getReplaySession(targetSessionId);
      await data(latest.session); state.notice = result.idempotent ? '已核对原动作，只记录一次。' : '已保存。'; return true;
    } catch (error) {
      const rejectedCreate = p.kind === 'create' && error.details?.actionOutcome === 'not-committed';
      if ((error.status >= 400 && error.status < 500) || rejectedCreate) { state.pending = null; persist(); }
      if (acknowledged || (p.kind !== 'create' && !state.pending)) state.readStale = true;
      state.error = errorText(error); return false;
    } finally { state.busy = false; publish(); }
  }
  function act(kind, body = {}) {
    if (state.pending || state.busy || state.readStale || (kind !== 'create' && !state.session)) return Promise.resolve(false);
    return send({ kind, id: state.session?.id, body: { actionId: uuid(), ...(kind === 'create' ? {} : { expectedRevision: state.session.revision }), ...body } });
  }
  return { state, sync, act, retry: () => state.pending ? send(state.pending) : sync(),
    get targetSessionId() { return targetSessionId; },
    syncPendingFromStorage() { if (!state.busy) { state.pending = readSavedAttempt(storage).pending ?? null; publish(); } },
    async period(value) { if (state.busy) return; state.timeframe = Number(value); state.timeframes = [state.timeframe]; return sync(); },
    async periods(values) { if (state.busy) return false; state.timeframes = [...new Set(values.map(Number))]; state.timeframe = state.timeframes[0] ?? 5; return sync(); },
    async select(id) { if (state.busy) return; return sync(id); },
    async fresh() { if (state.busy || state.pending || state.readStale) return; clearSession(); state.error = ''; state.notice = ''; publish(); },
  };
}
