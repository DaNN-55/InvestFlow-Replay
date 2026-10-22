import { errorText } from './cryptoReplayPresentation.js';
export const CRYPTO_STORAGE_KEY = 'investflow-crypto-attempt-v1';
export function createCryptoReplayController({ api, storage, uuid = () => crypto.randomUUID(), changed = () => {} }) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(CRYPTO_STORAGE_KEY) ?? '{}'); } catch { /* Storage may have an old or interrupted record. */ }
  const state = { session: null, busy: false, error: '', notice: '', pending: saved.pending ?? null, timeframe: 5, timeframes: [5], markets: {}, market: null, traces: [], ledger: [], history: [], analysis: null, analysisError: '', pool: null, poolError: '' };
  const publish = () => changed({ ...state });
  const persist = () => storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify({ sessionId: state.session?.id ?? saved.sessionId ?? null, pending: state.pending }));
  async function poolSummary() {
    try { const result = await api.cryptoPool?.() ?? null; state.poolError = ''; return result; }
    catch (error) { state.poolError = `新场景目录暂不可用：${errorText(error)}。已保存练习仍按原版本恢复。`; return null; }
  }
  async function overview() {
    const [history, pool] = await Promise.all([api.listReplaySessions({ market: 'crypto-perpetual', pageSize: 30 }), poolSummary()]);
    state.history = history.items ?? []; state.pool = pool;
  }
  function clearSession() {
    saved.sessionId = null;
    Object.assign(state, { session: null, market: null, markets: {}, traces: [], ledger: [], analysis: null, analysisError: '' });
    persist();
  }
  async function data() {
    if (!state.session) return;
    const id = state.session.id;
    const readAll = async (kind) => {
      const items = []; let after = kind === 'ledger' ? -1 : 0;
      for (;;) {
        const r = await api.cryptoAudit(id, kind, { after, limit: 200 }); items.push(...r.items);
        if (r.items.length < 200) return items;
        after = kind === 'ledger' ? r.items.at(-1).revision : r.items.at(-1).sequence;
      }
    };
    const elapsedMinutes = state.session.revealed ? state.session.gameLength : state.session.elapsedMinutes;
    const [views, traces, ledger, history, pool] = await Promise.all([Promise.all(state.timeframes.map(async period => [period, await api.cryptoMarket(id, { timeframeMinutes: period, limit: 600, ...(elapsedMinutes == null ? {} : { elapsedMinutes }) })])), readAll('traces'), readAll('ledger'), api.listReplaySessions({ market: 'crypto-perpetual', pageSize: 30 }), poolSummary()]);
    const markets = Object.fromEntries(views);
    let analysis = null; state.analysisError = '';
    if (state.session.revealed && api.cryptoAnalysis) {
      try {
        analysis = await api.cryptoAnalysis(id);
        if (analysis.sessionId !== id || analysis.revision !== state.session.revision) throw new Error('复盘版本已变化，请重新同步');
      }
      catch (error) { analysis = null; state.analysisError = `派生复盘暂不可用：${errorText(error)}。原资金结果已保留。`; }
    }
    Object.assign(state, { market: markets[state.timeframe], markets, traces, ledger, history: history.items ?? [], pool, analysis });
  }
  async function sync(id = state.session?.id ?? saved.sessionId) {
    if (state.busy) return false;
    state.busy = true; state.error = ''; state.notice = ''; publish();
    try {
      if (id) {
        let result;
        try { result = await api.getReplaySession(id); }
        catch (error) {
          if (error.status !== 404) throw error;
          clearSession(); await overview();
          state.notice = '原练习已删除或不在当前存储中，请从历史练习恢复。';
          return true;
        }
        if (state.session?.id !== id) Object.assign(state, { market: null, markets: {}, traces: [], ledger: [], analysis: null, analysisError: '' });
        state.session = result.session; saved.sessionId = id; persist(); await data();
      } else await overview();
      return true;
    } catch (e) { state.error = errorText(e); return false; }
    finally { state.busy = false; publish(); }
  }
  const calls = { create: (p) => api.createReplaySession(p.body), command: (p) => api.cryptoAction(p.id,p.body), advance: (p) => api.advanceReplaySession(p.id,p.body), finish: (p) => api.finishReplaySession(p.id,p.body), blind: (p) => api.saveReplayBlindReview(p.id,p.body), reveal: (p) => api.revealReplaySession(p.id,p.body), post: (p) => api.saveReplayPostReview(p.id,p.body), retrain: (p) => api.cryptoRetrain(p.id,p.body) };
  async function send(p) {
    if (state.busy) return false;
    state.busy = true; state.error = ''; state.notice = ''; publish();
    try {
      state.pending = p; persist(); publish(); // Persist before sending: a lost response must retain the identical action ID/body.
      const result = await calls[p.kind](p);
      state.session = result.session; saved.sessionId = result.session.id;
      state.pending = null; persist();
      // An idempotent response is the original commit. Fetch current state so a retry cannot rewind the visible screen.
      state.session = (await api.getReplaySession(result.session.id)).session;
      await data(); state.notice = result.idempotent ? '已核对原动作，只记录一次。' : '已保存。'; return true;
    } catch (e) {
      // Only an explicit rejection can release the write lock. Network errors,
      // generic 5xx and unreadable success responses may follow a committed action.
      const rejectedCreate = p.kind === 'create' && e.details?.actionOutcome === 'not-committed';
      if ((e.status >= 400 && e.status < 500) || rejectedCreate) { state.pending = null; persist(); }
      state.error = errorText(e); return false;
    } finally { state.busy = false; publish(); }
  }
  function act(kind, body = {}) {
    if (state.pending || state.busy || (kind !== 'create' && !state.session)) return Promise.resolve(false);
    return send({ kind, id: state.session?.id, body: { actionId: uuid(), ...(kind === 'create' ? {} : { expectedRevision: state.session.revision }), ...body } });
  }
  return { state, sync, act, retry: () => state.pending ? send(state.pending) : sync(),
    async period(value) { if (state.busy) return; state.timeframe = Number(value); state.timeframes = [state.timeframe]; return sync(); },
    async periods(values) { if (state.busy) return false; state.timeframes = [...new Set(values.map(Number))]; state.timeframe = state.timeframes[0] ?? 5; return sync(); },
    async select(id) { if (state.busy) return; state.market = null; state.markets = {}; return sync(id); },
    async fresh() { if (state.busy || state.pending) return; saved = {}; clearSession(); state.error = ''; state.notice = ''; publish(); },
  };
}
