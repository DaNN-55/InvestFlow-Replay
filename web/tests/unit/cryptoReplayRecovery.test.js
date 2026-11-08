import assert from 'node:assert/strict';
import test from 'node:test';
import { createCryptoReplayController, CRYPTO_STORAGE_KEY } from '../../src/utils/cryptoReplayController.js';

function fixture() {
  let current = { id: 'test', instrumentId: 'BTC-USDT-SWAP', revision: 0, elapsedMinutes: 0, gameLength: 120, revealed: false };
  let durable = null, sequence = 0;
  const calls = { command: [], advance: [], reads: [] }, commits = new Map();
  const storage = {
    fail: () => false, readFails: false,
    getItem() { if (this.readFails) throw new Error('storage read failed'); return durable; },
    setItem(_key, value) {
      if (this.fail(JSON.parse(value))) throw new Error('storage write failed');
      durable = value;
    },
  };
  function commit(kind, id, body) {
    calls[kind].push(structuredClone(body));
    if (commits.has(body.actionId)) return { session: structuredClone(commits.get(body.actionId)), idempotent: true };
    if (id !== current.id || body.expectedRevision !== current.revision) throw Object.assign(new Error('revision conflict'), { status: 409 });
    current = { ...current, revision: current.revision + 1, elapsedMinutes: current.elapsedMinutes + (kind === 'advance' ? body.minutes : 0) };
    commits.set(body.actionId, structuredClone(current));
    return { session: structuredClone(current) };
  }
  const api = {
    getReplaySession: async (id) => { calls.reads.push(id); return { session: { ...current, id } }; },
    listReplaySessions: async () => ({ items: [] }),
    cryptoMarket: async (_id, p) => ({ instrumentId: current.instrumentId, timeframeMinutes: p.timeframeMinutes, elapsedMinutes: p.elapsedMinutes, candles: { last: [], mark: [] } }),
    cryptoAudit: async (_id, kind, p) => ({ revision: current.revision, throughMinute: current.elapsedMinutes, items: kind === 'ledger' ? Array.from({ length: current.revision + 1 }, (_, revision) => ({ revision, cursorMinute: current.elapsedMinutes })).filter(row => row.revision > p.after).slice(0, p.limit) : [] }),
    cryptoAction: async (id, body) => commit('command', id, body),
    advanceReplaySession: async (id, body) => commit('advance', id, body),
  };
  const make = (options = {}) => createCryptoReplayController({ api, storage, uuid: () => `action-${++sequence}`, ...options });
  return { api, storage, calls, make, saved: () => JSON.parse(durable), current: () => current };
}

test('a failed target checkpoint releases busy and retries the read without a write', async () => {
  const c = fixture(), ui = c.make({ restoreSession: false });
  c.storage.fail = () => true;
  assert.equal(await ui.sync('test'), false);
  assert.equal(ui.state.busy, false);
  assert.equal(ui.state.controls.recovery.kind, 'storage');
  assert.deepEqual(c.calls.reads, []);
  assert.equal(await ui.act('create'), false);
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), true);
  assert.equal(ui.state.session.id, 'test');
  assert.equal(c.calls.command.length + c.calls.advance.length, 0);
  assert.deepEqual(c.saved(), { sessionId: 'test', pending: null });
});

test('failure to save an original intent sends nothing and retries the captured request', async () => {
  const c = fixture(), ui = c.make(); await ui.sync('test');
  c.storage.fail = value => Boolean(value.pending);
  assert.equal(await ui.act('command', { command: { type: 'cancel-all-orders' } }), false);
  const original = structuredClone(ui.state.pending);
  assert.equal(c.calls.command.length, 0);
  assert.equal(ui.state.busy, false);
  assert.equal(ui.state.controls.recovery.kind, 'storage');
  ui.syncPendingFromStorage();
  assert.deepEqual(ui.state.pending, original);
  assert.equal(await ui.fresh(), undefined);
  assert.equal(await ui.act('command'), false);
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), true);
  assert.deepEqual(c.calls.command, [original.body]);
  assert.equal(c.current().revision, 1);
});

for (const reload of [false, true]) {
  test(`continuation checkpoint failure recovers ${reload ? 'after reload' : 'in the same controller'} without another minute`, async () => {
    const c = fixture(); let ui = c.make(); await ui.sync('test');
    c.storage.fail = value => value.pending?.kind === 'advance';
    assert.equal(await ui.placeOrder({ type: 'market-open', side: 'long', contracts: '1' }), false);
    const original = c.saved().pending;
    assert.ok(original.advanceActionId);
    assert.equal(ui.state.orderReceipt, original.body.actionId);
    assert.equal(ui.state.pending.kind, 'advance');
    assert.equal(ui.state.busy, false);
    assert.equal(c.calls.command.length, 1);
    assert.equal(c.calls.advance.length, 0);
    ui.syncPendingFromStorage();
    assert.equal(ui.state.pending.kind, 'advance');
    c.storage.fail = () => false;
    if (reload) { ui = c.make(); await ui.sync(); }
    assert.equal(await ui.retry(), true);
    assert.equal(c.calls.command.length, reload ? 2 : 1);
    if (reload) assert.deepEqual(c.calls.command[1], original.body);
    assert.equal(c.calls.advance.length, 1);
    assert.equal(c.calls.advance[0].actionId, original.advanceActionId);
    assert.equal(c.current().elapsedMinutes, 1);
    assert.equal(c.current().revision, 2);
    assert.equal(c.saved().pending, null);
  });
}

for (const reload of [false, true]) {
  test(`acknowledgement checkpoint failure ${reload ? 'replays only the durable step after reload' : 'only saves and reads in memory'}`, async () => {
    const c = fixture(); let ui = c.make(); await ui.sync('test');
    c.storage.fail = value => value.pending === null;
    assert.equal(await ui.placeOrder({ type: 'market-open', side: 'long', contracts: '1' }), false);
    const original = c.saved().pending;
    assert.equal(original.kind, 'advance');
    assert.equal(ui.state.pending, null);
    assert.equal(ui.state.busy, false);
    assert.equal(ui.state.controls.recovery.kind, 'storage');
    ui.syncPendingFromStorage();
    assert.equal(ui.state.pending, null);
    assert.equal(await ui.sync(), false);
    c.storage.fail = () => false;
    if (reload) { ui = c.make(); await ui.sync(); }
    assert.equal(await ui.retry(), true);
    assert.equal(c.calls.command.length, 1);
    assert.equal(c.calls.advance.length, reload ? 2 : 1);
    if (reload) assert.deepEqual(c.calls.advance[1], original.body);
    assert.equal(c.current().elapsedMinutes, 1);
    assert.equal(c.current().revision, 2);
    assert.equal(c.saved().pending, null);
  });
}

test('rejection cleanup failure never turns a rejected request into another submission', async () => {
  const c = fixture(), ui = c.make(); await ui.sync('test');
  let writes = 0;
  c.api.cryptoAction = async () => { writes += 1; throw Object.assign(new Error('rejected'), { status: 409 }); };
  c.storage.fail = value => value.pending === null;
  assert.equal(await ui.act('command', { command: { type: 'cancel-all-orders' } }), false);
  assert.equal(ui.state.pending, null);
  assert.equal(ui.state.busy, false);
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), false);
  assert.equal(c.saved().pending, null);
  assert.equal(writes, 1);
  assert.equal(ui.state.readStale, true);
  assert.equal(await ui.sync(), true);
});

test('404 cleanup retries the checkpoint without discarding an unrelated pending intent', async () => {
  const c = fixture();
  const pending = { kind: 'create', body: { actionId: 'unknown-create' } };
  c.storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify({ sessionId: 'gone', pending }));
  c.api.getReplaySession = async () => { throw Object.assign(new Error('gone'), { status: 404 }); };
  const ui = c.make(); c.storage.fail = value => value.sessionId === null;
  assert.equal(await ui.sync(), false);
  assert.equal(ui.state.busy, false);
  assert.deepEqual(ui.state.pending, pending);
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), true);
  assert.deepEqual(c.saved(), { sessionId: null, pending });
});

test('an unreadable recovery record blocks writes until it has been read successfully', async () => {
  const c = fixture();
  const pending = { kind: 'advance', id: 'test', body: { actionId: 'unknown-step', expectedRevision: 0, minutes: 1 } };
  c.storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify({ sessionId: 'test', pending }));
  c.storage.readFails = true;
  const ui = c.make();
  assert.equal(await ui.act('create'), false);
  assert.equal(ui.state.busy, false);
  assert.equal(ui.state.controls.recovery.kind, 'storage');
  c.storage.readFails = false;
  assert.equal(await ui.retry(), true);
  assert.deepEqual(ui.state.pending, pending);
  assert.equal(ui.state.controls.recovery.kind, 'retry');
  assert.equal(c.calls.advance.length, 0);
});

test('opening the home screen does not replace a saved session reference', async () => {
  const c = fixture();
  const record = { sessionId: 'test', pending: null };
  c.storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify(record));
  const ui = c.make({ restoreSession: false });
  assert.equal(await ui.sync(), true);
  assert.equal(ui.state.session, null);
  assert.deepEqual(c.saved(), record);
  assert.deepEqual(c.calls.reads, []);
});

test('retraining acknowledgement retains its routing context while the checkpoint is blocked', async () => {
  const c = fixture(), ui = c.make(); await ui.sync('test');
  let retrains = 0;
  c.api.cryptoRetrain = async () => { retrains += 1; return { session: { id: 'child', revision: 0 } }; };
  c.storage.fail = value => value.sessionId === 'child';
  assert.equal(await ui.act('retrain'), false);
  assert.equal(ui.state.pending, null);
  assert.equal(ui.targetSessionId, 'child');
  assert.equal(ui.state.controls.retryKind, 'retrain');
  assert.equal(ui.state.controls.recovery.kind, 'storage');
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), true);
  assert.equal(ui.state.session.id, 'child');
  assert.equal(retrains, 1);
  assert.deepEqual(c.saved(), { sessionId: 'child', pending: null });
});

test('failed persistence before an unknown-action retry preserves the uncertainty of the original commit', async () => {
  const c = fixture(), ui = c.make(); await ui.sync('test');
  const action = c.api.cryptoAction;
  c.api.cryptoAction = async (...args) => { await action(...args); throw new Error('response lost'); };
  assert.equal(await ui.act('command', { command: { type: 'cancel-all-orders' } }), false);
  const original = c.saved().pending;
  c.storage.fail = value => Boolean(value.pending);
  assert.equal(await ui.retry(), false);
  assert.match(ui.state.controls.recovery.title, /原操作仍待核对/);
  assert.equal(c.calls.command.length, 1);
  assert.equal(c.current().revision, 1);
  c.storage.fail = () => false; c.api.cryptoAction = action;
  assert.equal(await ui.retry(), true);
  assert.deepEqual(c.calls.command, [original.body, original.body]);
  assert.equal(c.current().revision, 1);
});

test('a failed fresh-session checkpoint blocks creation until its saved reference has been cleared', async () => {
  const c = fixture(), ui = c.make(); await ui.sync('test');
  c.storage.fail = value => value.sessionId === null;
  await ui.fresh();
  assert.equal(ui.state.busy, false);
  assert.equal(ui.state.session, null);
  assert.equal(c.saved().sessionId, 'test');
  assert.equal(ui.state.controls.recovery.kind, 'storage');
  assert.equal(await ui.act('create'), false);
  c.storage.fail = () => false;
  assert.equal(await ui.retry(), true);
  assert.deepEqual(c.saved(), { sessionId: null, pending: null });
  assert.equal(ui.state.controls.newActionsBlocked, false);
});
