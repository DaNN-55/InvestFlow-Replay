import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoModificationConfirmation } from '../../src/utils/cryptoModificationConfirmation.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function session() {
  return { id: 'one', revision: 4, status: 'active', contract: { tickSz: '0.1', lotSz: '0.01', minSz: '0.01' },
    currentPrices: { last: '50000', mark: '50010' }, account: { availableBalance: '10000', position: { side: 'long', contracts: '2', entryPrice: '50000' } },
    protection: { contracts: '2', triggeredLeg: null, stopLoss: { price: '49000', reference: 'last' }, takeProfit: { price: '51000', reference: 'mark' } },
    orders: [{ id: 2, type: 'limit', side: 'long', intent: 'increase', limitPrice: '49000', contracts: '3', filledContracts: '2', remainingContracts: '1', reservedBalance: '100' }] };
}
function result(body, overrides = {}) {
  return { preview: { sessionId: 'one', revision: body.expectedRevision, changed: true, after: { reservedBalance: '250' },
    funds: { affordable: true, maximumRemainingContracts: '2', availableBalanceAfter: '9850' }, ...overrides } };
}
function fixture({ preview, submit, sync } = {}) {
  const ctx = { session: session(), busy: false, pending: null, routeMismatch: false };
  const calls = { previews: [], commands: [], pauses: 0, syncs: 0, views: [] };
  const flow = createCryptoModificationConfirmation({ readContext: () => ctx,
    previewOrder: async (id, body) => { calls.previews.push({ id, body }); return preview ? preview(id, body) : result(body); },
    submitCommand: async body => { calls.commands.push(body); return submit ? submit(body, ctx) : true; },
    syncSession: async () => { calls.syncs++; return sync ? sync(ctx) : true; },
    pausePlayback: () => { calls.pauses++; }, changed: value => calls.views.push(value) });
  return { ctx, calls, flow };
}
const begin = {
  order: flow => flow.openOrder({ orderId: 2 }),
  price: flow => { flow.handlePriceDrag({ phase: 'start', leg: 'stopLoss' }); flow.handlePriceDrag({ phase: 'end', leg: 'stopLoss', price: 49200.13 }); },
  cancellation: flow => flow.openCancellation({ orderId: 2 }),
};

test('order edits keep raw input separate from the exact draft and submit captured fields together', async () => {
  const { ctx, calls, flow } = fixture(); const original = structuredClone(ctx.session);
  flow.openOrder({ orderId: 2 }); await flow.updateOrder({ price: '48000.15', remainingContracts: '02.500' });
  assert.equal(flow.view.input.price, '48000.15'); assert.equal(flow.view.input.remainingContracts, '02.500');
  assert.equal(flow.view.orderDraft.price, '48000.2'); assert.equal(flow.view.orderDraft.remainingContracts, '2.5');
  assert.equal(flow.view.canConfirm, true); assert.deepEqual(ctx.session, original);
  await flow.confirm();
  assert.deepEqual(calls.commands, [{ expectedRevision: 4, command: { type: 'amend-order', orderId: 2, limitPrice: '48000.2', remainingContracts: '2.5' } }]);
  assert.equal(flow.view.editor, null); assert.equal(flow.view.chartDraft, null); assert.equal(flow.view.saving, false);
});

test('only the latest affordable changed preview can confirm; maximum quantity requires another preview', async () => {
  const waiting = [];
  const { calls, flow } = fixture({ preview: (_id, body) => { const d = deferred(); waiting.push({ ...d, body }); return d.promise; } });
  flow.openOrder({ orderId: 2 });
  const a = flow.updateOrder({ price: '48000' }); const b = flow.updateOrder({ remainingContracts: '100' });
  assert.equal(flow.view.canConfirm, false); assert.equal(flow.view.preview, null);
  waiting[2].resolve(result(waiting[2].body, { funds: { affordable: false, maximumRemainingContracts: '2' } })); await b;
  assert.equal(flow.view.previewReady, true); assert.equal(flow.view.canConfirm, false);
  waiting[1].resolve(result(waiting[1].body)); await a;
  assert.equal(flow.view.preview.funds.affordable, false);
  const max = flow.applyMaximum(); assert.equal(flow.view.input.remainingContracts, '2'); assert.equal(flow.view.canConfirm, false);
  waiting[3].resolve(result(waiting[3].body)); await max;
  assert.equal(flow.view.canConfirm, true); assert.equal(calls.commands.length, 0);
  await flow.confirm(); assert.equal(calls.commands[0].command.remainingContracts, '2');
  waiting[0].resolve(result(waiting[0].body)); await settle(); assert.equal(flow.view.editor, null);
});

test('invalid inputs, unchanged previews, and zero maximum never allow an empty submission', async () => {
  const { calls, flow } = fixture({ preview: (_id, body) => result(body, { changed: false, funds: { affordable: true, maximumRemainingContracts: '0' } }) });
  flow.openOrder({ orderId: 2 }); await settle();
  assert.equal(flow.view.canConfirm, false); await flow.confirm();
  for (const remainingContracts of ['', '0', '0.001', '-1', 'bad']) {
    await flow.updateOrder({ remainingContracts }); assert.equal(flow.view.previewReady, false); await flow.confirm();
  }
  assert.equal(calls.commands.length, 0);
  await flow.updateOrder({ remainingContracts: '1' }); flow.applyMaximum(); assert.equal(flow.view.input.remainingContracts, '1');
});

test('a pending market order changes only its remaining quantity', async () => {
  const { ctx, calls, flow } = fixture(); ctx.session.orders[0].type = 'market'; delete ctx.session.orders[0].limitPrice;
  flow.openOrder({ orderId: 2 }); await flow.updateOrder({ remainingContracts: '2' }); await flow.confirm();
  assert.deepEqual(calls.commands[0], { expectedRevision: 4, command: { type: 'amend-order', orderId: 2, remainingContracts: '2' } });
});

test('mismatched previews show an error and can be retried without changing the captured input', async () => {
  let wrong = true;
  const { flow } = fixture({ preview: (_id, body) => result(body, wrong ? { sessionId: 'other' } : {}) });
  flow.openOrder({ orderId: 2 }); await flow.updateOrder({ price: '48000' });
  assert.match(flow.view.previewError, /委托已变化/); assert.equal(flow.view.canConfirm, false);
  wrong = false; await flow.retryPreview(); assert.equal(flow.view.canConfirm, true); assert.equal(flow.view.input.price, '48000');
});

test('an explicit preview revision conflict closes the editor and synchronizes instead of resubmitting', async () => {
  const { calls, flow } = fixture({ preview: () => { throw Object.assign(new Error('conflict'), { code: 'REPLAY_REVISION_CONFLICT' }); } });
  flow.openOrder({ orderId: 2 }); await settle();
  assert.equal(flow.view.kind, 'idle'); assert.match(flow.view.notice, /重新修改/); assert.equal(calls.syncs, 1); assert.equal(calls.commands.length, 0);
});

for (const kind of Object.keys(begin)) {
  test(`${kind}: other actions lock while its own confirmation remains usable, and double confirm submits once`, async () => {
    const gate = deferred(); const { calls, flow } = fixture({ submit: () => gate.promise });
    begin[kind](flow); await settle();
    assert.equal(flow.view.blockNewActions, true); assert.equal(flow.view.blockChartActions, kind !== 'price');
    assert.equal(flow.view.canConfirm, true); assert.equal(flow.openCancellation({ orderId: 2 }), false);
    const first = flow.confirm(); assert.equal(flow.view.saving, true); assert.equal(flow.view.canConfirm, false);
    flow.cancel(); assert.notEqual(flow.view.kind, 'idle'); assert.equal(await flow.confirm(), false);
    gate.resolve(true); await first;
    assert.equal(calls.commands.length, 1); assert.equal(flow.view.kind, 'idle'); assert.equal(flow.view.blockNewActions, false);
  });
  test(`${kind}: a newer local revision invalidates the draft without writing`, async () => {
    const { ctx, calls, flow } = fixture(); begin[kind](flow); await settle(); ctx.session = { ...ctx.session, revision: 5 }; flow.reconcile();
    assert.equal(flow.view.kind, 'idle'); assert.match(flow.view.notice, /已变化/); await flow.confirm(); assert.equal(calls.commands.length, 0);
  });
  test(`${kind}: unknown commit result clears local confirmation and keeps the durable pending lock`, async () => {
    const { ctx, calls, flow } = fixture({ submit: (_body, value) => { value.pending = { body: 'original' }; return false; } });
    begin[kind](flow); await settle(); assert.equal(await flow.confirm(), false);
    assert.equal(flow.view.kind, 'idle'); assert.equal(flow.view.saving, false); assert.equal(flow.view.blockNewActions, true);
    assert.deepEqual(ctx.pending, { body: 'original' }); assert.equal(calls.syncs, 0); assert.equal(calls.commands.length, 1);
  });
  test(`${kind}: failed action followed by failed synchronization releases saving and reports uncertainty`, async () => {
    const { calls, flow } = fixture({ submit: () => false, sync: () => false }); begin[kind](flow); await settle(); await flow.confirm();
    assert.equal(flow.view.kind, 'idle'); assert.equal(flow.view.saving, false); assert.match(flow.view.notice, /结果未能同步/);
    assert.equal(calls.commands.length, 1); assert.equal(calls.syncs, 1);
  });
}

test('protection drag captures at start, preserves the sibling reference, and never requests funds preview', async () => {
  const { ctx, calls, flow } = fixture(); const original = structuredClone(ctx.session);
  begin.price(flow); assert.equal(flow.view.priceDraft.price, '49200.1'); assert.equal(calls.previews.length, 0);
  assert.deepEqual(ctx.session, original); await flow.confirm();
  assert.deepEqual(calls.commands[0], { expectedRevision: 4, command: { type: 'set-protection', stopLoss: { price: '49200.1', reference: 'last' }, takeProfit: { price: '51000', reference: 'mark' } } });
  flow.handlePriceDrag({ phase: 'start', orderId: 2 }); ctx.session = { ...ctx.session, revision: 5 };
  flow.handlePriceDrag({ phase: 'end', orderId: 2, price: 48000 });
  assert.equal(flow.view.kind, 'idle'); assert.match(flow.view.notice, /重新拖动/); assert.equal(calls.commands.length, 1);
});

test('limit drag preserves quantity and fills and sends the existing amend-limit command', async () => {
  const { calls, flow } = fixture();
  flow.handlePriceDrag({ phase: 'start', orderId: 2 }); flow.handlePriceDrag({ phase: 'move', orderId: 2, price: 48000 });
  assert.equal(flow.view.kind, 'dragging'); assert.equal(flow.view.chartDraft, null);
  flow.handlePriceDrag({ phase: 'end', orderId: 2, price: 48000 }); await flow.confirm();
  assert.deepEqual(calls.commands[0], { expectedRevision: 4, command: { type: 'amend-limit', orderId: 2, limitPrice: '48000' } }); assert.equal(calls.previews.length, 0);
});

test('cancellation preserves its exact remaining target and protection cancellation affects one leg only', async () => {
  const { ctx, calls, flow } = fixture(); flow.openCancellation({ orderId: 2 });
  assert.equal(flow.view.title, '撤销限价委托？'); assert.match(flow.view.message, /剩余未成交 1 张/); await flow.confirm();
  assert.deepEqual(calls.commands[0], { expectedRevision: 4, command: { type: 'cancel-order', orderId: 2 } });
  ctx.session.protection.triggeredLeg = 'stopLoss'; ctx.session.protection.takeProfit = null;
  assert.equal(flow.openCancellation({ leg: 'takeProfit' }), false); flow.openCancellation({ leg: 'stopLoss' });
  assert.match(flow.view.message, /已触发.*不恢复已平仓数量/); await flow.confirm();
  assert.deepEqual(calls.commands[1], { expectedRevision: 4, command: { type: 'cancel-protection', leg: 'stopLoss' } }); assert.equal(calls.previews.length, 0);
});

for (const action of ['cancel', 'reset', 'dispose']) test(`${action} discards a waiting preview and late replies cannot change the next screen`, async () => {
  const pending = deferred(); const { ctx, calls, flow } = fixture({ preview: () => pending.promise });
  flow.openOrder({ orderId: 2 }); flow[action](); const count = calls.views.length;
  ctx.session = { ...session(), id: 'two', revision: 9 };
  pending.resolve({ preview: { sessionId: 'one', revision: 4, funds: { affordable: true } } }); await settle();
  assert.equal(flow.view.kind, 'idle'); assert.equal(flow.view.preview, null); assert.equal(calls.views.length, count);
  if (action === 'dispose') assert.equal(flow.openCancellation({ orderId: 2 }), false);
});

test('deactivation during a submitted action cannot let its later recovery overwrite a new confirmation', async () => {
  const gate = deferred(); const { flow, calls } = fixture({ submit: () => gate.promise });
  flow.openCancellation({ orderId: 2 }); const submitted = flow.confirm(); flow.reset();
  flow.openCancellation({ leg: 'stopLoss' }); gate.resolve(false); await submitted;
  assert.equal(flow.view.kind, 'cancellation'); assert.equal(flow.view.cancellation.leg, 'stopLoss'); assert.equal(flow.view.notice, ''); assert.equal(calls.syncs, 0);
});

test('external busy, pending, and route mismatch block starts and confirmation without replacing the draft', async () => {
  for (const key of ['busy', 'pending', 'routeMismatch']) {
    const { ctx, flow, calls } = fixture(); ctx[key] = true; assert.equal(flow.openOrder({ orderId: 2 }), false);
    ctx[key] = false; flow.openCancellation({ orderId: 2 }); ctx[key] = true; flow.reconcile();
    assert.equal(flow.view.canConfirm, false); assert.equal(await flow.confirm(), false); assert.equal(calls.commands.length, 0); assert.equal(flow.view.kind, 'cancellation');
  }
});

test('published editor, draft and preview are read-only and state changes go through the flow interface', async () => {
  const { flow } = fixture(); flow.openOrder({ orderId: 2 }); await flow.updateOrder({ price: '48000' });
  const value = flow.view;
  assert.throws(() => { value.input.price = '1'; }, TypeError);
  assert.throws(() => { value.editor.order.limitPrice = '1'; }, TypeError);
  assert.throws(() => { value.orderDraft.price = '1'; }, TypeError);
  assert.throws(() => { value.preview.funds.affordable = false; }, TypeError);
  assert.equal(flow.view.input.price, '48000'); assert.equal(flow.view.canConfirm, true);
});

test('its own submitted revision update does not invalidate confirmation or display a stale-draft notice', async () => {
  let active;
  const { ctx, flow } = fixture({ submit: () => { ctx.session = { ...ctx.session, revision: 5 }; active.reconcile(); return true; } });
  active = flow; flow.openCancellation({ orderId: 2 }); await flow.confirm();
  assert.equal(flow.view.kind, 'idle'); assert.equal(flow.view.notice, ''); assert.equal(flow.view.saving, false);
});
