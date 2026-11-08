import { errorText } from './cryptoReplayPresentation.js';
import { createCryptoSessionReader } from './cryptoSessionReader.js';
import { createCryptoReplayFlow, transitionCryptoReplayFlow, cryptoReplayControls } from './cryptoReplayFlow.js';

export const CRYPTO_STORAGE_KEY = 'investflow-crypto-attempt-v1';
function readSavedAttempt(storage) {
  const raw = storage.getItem(CRYPTO_STORAGE_KEY);
  try { return JSON.parse(raw ?? '{}') ?? {}; }
  catch { return {}; } // Retain compatibility with old or interrupted JSON records.
}

export function createCryptoReplayController({ api, storage, uuid = () => crypto.randomUUID(), changed = () => {}, restoreSession = true }) {
  const storageMessage = error => `浏览器未能保存恢复信息：${errorText(error)}`;
  let saved = {}, storageError = '';
  try { saved = readSavedAttempt(storage); }
  catch (error) { storageError = `浏览器未能读取恢复信息：${errorText(error)}`; }
  let flow = createCryptoReplayFlow(saved, { restoreSession, storageError });
  let controls = cryptoReplayControls(flow);
  const state = { session: null, timeframe: 5, timeframes: [5], markets: {}, market: null, traces: [], ledger: [], history: [], analysis: null, analysisError: '', pool: null, poolError: '' };
  for (const name of ['pending', 'error', 'notice', 'orderReceipt']) {
    Object.defineProperty(state, name, { enumerable: true, get: () => flow[name] });
  }
  for (const name of ['busy', 'readStale']) {
    Object.defineProperty(state, name, { enumerable: true, get: () => controls[name] });
  }
  Object.defineProperty(state, 'controls', { enumerable: true, get: () => controls });
  const reader = createCryptoSessionReader({ getSession: id => api.getReplaySession(id), readMarket: (id, params) => api.cryptoMarket(id, params), readAudit: (id, kind, params) => api.cryptoAudit(id, kind, params) });
  const publish = () => changed({ ...state });
  function dispatch(event) {
    const previous = flow.targetSessionId;
    flow = transitionCryptoReplayFlow(flow, event);
    controls = cryptoReplayControls(flow);
    if (previous !== flow.targetSessionId || (state.session && state.session.id !== flow.targetSessionId)) {
      reader.reset(); clearVisible();
    }
    publish();
  }
  async function poolSummary() {
    try { return { pool: await api.cryptoPool?.() ?? null, poolError: '' }; }
    catch (error) { return { pool: null, poolError: `新场景目录暂不可用：${errorText(error)}。已保存练习仍按原版本恢复。` }; }
  }
  async function overview() {
    const [history, pool] = await Promise.all([api.listReplaySessions({ market: 'crypto-perpetual', pageSize: 30 }), poolSummary()]);
    return { history: history.items ?? [], ...pool };
  }
  function clearVisible() {
    Object.assign(state, { session: null, market: null, markets: {}, traces: [], ledger: [], analysis: null, analysisError: '' });
  }
  async function data(session) {
    if (session?.id !== flow.targetSessionId) throw new Error('读取的会话不匹配，请重新同步');
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
    return { ...batch, market: batch.markets[state.timeframe], history: history.items ?? [], ...pool, analysis, analysisError };
  }
  const calls = { create: (p) => api.createReplaySession(p.body), command: (p) => api.cryptoAction(p.id,p.body), advance: (p) => api.advanceReplaySession(p.id,p.body), finish: (p) => api.finishReplaySession(p.id,p.body), blind: (p) => api.saveReplayBlindReview(p.id,p.body), reveal: (p) => api.revealReplaySession(p.id,p.body), post: (p) => api.saveReplayPostReview(p.id,p.body), retrain: (p) => api.cryptoRetrain(p.id,p.body) };

  async function readTarget(id, notice) {
    try {
      if (id) {
        let result;
        try { result = await api.getReplaySession(id); }
        catch (error) {
          if (error.status !== 404) throw error;
          dispatch({ type: 'targetMissing' });
          return saveCheckpoint();
        }
        Object.assign(state, await data(result.session));
      } else Object.assign(state, await overview());
      dispatch({ type: 'readSucceeded', notice });
      return true;
    } catch (error) {
      dispatch({ type: 'readFailed', message: errorText(error, state.session?.contract) });
      return false;
    }
  }

  async function sendStep(intent) {
    let result;
    try {
      result = await calls[intent.kind](intent);
      if (!result?.session?.id || !Number.isSafeInteger(result.session.revision) || result.session.revision < 0) throw new Error('服务返回格式异常');
    } catch (error) {
      const message = `${intent.orderActionId ? '委托已提交，下一分钟的结果尚未核对。' : ''}${errorText(error, state.session?.contract)}`;
      const rejected = (error.status >= 400 && error.status < 500) || (intent.kind === 'create' && error.details?.actionOutcome === 'not-committed');
      dispatch({ type: rejected ? 'rejected' : 'unknown', intent, message });
      return rejected ? saveCheckpoint() : false;
    }
    dispatch({ type: 'acknowledged', intent, result });
    return saveCheckpoint();
  }

  async function saveCheckpoint() {
    const checkpoint = flow.checkpoint;
    try { storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify(checkpoint.record)); }
    catch (error) {
      dispatch({ type: 'checkpointFailed', message: storageMessage(error) });
      return false;
    }
    dispatch({ type: 'checkpointSaved' });
    const { next } = checkpoint;
    if (next.kind === 'send') return sendStep(next.intent);
    if (next.kind === 'read') return readTarget(next.id, next.notice);
    return next.result;
  }

  async function sync(id = flow.targetSessionId) {
    if (controls.readBlocked) {
      if (!controls.busy && flow.checkpoint?.kind === 'restore' && id) dispatch({ type: 'restoreTargetRequested', id });
      return false;
    }
    if (!id) {
      dispatch({ type: 'overviewRequested' });
      return readTarget(null);
    }
    dispatch({ type: 'syncRequested', id });
    return saveCheckpoint();
  }

  function act(kind, body = {}, advanceAfterOrder = false) {
    if (controls.newActionsBlocked || (kind !== 'create' && !state.session)) return Promise.resolve(false);
    const intent = { kind, id: state.session?.id, body: { actionId: uuid(), ...(kind === 'create' ? {} : { expectedRevision: state.session.revision }), ...body }, ...(advanceAfterOrder ? { advanceActionId: uuid() } : {}) };
    dispatch({ type: 'sendRequested', intent });
    return saveCheckpoint();
  }

  async function retry() {
    if (controls.busy) return false;
    if (flow.checkpoint) {
      const restore = flow.checkpoint.kind === 'restore';
      dispatch({ type: 'retryCheckpoint' });
      if (!restore) return saveCheckpoint();
      try {
        const recovered = readSavedAttempt(storage);
        const id = flow.targetSessionId ?? (restoreSession ? recovered.sessionId ?? null : null);
        dispatch({ type: 'restored', id, pending: recovered.pending ?? null });
        if (id) {
          dispatch({ type: 'syncRequested', id });
          return saveCheckpoint();
        }
        return readTarget(id);
      } catch (error) {
        dispatch({ type: 'restoreFailed', message: `浏览器未能读取恢复信息：${errorText(error)}` });
        return false;
      }
    }
    if (!flow.pending) return sync();
    dispatch({ type: 'sendRequested', intent: flow.pending });
    return saveCheckpoint();
  }

  return { state, sync, act, retry,
    placeOrder(command, note = '') {
      if (!['market-open', 'market-close', 'limit-open', 'limit-close'].includes(command?.type)) return Promise.resolve(false);
      return act('command', { command, ...(note ? { note } : {}) }, true);
    },
    get targetSessionId() { return flow.targetSessionId; },
    syncPendingFromStorage() {
      if (controls.readBlocked) return;
      try { dispatch({ type: 'externalPending', pending: readSavedAttempt(storage).pending ?? null }); }
      catch (error) { dispatch({ type: 'restoreFailed', message: `浏览器未能读取恢复信息：${errorText(error)}` }); }
    },
    async period(value) { if (controls.readBlocked) return; state.timeframe = Number(value); state.timeframes = [state.timeframe]; return sync(); },
    async periods(values) { if (controls.readBlocked) return false; state.timeframes = [...new Set(values.map(Number))]; state.timeframe = state.timeframes[0] ?? 5; return sync(); },
    async select(id) { if (controls.busy) return; return sync(id); },
    async fresh() {
      if (controls.newActionsBlocked) return;
      dispatch({ type: 'freshRequested' });
      await saveCheckpoint();
    },
  };
}
