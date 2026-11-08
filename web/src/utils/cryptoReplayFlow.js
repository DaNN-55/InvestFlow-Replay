export function createCryptoReplayFlow(saved, { restoreSession = true, storageError = '' } = {}) {
  const targetSessionId = restoreSession ? saved.sessionId ?? null : null;
  return {
    write: storageError ? 'checkpoint' : saved.pending ? 'uncertain' : 'idle',
    read: targetSessionId ? 'stale' : 'unselected',
    targetSessionId, pending: saved.pending ?? null, orderReceipt: null,
    checkpoint: storageError ? { kind: 'restore', error: '' } : null,
    error: storageError, notice: '',
  };
}

function checkpoint(state, kind, record, next, updates = {}, operation = null) {
  const error = updates.error ?? state.error;
  return {
    ...state, ...updates, write: 'persisting', targetSessionId: record.sessionId,
    pending: record.pending, checkpoint: { kind, record, next, error, operation },
  };
}

// Runtime phases are deliberately separate from the durable { sessionId, pending } record.
export function transitionCryptoReplayFlow(state, event) {
  switch (event.type) {
    case 'overviewRequested':
      return { ...state, read: 'loading', error: '', notice: '' };
    case 'syncRequested':
      return checkpoint(state, 'target', { sessionId: event.id, pending: state.pending },
        { kind: 'read', id: event.id }, { read: event.id ? 'stale' : 'unselected', error: '', notice: '' });
    case 'sendRequested':
      return checkpoint(state, state.pending ? 'retryIntent' : 'intent', { sessionId: state.targetSessionId, pending: event.intent },
        { kind: 'send', intent: event.intent }, { error: '', notice: '' });
    case 'acknowledged': {
      const { intent, result } = event, id = result.session.id;
      const pending = intent.advanceActionId ? {
        kind: 'advance', id, orderActionId: intent.body.actionId,
        body: { actionId: intent.advanceActionId, expectedRevision: result.session.revision, minutes: 1 },
      } : null;
      const notice = intent.orderActionId ? '委托已提交，已推进 1 分钟。' : result.idempotent ? '已核对原动作，只记录一次。' : '已保存。';
      return checkpoint(state, pending ? 'continuation' : 'ack', { sessionId: id, pending },
        pending ? { kind: 'send', intent: pending } : { kind: 'read', id, notice },
        { read: 'stale', orderReceipt: intent.advanceActionId ? intent.body.actionId : intent.orderActionId ?? state.orderReceipt },
        { kind: intent.kind, order: Boolean(intent.advanceActionId || intent.orderActionId) });
    }
    case 'rejected':
      return checkpoint(state, 'rejection', { sessionId: state.targetSessionId, pending: null },
        { kind: 'idle', result: false }, { error: event.message, read: event.intent.kind === 'create' ? state.read : 'stale' });
    case 'unknown':
      return { ...state, write: 'uncertain', error: event.message, read: event.intent.orderActionId ? 'stale' : state.read };
    case 'checkpointSaved': {
      const { next, error } = state.checkpoint;
      return {
        ...state, checkpoint: null, error,
        write: next.kind === 'send' ? 'sending' : state.pending ? 'uncertain' : 'idle',
        read: next.kind === 'read' ? 'loading' : state.read,
      };
    }
    case 'checkpointFailed':
      return { ...state, write: 'checkpoint', read: state.read === 'loading' ? state.targetSessionId ? 'stale' : 'unselected' : state.read, error: event.message };
    case 'retryCheckpoint':
      return { ...state, write: 'persisting', error: state.checkpoint.error, notice: '' };
    case 'readSucceeded':
      return { ...state, read: state.targetSessionId ? 'ready' : 'unselected', write: state.pending ? 'uncertain' : 'idle', notice: event.notice ?? state.notice };
    case 'readFailed':
      return { ...state, read: state.targetSessionId ? 'stale' : 'unselected', write: state.pending ? 'uncertain' : 'idle', error: event.message };
    case 'targetMissing':
      return checkpoint(state, 'clear', { sessionId: null, pending: state.pending },
        { kind: 'read', id: null, notice: '原练习已删除或不在当前存储中，请从历史练习恢复。' }, { read: 'unselected' });
    case 'freshRequested':
      return checkpoint(state, 'clear', { sessionId: null, pending: null },
        { kind: 'idle', result: true }, { read: 'unselected', error: '', notice: '' });
    case 'externalPending':
      return { ...state, pending: event.pending, write: event.pending ? 'uncertain' : 'idle' };
    case 'restoreFailed':
      return { ...state, write: 'checkpoint', checkpoint: { kind: 'restore', error: state.error }, error: event.message };
    case 'restoreTargetRequested':
      return { ...state, targetSessionId: event.id, read: 'stale' };
    case 'restored':
      return { ...state, pending: event.pending, targetSessionId: event.id, checkpoint: null,
        write: event.pending ? 'uncertain' : 'idle', read: 'loading', error: '', notice: '' };
    default:
      throw new Error(`Unknown crypto replay event: ${event.type}`);
  }
}

const storageRecovery = {
  restore: ['无法读取恢复记录', '恢复记录尚未读取，暂时不能提交新操作。请恢复浏览器存储后重试。'],
  intent: ['操作尚未发送', '本次操作尚未保存，因此没有发送。请恢复浏览器存储后重试。'],
  retryIntent: ['原操作仍待核对，恢复记录尚未保存', '本次重试尚未发送；原操作可能已经提交。请恢复浏览器存储后继续核对同一请求。'],
  continuation: ['委托已提交，后续推进尚未发送', '请恢复浏览器存储后重试，系统将继续原来的推进请求，不会再次下单。'],
  ack: ['操作已提交，恢复记录尚未保存', '重试只补存恢复信息并同步结果，不会再次提交已确认的操作。'],
  rejection: ['操作已被拒绝，恢复记录尚未保存', '请恢复浏览器存储后重试，再同步并核对当前结果。'],
  target: ['恢复信息尚未保存', '本次读取尚未开始。请恢复浏览器存储后重试。'],
  clear: ['恢复信息尚未保存', '请恢复浏览器存储后重试，完成恢复记录的更新。'],
};

export function cryptoReplayControls(flow) {
  const busy = ['persisting', 'sending'].includes(flow.write) || flow.read === 'loading';
  const readStale = Boolean(flow.targetSessionId) && flow.read !== 'ready';
  let recovery = null;
  if (flow.checkpoint) {
    const [title, detail] = storageRecovery[flow.checkpoint.kind];
    recovery = { kind: 'storage', title, detail, action: 'retry' };
  } else if (flow.pending) {
    recovery = { kind: 'retry', title: '上次操作结果尚未确认', detail: '暂时不能提交新操作。请重试原操作，系统会核对同一次请求，避免重复下单。', action: 'retry' };
  } else if (readStale) {
    recovery = { kind: 'sync', title: '需要重新同步', detail: '账户和行情尚未完成核对，暂时不能下单或推进。重新同步只读取数据，不会重复提交订单。', action: 'sync' };
  }
  return { busy, readStale, newActionsBlocked: busy || Boolean(flow.pending) || readStale || Boolean(flow.checkpoint),
    readBlocked: busy || Boolean(flow.checkpoint), recovery,
    retryKind: flow.pending?.kind ?? flow.checkpoint?.operation?.kind,
    retryOrder: Boolean(flow.pending?.advanceActionId || flow.pending?.orderActionId || flow.checkpoint?.operation?.order) };
}
