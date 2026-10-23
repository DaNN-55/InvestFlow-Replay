import {
  createOrderDraft, orderDraftCommand, createPriceDraft, priceDraftCurrent,
  priceDraftCommand, createPriceCancellation, priceCancellationCurrent, priceCancellationCommand,
} from './cryptoPriceDraft.js';

function readonly(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) readonly(child);
    Object.freeze(value);
  }
  return value;
}

// Owns one local confirmation. Durable intents and retries belong to the action controller.
export function createCryptoModificationConfirmation({
  readContext, previewOrder, submitCommand, syncSession, pausePlayback, changed = () => {},
}) {
  let current = null;
  let saving = null;
  let notice = '';
  let generation = 0;
  let previewSequence = 0;
  let disposed = false;
  const context = () => readContext();
  const externallyBlocked = () => {
    const value = context();
    return Boolean(value.busy || value.pending || value.routeMismatch);
  };
  const canStart = () => !disposed && !current && !saving && !externallyBlocked();
  const currentSession = () => context().session;
  const isCurrent = operation => operation.kind === 'order'
    ? priceCancellationCurrent(currentSession(), operation.editor)
    : operation.kind === 'price'
      ? priceDraftCurrent(currentSession(), operation.draft)
      : operation.kind === 'cancellation'
        ? priceCancellationCurrent(currentSession(), operation.draft)
        : true;
  const command = operation => operation.kind === 'order'
    ? orderDraftCommand(currentSession(), operation.draft)
    : operation.kind === 'price'
      ? priceDraftCommand(currentSession(), operation.draft)
      : operation.kind === 'cancellation'
        ? priceCancellationCommand(currentSession(), operation.draft)
        : null;

  function cancellationSummary(draft) {
    if (!draft) return { title: '', message: '' };
    if (draft.kind === 'order') {
      const order = draft.order;
      const direction = order.intent === 'reduce' ? (order.side === 'long' ? '平多' : '平空') : (order.side === 'long' ? '开多' : '开空');
      return {
        title: order.type === 'limit' ? '撤销限价委托？' : '撤销市价委托？',
        message: `${direction} · 委托价 ${order.type === 'limit' ? order.limitPrice : '市价'} · 剩余未成交 ${order.remainingContracts} 张。仅撤销此委托的未成交部分。`,
      };
    }
    const label = draft.leg === 'stopLoss' ? '止损' : '止盈';
    const sibling = draft.protection[draft.leg === 'stopLoss' ? 'takeProfit' : 'stopLoss'];
    return {
      title: draft.leg === 'stopLoss' ? '撤销自动止损？' : '撤销自动止盈？',
      message: `${label} ${draft.protection[draft.leg].price} · ${draft.protection.contracts} 张。${draft.protection.triggeredLeg ? '已触发；撤销仅停止剩余退出，不恢复已平仓数量。' : sibling ? '仅撤销这一条，另一条保护保留。' : '撤销后不再自动保护该持仓。'}`,
    };
  }

  function view() {
    const editor = current?.kind === 'order' ? current : null;
    const priceDraft = current?.kind === 'price' ? current.draft : null;
    const cancellation = current?.kind === 'cancellation' ? current.draft : null;
    const body = editor ? command(editor) : null;
    const previewReady = Boolean(body && editor.preview?.key === JSON.stringify(body) && !editor.previewBusy && !editor.previewError);
    const chartDraft = editor?.draft?.order.type === 'limit' &&
      (editor.draft.price !== editor.draft.order.limitPrice || editor.draft.remainingContracts !== editor.draft.order.remainingContracts)
      ? editor.draft : priceDraft;
    const canConfirm = Boolean(current && current.kind !== 'dragging' && !saving && !externallyBlocked() && isCurrent(current) &&
      (editor ? previewReady && editor.preview.funds.affordable === true && editor.preview.changed !== false : command(current)));
    return readonly({
      kind: current?.kind ?? 'idle', saving: Boolean(saving), notice,
      editor: editor?.editor ?? null,
      input: Object.freeze({ price: editor?.price ?? '', remainingContracts: editor?.quantity ?? '' }),
      orderDraft: editor?.draft ?? null, preview: editor?.preview ?? null,
      previewBusy: editor?.previewBusy ?? false, previewError: editor?.previewError ?? '', previewReady,
      priceDraft, chartDraft, cancellation, ...cancellationSummary(cancellation), canConfirm,
      blockNewActions: externallyBlocked() || Boolean(current) || Boolean(saving),
      blockChartActions: externallyBlocked() || Boolean(editor || cancellation),
    });
  }
  const publish = () => { if (!disposed) changed(view()); };
  function clear() { current = null; generation++; previewSequence++; }
  function begin(operation) {
    pausePlayback(); notice = ''; generation++; current = operation; publish();
  }
  function expire(message) { clear(); notice = message; publish(); }

  async function retryPreview() {
    const operation = current;
    if (disposed || operation?.kind !== 'order' || saving) return;
    const sequence = ++previewSequence;
    const body = command(operation);
    operation.preview = null; operation.previewError = ''; operation.previewBusy = false;
    if (!body) { publish(); return; }
    operation.previewBusy = true; publish();
    try {
      const { preview } = await previewOrder(operation.editor.sessionId, body);
      if (disposed || current !== operation || sequence !== previewSequence) return;
      if (preview.sessionId !== operation.editor.sessionId || preview.revision !== body.expectedRevision) throw new Error('委托已变化，请重新预览');
      operation.preview = { ...preview, key: JSON.stringify(body) };
    } catch (error) {
      if (disposed || current !== operation || sequence !== previewSequence) return;
      if (error.code === 'REPLAY_REVISION_CONFLICT') {
        clear(); const epoch = generation; publish();
        await syncSession();
        if (!disposed && epoch === generation) { notice = '委托已变化，请核对后重新修改。'; publish(); }
        return;
      }
      operation.previewError = ({ INSUFFICIENT_CASH: '可用资金不足，请降低价格或数量。', OVER_REDUCTION: '数量超过可平仓余量，含其他平仓委托。', ORDER_SIZE_LIMIT: '数量超过本局委托上限。' })[error.code] ?? error.message ?? '暂时无法预览，请重试';
    } finally {
      if (!disposed && current === operation && sequence === previewSequence) { operation.previewBusy = false; publish(); }
    }
  }
  function refreshDraft(operation) {
    operation.draft = createOrderDraft(operation.editor.session, { orderId: operation.editor.orderId }, operation.price, operation.quantity, true);
    return retryPreview();
  }
  function openOrder(target) {
    if (!canStart()) return false;
    const session = currentSession(), draft = createPriceCancellation(session, target);
    if (!draft?.order) return false;
    const operation = { kind: 'order', editor: { ...draft, session: structuredClone(session) }, price: draft.order.limitPrice ?? '', quantity: draft.order.remainingContracts, draft: null, preview: null, previewBusy: false, previewError: '' };
    begin(operation); refreshDraft(operation); return true;
  }
  function updateOrder(patch) {
    if (disposed || current?.kind !== 'order' || saving || context().busy) return;
    if (Object.hasOwn(patch, 'price')) current.price = patch.price;
    if (Object.hasOwn(patch, 'remainingContracts')) current.quantity = patch.remainingContracts;
    return refreshDraft(current);
  }
  function applyMaximum() {
    const value = view();
    if (!value.previewReady || value.preview.funds.affordable || context().busy || saving) return;
    const maximum = value.preview.funds.maximumRemainingContracts;
    if (Number(maximum) > 0) return updateOrder({ remainingContracts: maximum });
  }
  function handlePriceDrag(event) {
    if (disposed) return;
    if (event.phase === 'start') {
      if (!canStart()) return;
      begin({ kind: 'dragging', session: structuredClone(currentSession()) }); return;
    }
    if (event.phase === 'move' || current?.kind !== 'dragging') return;
    const base = current.session;
    clear();
    if (event.phase !== 'end') { publish(); return; }
    const draft = createPriceDraft(base, event, event.price);
    if (!draft) { publish(); return; }
    if (!priceDraftCurrent(currentSession(), draft)) { notice = '委托、持仓或保护已变化，请重新拖动。'; publish(); return; }
    current = { kind: 'price', draft }; publish();
  }
  function openCancellation(target) {
    if (!canStart()) return false;
    const draft = createPriceCancellation(currentSession(), target);
    if (!draft) return false;
    begin({ kind: 'cancellation', draft }); return true;
  }
  async function confirm() {
    if (disposed || !current || current.kind === 'dragging' || saving || externallyBlocked()) return false;
    if (current.kind === 'order' && !view().canConfirm) return false;
    const body = command(current);
    if (!body) { expire('委托、持仓或保护已变化，请重新操作。'); return false; }
    const token = {};
    const epoch = generation;
    saving = token; pausePlayback(); publish();
    try {
      const ok = await submitCommand(body);
      if (disposed || epoch !== generation) return ok;
      clear(); const clearedEpoch = generation; publish();
      if (!ok && !context().pending) {
        const synced = await syncSession();
        if (!disposed && clearedEpoch === generation) {
          notice = synced ? '已重新同步操作结果，请核对当前委托或保护后重新操作。' : '结果未能同步，请先核对当前委托或保护。';
        }
      }
      return ok;
    } finally {
      if (saving === token) { saving = null; publish(); }
    }
  }
  function cancel() { if (!disposed && !saving) { clear(); publish(); } }
  function reconcile() {
    if (disposed) return;
    if (current && !saving && !isCurrent(current)) {
      expire(current.kind === 'order' ? '委托已变化，请重新修改价格。' : current.kind === 'price' ? '委托、持仓或保护已变化，未确认的调整已取消。' : '委托、持仓或保护已变化，请核对后重新撤销。');
    } else publish();
  }
  function reset() { if (!disposed) { clear(); saving = null; publish(); } }
  function dispose() { reset(); disposed = true; }
  return { get view() { return view(); }, openOrder, updateOrder, handlePriceDrag, openCancellation, retryPreview, applyMaximum, confirm, cancel, reconcile, reset, dispose };
}
