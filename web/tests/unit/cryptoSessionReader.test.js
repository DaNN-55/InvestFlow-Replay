import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoSessionReader } from '../../src/utils/cryptoSessionReader.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(revision = 0, traceCount = 0) {
  let current = { id: 'one', instrumentId: 'BTC-USDT-SWAP', revision, elapsedMinutes: revision, gameLength: 1000, revealed: false };
  let traces = Array.from({ length: traceCount }, (_, i) => ({ sequence: i + 1, revision: Math.max(1, revision), observedAtMinute: revision }));
  const calls = { markets: [], audits: [], sessions: 0 };
  const api = {
    getSession: async () => { calls.sessions++; return { session: structuredClone(current) }; },
    readMarket: async (id, params) => {
      calls.markets.push({ id, ...params });
      return { instrumentId: current.instrumentId, elapsedMinutes: params.elapsedMinutes, timeframeMinutes: params.timeframeMinutes, candles: { last: [], mark: [] } };
    },
    readAudit: async (id, kind, params) => {
      const all = kind === 'ledger' ? Array.from({ length: current.revision + 1 }, (_, r) => ({ revision: r, cursorMinute: r })) : traces;
      const items = all.filter(row => (kind === 'ledger' ? row.revision : row.sequence) > params.after).slice(0, params.limit);
      calls.audits.push({ id, kind, ...params, rows: items.length });
      return { revision: current.revision, throughMinute: current.elapsedMinutes, items };
    },
  };
  const reader = createCryptoSessionReader({ getSession: id => api.getSession(id), readMarket: (id, p) => api.readMarket(id, p), readAudit: (id, k, p) => api.readAudit(id, k, p) });
  return { reader, api, calls, get session() { return structuredClone(current); },
    change: patch => { current = { ...current, ...patch }; }, setTraces: rows => { traces = rows; },
    load: (periods = [5]) => reader.read({ session: structuredClone(current), periods }) };
}

test('initial read includes ledger revision zero, deduplicates requested periods, and keeps values read-only', async () => {
  const c = fixture(); const batch = await c.load([5, 5, 60]);
  assert.deepEqual(batch.ledger.map(row => row.revision), [0]); assert.deepEqual(batch.traces, []);
  assert.deepEqual(c.calls.markets.map(row => row.timeframeMinutes), [5, 60]);
  assert.ok(c.calls.markets.every(row => row.limit === 600 && row.elapsedMinutes === 0));
  assert.throws(() => { batch.ledger[0].revision = 9; }, TypeError);
});

for (const count of [0, 199, 200, 201]) test(`${count} traces finish correctly, including an empty page after an exact full page`, async () => {
  const c = fixture(1, count); const batch = await c.load();
  assert.equal(batch.traces.length, count); assert.equal(batch.ledger.length, 2);
  assert.equal(c.calls.audits.filter(row => row.kind === 'traces').length, Math.floor(count / 200) + 1);
});

for (const revision of [198, 199, 200]) test(`ledger through revision ${revision} is complete without an unnecessary trailing empty page`, async () => {
  const c = fixture(revision); const batch = await c.load();
  assert.equal(batch.ledger.length, revision + 1);
  assert.equal(c.calls.audits.filter(row => row.kind === 'ledger').length, Math.ceil((revision + 1) / 200));
});

test('same revision period changes skip audits but still fetch every requested market with the explicit cursor', async () => {
  const c = fixture(450, 450); await c.load([1, 5, 15, 60]); c.calls.audits.length = 0; c.calls.markets.length = 0;
  const batch = await c.load([5, 60]);
  assert.equal(c.calls.audits.length, 0); assert.equal(c.calls.markets.length, 2);
  assert.equal(batch.ledger.length, 451); assert.equal(batch.traces.length, 450);
});

test('revision growth appends ledger and uses the separate trace cursor; zero-event actions are valid', async () => {
  const c = fixture(2, 3); await c.load(); c.calls.audits.length = 0; c.change({ revision: 3, elapsedMinutes: 3 });
  let batch = await c.load(); assert.equal(batch.ledger.length, 4); assert.equal(batch.traces.length, 3);
  assert.deepEqual(c.calls.audits.map(row => [row.kind, row.after, row.rows]), [['ledger', 2, 1], ['traces', 3, 0]]);
  c.change({ revision: 4, elapsedMinutes: 4 }); c.setTraces([...batch.traces, { sequence: 4, revision: 4, observedAtMinute: 4 }, { sequence: 5, revision: 4, observedAtMinute: 4 }]);
  batch = await c.load(); assert.deepEqual(batch.traces.map(row => row.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(batch.traces.map(row => row.revision), [2, 2, 2, 4, 4]);
});

test('a failed partial batch never advances the audit prefix and a retry appends once', async () => {
  const c = fixture(); await c.load(); c.change({ revision: 1, elapsedMinutes: 1 });
  const market = c.api.readMarket; c.api.readMarket = async () => { throw new Error('offline'); };
  await assert.rejects(c.load(), /offline/); c.api.readMarket = market; c.calls.audits.length = 0;
  const batch = await c.load(); assert.equal(batch.ledger.length, 2);
  assert.equal(c.calls.audits.find(row => row.kind === 'ledger').after, 0);
});

test('a version change on a later page discards the whole mixed batch and re-reads once', async () => {
  const c = fixture(200, 201), audit = c.api.readAudit; let changed = false;
  c.api.readAudit = async (id, kind, params) => {
    if (kind === 'traces' && params.after === 200 && !changed) { changed = true; c.change({ revision: 201, elapsedMinutes: 201 }); }
    return audit(id, kind, params);
  };
  const batch = await c.load(); assert.equal(batch.session.revision, 201); assert.equal(batch.ledger.length, 202); assert.equal(batch.traces.length, 201);
  assert.equal(c.calls.sessions, 1); assert.equal(c.calls.audits.filter(row => row.kind === 'ledger' && row.after === -1).length, 2);
});

test('continuous version changes stop after one retry instead of spinning', async () => {
  const c = fixture(), audit = c.api.readAudit;
  c.api.readAudit = async (id, kind, params) => { if (kind === 'ledger') c.change({ revision: c.session.revision + 1, elapsedMinutes: c.session.elapsedMinutes + 1 }); return audit(id, kind, params); };
  await assert.rejects(c.load(), /版本发生变化/); assert.equal(c.calls.sessions, 1);
});

for (const fault of ['ledger-gap', 'trace-gap', 'trace-repeat', 'trace-revision', 'future-minute', 'wrong-through']) test(`${fault} is rejected rather than silently merged`, async () => {
  const c = fixture(2, 2), audit = c.api.readAudit;
  c.api.readAudit = async (id, kind, params) => {
    const page = structuredClone(await audit(id, kind, params));
    if (fault === 'ledger-gap' && kind === 'ledger') page.items.splice(1, 1);
    if (fault === 'trace-gap' && kind === 'traces') page.items[1].sequence = 3;
    if (fault === 'trace-repeat' && kind === 'traces') page.items[1].sequence = 1;
    if (fault === 'trace-revision' && kind === 'traces') page.items[1].revision = 3;
    if (fault === 'future-minute' && kind === 'traces') page.items[1].observedAtMinute = 3;
    if (fault === 'wrong-through') page.throughMinute = 3;
    return page;
  };
  await assert.rejects(c.load(), /会话数据未能一致读取/); assert.equal(c.calls.sessions, 0);
});

test('a short ledger response must still reach the captured revision', async () => {
  const c = fixture(2), audit = c.api.readAudit;
  c.api.readAudit = async (id, kind, p) => { const page = await audit(id, kind, p); return kind === 'ledger' ? { ...page, items: page.items.slice(0, 2) } : page; };
  await assert.rejects(c.load(), /账本未覆盖/);
});

for (const fault of ['cursor', 'period', 'instrument', 'future-candle']) test(`market ${fault} cannot enter the read batch`, async () => {
  const c = fixture(), market = c.api.readMarket;
  c.api.readMarket = async (id, p) => {
    const value = await market(id, p);
    if (fault === 'cursor') value.elapsedMinutes++;
    if (fault === 'period') value.timeframeMinutes++;
    if (fault === 'instrument') value.instrumentId = 'other';
    if (fault === 'future-candle') value.candles.last.push({ knownThroughMinute: 1 });
    return value;
  };
  await assert.rejects(c.load(), /行情周期或可见进度/);
});

test('revealed early completion reads the full market window but audits only actual progress', async () => {
  const c = fixture(2, 1); c.change({ revealed: true, elapsedMinutes: 2, gameLength: 1000 });
  const batch = await c.load(); assert.equal(c.calls.markets[0].elapsedMinutes, 1000); assert.equal(batch.session.elapsedMinutes, 2);
});

test('switching sessions or rolling back revision rebuilds prefixes instead of reusing another state', async () => {
  const c = fixture(2, 2); await c.load(); c.change({ id: 'two', revision: 1, elapsedMinutes: 1 }); c.setTraces([]); c.calls.audits.length = 0;
  let batch = await c.load(); assert.equal(batch.session.id, 'two'); assert.equal(batch.ledger.length, 2); assert.equal(c.calls.audits[0].after, -1);
  c.change({ revision: 0, elapsedMinutes: 0 }); c.calls.audits.length = 0; batch = await c.load();
  assert.equal(batch.ledger.length, 1); assert.equal(c.calls.audits[0].after, -1);
});

test('reset invalidates pending replies and only a newer read can establish a cache', async () => {
  const c = fixture(), gate = deferred(), market = c.api.readMarket;
  c.api.readMarket = async (id, p) => { await gate.promise; return market(id, p); };
  const pending = c.load(); c.reader.reset(); c.api.readMarket = market;
  c.change({ id: 'two' }); const newer = await c.load(); gate.resolve();
  await assert.rejects(pending, error => error.code === 'CRYPTO_READ_SUPERSEDED'); assert.equal(newer.session.id, 'two');
  c.calls.audits.length = 0; await c.load(); assert.equal(c.calls.audits.length, 0);
});
