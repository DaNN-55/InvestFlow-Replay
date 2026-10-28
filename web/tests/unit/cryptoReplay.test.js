import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoReplayController, CRYPTO_STORAGE_KEY } from '../../src/utils/cryptoReplayController.js';
import { riskPlan, plannedPricePnl, cryptoChartBars } from '../../src/utils/cryptoReplayPresentation.js';
const memory = () => { const map = new Map(); return { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value) }; };
const session = () => ({ id: 'test', instrumentId: 'BTC-USDT-SWAP', revision: 0, elapsedMinutes: 0, gameLength: 120, revealed: false, account: { position: null }, trainingJournal: { plan: { mode: 'none' } } });
const marketFor = (s, params) => ({ instrumentId:s.instrumentId, timeframeMinutes:params.timeframeMinutes, elapsedMinutes:params.elapsedMinutes, candles:{last:[],mark:[]} });
const auditFor = (s, kind, {after,limit}) => ({ revision:s.revision, throughMinute:s.elapsedMinutes,
  items:kind==='ledger'?Array.from({length:s.revision+1},(_,revision)=>({revision,cursorMinute:s.elapsedMinutes})).filter(row=>row.revision>after).slice(0,limit):[] });
test('all chart periods use one explicit visible cursor, publish atomically, and preserve unknown-action retry state', async()=>{
 const c=context(), apiCalls=[], current={...session(),elapsedMinutes:17,gameLength:120,revision:3};
 const api={getReplaySession:async()=>({session:current}),cryptoMarket:async(_id,params)=>{apiCalls.push(params);return marketFor(current,params);},cryptoAudit:async(_id,kind,params)=>auditFor(current,kind,params),listReplaySessions:async()=>({items:[]})};
 const ui=createCryptoReplayController({api,storage:c.storage});
 ui.state.timeframes=[60,5,15,240];ui.state.timeframe=60;
 await ui.sync('test');assert.equal(apiCalls.length,4);assert.ok(apiCalls.every(p=>p.elapsedMinutes===17));
 assert.deepEqual(Object.keys(ui.state.markets).map(Number).sort((a,b)=>a-b),[5,15,60,240]);
 assert.equal(ui.state.market,ui.state.markets[60]);
 api.cryptoMarket=async(_id,params)=>{if(params.timeframeMinutes===15) throw new Error('frame failed');return marketFor(current,params);};
 const previous=ui.state.markets;assert.equal(await ui.sync(),false);assert.equal(ui.state.markets,previous);assert.match(ui.state.error,/frame failed/);
});
function context() {
  const storage = memory(); let current = session(), calls = 0, lose = false; const committed = new Map();
  const api = { getReplaySession: async () => ({ session: structuredClone(current) }), cryptoMarket: async (_id, params) => marketFor(current, params), cryptoAudit: async (_id, kind, params) => auditFor(current, kind, params), listReplaySessions: async () => ({ items: [] }),
    cryptoAction: async (_id, body) => { calls++; if (committed.has(body.actionId)) return { session: committed.get(body.actionId), idempotent: true };
      if (body.expectedRevision !== current.revision) throw Object.assign(new Error('版本冲突'), { status: 409 });
      current.revision++; committed.set(body.actionId, structuredClone(current)); if (lose) { lose = false; throw new TypeError('network response lost'); } return { session: structuredClone(current) }; } };
  let number = 0; const make = () => createCryptoReplayController({ api, storage, uuid: () => `action-${++number}` });
  return { make, storage, get current() { return current; }, get calls() { return calls; }, loseNext() { lose = true; } };
}
test('lost committed response survives reload and retries the exact original intent once', async () => {
  const c = context(), first = c.make(); await first.sync('test'); c.loseNext(); assert.equal(await first.act('command', { command: { type: 'add-margin', amount: '500' } }), false);
  const pending = JSON.parse(c.storage.getItem(CRYPTO_STORAGE_KEY)).pending;
  assert.equal(c.current.revision, 1); assert.equal(await first.act('command', { command: { type: 'market-open' } }), false); assert.equal(c.calls, 1);
  const restored = c.make(); await restored.sync(); assert.deepEqual(restored.state.pending, pending);
  assert.equal(await restored.retry(), true); assert.equal(c.current.revision, 1); assert.equal(restored.state.pending, null); assert.equal(c.calls, 2);
});
test('successful retry refreshes current server state instead of restoring the old commit', async () => {
  const c = context(), ui = c.make(); await ui.sync('test'); c.loseNext(); await ui.act('command', { command: { type: 'cancel-all-orders' } }); c.current.revision = 5;
  await ui.retry(); assert.equal(ui.state.session.revision, 5); assert.equal(ui.state.pending, null);
});
test('revision conflicts do not silently resubmit a changed intention with a new revision', async () => {
  const c = context(), ui = c.make(); await ui.sync('test'); c.current.revision = 2;
  await ui.act('command', { command: { type: 'cancel-all-orders' } }); assert.equal(ui.state.pending, null); assert.match(ui.state.error, /版本冲突/); assert.equal(c.calls, 1);
  await ui.sync(); assert.equal(ui.state.session.revision, 2);
});
test('risk mode follows live protective stop, preserves manual plans and has no zero-loss estimate without a price', () => {
  const s = session(); assert.equal(riskPlan(s).mode, 'none'); assert.equal(plannedPricePnl(s), null);
  s.account.position = { side: 'long', contracts: '10', entryPrice: '50000' }; s.contract = { ctVal: '.01', ctMult: '1' };
  s.trainingJournal.plan = { mode: 'manual', manualExitPrice: '49000' }; assert.equal(riskPlan(s).mode, 'manual'); assert.equal(plannedPricePnl(s), -100);
  s.protection = { stopLoss: { price: '49500', reference: 'mark' } }; assert.equal(riskPlan(s).mode, 'automatic'); assert.equal(plannedPricePnl(s), -50);
  s.protection = null; assert.equal(riskPlan(s).mode, 'manual');
});
test('chart uses relative labels and completed prefix without reconstructing hidden dates', () => {
  const bars = cryptoChartBars({ candles: { last: [{ startMinute: -60, knownThroughMinute: 1, complete: false, open: '1', close: '2', high: '3', low: '1', volumeContracts: '7' }] } });
  assert.equal(bars[0].endSequence, 0); assert.match(bars[0].displayLabel, /形成中/); assert.equal(bars[0].volume, '7'); assert.equal(bars[0].timestamp, undefined);
});


test('pool outage does not block recovery or committed actions in an already frozen session', async () => {
  const current = session(), storage = memory();
  const api = { getReplaySession: async () => ({ session: { ...current } }), cryptoMarket: async (_id, params) => marketFor(current, params), cryptoAudit: async (_id, kind, params) => auditFor(current, kind, params), listReplaySessions: async () => ({ items: [current] }),
    cryptoPool: async () => { throw Object.assign(new Error('目录不可用'), { status: 503 }); },
    cryptoAction: async () => { current.revision++; return { session: { ...current } }; } };
  const ui = createCryptoReplayController({ api, storage, uuid: () => 'frozen-action' });
  assert.equal(await ui.sync('test'), true); assert.equal(ui.state.error, ''); assert.match(ui.state.poolError, /已保存练习仍按原版本恢复/);
  assert.equal(await ui.act('command', { command: { type: 'cancel-all-orders' } }), true); assert.equal(ui.state.session.revision, 1); assert.equal(ui.state.pending, null); assert.ok(ui.state.market);
  api.cryptoPool = async () => ({ mode: 'history-pool', admittedWindows: 210 });
  assert.equal(await ui.sync(), true); assert.equal(ui.state.poolError, ''); assert.equal(ui.state.pool.admittedWindows, 210);
});

function recoveryApi() {
  const current = session();
  const api = { getReplaySession: async () => ({ session: structuredClone(current) }), listReplaySessions: async () => ({ items: [current] }), cryptoPool: async () => ({ mode: 'fixed-source', admittedWindows: 2 }) };
  api.cryptoMarket = async (id, params) => marketFor((await api.getReplaySession(id)).session, params);
  api.cryptoAudit = async (id, kind, params) => auditFor((await api.getReplaySession(id)).session, kind, params);
  return api;
}
test('F2 rejected-before-write create clears pending and allows frozen history restore after reload', async () => {
  const storage = memory(), api = recoveryApi();
  api.createReplaySession = async () => { throw Object.assign(new Error('行情池文件缺失'), { status: 503, code: 'REPLAY_SNAPSHOT_UNAVAILABLE', details: { actionOutcome: 'not-committed' } }); };
  const ui = createCryptoReplayController({ api, storage, uuid: () => 'failed-create' });
  await ui.sync('test'); await ui.fresh();
  assert.equal(await ui.act('create', { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP' }), false);
  assert.equal(ui.state.pending, null);
  const restored = createCryptoReplayController({ api, storage }); await restored.sync(); await restored.select('test');
  assert.equal(restored.state.session.id, 'test'); assert.equal(restored.state.history.length, 1);
});
test('F2 unknown create outcome allows read-only history while preserving exact retry and write lock', async () => {
  const storage = memory(), api = recoveryApi(), bodies = []; let fail = true;
  api.createReplaySession = async body => { bodies.push(structuredClone(body)); if (fail) throw Object.assign(new Error('结果未知'), { status: 503 }); return { session: session(), idempotent: true }; };
  const ui = createCryptoReplayController({ api, storage, uuid: () => 'unknown-create' });
  await ui.sync('test'); await ui.fresh(); await ui.act('create', { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP' });
  const pending = JSON.parse(JSON.stringify(ui.state.pending));
  const restored = createCryptoReplayController({ api, storage }); await restored.sync(); await restored.select('test');
  assert.equal(restored.state.session.id, 'test'); assert.deepEqual(restored.state.pending, pending);
  await restored.period(60); assert.equal(restored.state.market.candles.last.length, 0); assert.equal(restored.state.timeframe, 60);
  assert.equal(await restored.act('command', { command: { type: 'add-margin', amount: '500' } }), false);
  await restored.fresh(); assert.equal(restored.state.session.id, 'test');
  fail = false; assert.equal(await restored.retry(), true); assert.deepEqual(bodies, [pending.body, pending.body]); assert.equal(restored.state.pending, null);
});
test('F2 stale 404 reference is cleared and loads history and pool without losing pending intent', async () => {
  const storage = memory(), api = recoveryApi(); let staleReads = 0;
  const pending = { kind: 'create', body: { actionId: 'uncertain' } };
  storage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify({ sessionId: 'deleted', pending }));
  api.getReplaySession = async id => { if (id === 'deleted') { staleReads++; throw Object.assign(new Error('会话不存在'), { status: 404 }); } return { session: session() }; };
  const ui = createCryptoReplayController({ api, storage }); assert.equal(await ui.sync(), true);
  assert.equal(ui.state.session, null); assert.equal(ui.state.history.length, 1); assert.equal(ui.state.pool.admittedWindows, 2);
  assert.equal(JSON.parse(storage.getItem(CRYPTO_STORAGE_KEY)).sessionId, null); assert.deepEqual(ui.state.pending, pending);
  const reload = createCryptoReplayController({ api, storage }); await reload.sync(); assert.equal(staleReads, 1);
  await reload.select('test'); assert.equal(reload.state.session.id, 'test'); assert.deepEqual(reload.state.pending, pending);
});
test('F2 malformed success response is an unknown outcome and must retain pending', async () => {
  const api = recoveryApi(); api.createReplaySession = async () => { throw Object.assign(new Error('服务返回格式异常'), { status: 201 }); };
  const ui = createCryptoReplayController({ api, storage: memory(), uuid: () => 'lost-success-body' });
  await ui.act('create', { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP' }); assert.equal(ui.state.pending.body.actionId, 'lost-success-body');
});

test('F4 controlled lines follow price references, remaining quantity and cancellation', async () => {
  const { cryptoChartLines, cryptoRiskDetails } = await import('../../src/utils/cryptoReplayPresentation.js');
  const s = session(); s.trainingJournal.plan = { mode: 'manual', manualExitPrice: '49000' };
  s.orders = [{ id: 1, type: 'limit', intent: 'increase', side: 'long', remainingContracts: '6', limitPrice: '48000' }];
  s.protection = { contracts: '4', stopLoss: { price: '47000', reference: 'mark' } };
  const last = cryptoChartLines(s, 'last'), mark = cryptoChartLines(s, 'mark');
  assert.equal(last.length, 3); assert.ok(last.slice(0, 2).every(l => l.dashed)); assert.equal(last[1].contracts, '6');
  assert.equal(last[2].reference, 'mark'); assert.equal(last[2].dashed, false);
  assert.equal(mark.length, 1); assert.equal(mark[0].dashed, false); assert.match(mark[0].label, /自动止损.*4张.*mark/);
  s.protection.contracts = '2'; assert.match(cryptoChartLines(s, 'mark')[0].label, /2张/);
  s.orders = []; s.protection = null; assert.equal(cryptoChartLines(s, 'mark').length, 0); assert.equal(cryptoChartLines(s, 'last').length, 1);
  const next = { ...s, id: 'another' }; assert.notEqual(cryptoChartLines(next)[0].id, cryptoChartLines(s)[0].id);
  s.account.position = { side: 'short' }; s.risk = { baseQuantity: '.1', notional: '5000', unrealizedPnl: '-100', estimatedLiquidationPrice: '55000' }; s.summary = { accountEquity: '10000' }; s.currentPrices = { mark: '50000' };
  assert.equal(cryptoRiskDetails(s).liquidationDistancePercent, 10); assert.equal(cryptoRiskDetails(s).unrealizedEquityPercent, -1);
});
test('F1 preview loader rejects late and mismatched session responses', async () => {
  const { createCryptoPreviewLoader } = await import('../../src/utils/cryptoOrderPreview.js');
  const waiting = [], values = []; const loader = createCryptoPreviewLoader({ request: () => new Promise(resolve => waiting.push(resolve)), changed: value => values.push(value) });
  const a = loader.load({ sessionId: 'a', expectedRevision: 0 }), b = loader.load({ sessionId: 'b', expectedRevision: 2 });
  waiting[1]({ preview: { sessionId: 'b', revision: 2, contracts: '5' } }); await b;
  waiting[0]({ preview: { sessionId: 'a', revision: 0, contracts: '10' } }); await a;
  assert.equal(values.at(-1).preview.sessionId, 'b');
  const c = loader.load({ sessionId: 'b', expectedRevision: 3 }); waiting[2]({ preview: { sessionId: 'b', revision: 2 } }); await c;
  assert.match(values.at(-1).error, /会话已变化/); assert.equal(values.at(-1).preview, null);
});
test('chart distinguishes filled long/short positions, active protection and pending attached protection', async()=>{
  const {cryptoChartLines}=await import('../../src/utils/cryptoReplayPresentation.js');
  const s=session();
  s.account.position={side:'long',entryPrice:'50000',contracts:'3'};
  s.risk={unrealizedPnl:'12.50'};
  s.orders=[{id:'waiting',type:'limit',side:'long',remainingContracts:'2',limitPrice:'49900',attachedProtection:{stopLoss:{price:'49000',reference:'last'}}}];
  s.protection={contracts:'3',stopLoss:{price:'49500',reference:'last'},takeProfit:{price:'51000',reference:'mark'}};
  const last=cryptoChartLines(s,'last'),mark=cryptoChartLines(s,'mark');
  assert.match(last[0].label,/多仓均价.*\+12.50 USDT.*3张/);
  assert.equal(mark[0].price,'50000');
  assert.ok(last.some(l=>l.label.includes('待成交后止损')&&l.dashed&&l.contracts==='2'));
  assert.ok(last.some(l=>l.id.endsWith(':stopLoss')&&!l.dashed&&l.contracts==='3'));
  assert.ok(mark.some(l=>l.id.endsWith(':takeProfit')));
  assert.ok(last.some(l=>l.id.endsWith(':takeProfit')&&l.reference==='mark'));
  assert.ok(mark.some(l=>l.id.endsWith(':stopLoss')&&l.reference==='last'));
  s.orders[0].protectionApplied=true;
  assert.ok(!cryptoChartLines(s,'last').some(l=>l.label.includes('待成交后止损')));
  s.account.position.side='short';s.risk.unrealizedPnl='-2';
  assert.match(cryptoChartLines(s,'last')[0].label,/空仓均价.*-2.00/);
  s.account.position=null;s.orders=[];s.protection=null;
  assert.deepEqual(cryptoChartLines(s,'last'),[]);
});
test('price tags have axis prices and honest off-screen arrows without a clamped price line',async()=>{
  const {REPLAY_PRICE_LINE_OVERLAY:overlay}=await import('../../src/utils/replayPriceLines.js');
  const context={coordinates:[{y:30}],bounding:{width:400,height:200},overlay:{extendData:{color:'green',label:'自动止盈',price:'51000',background:'#101828'}}};
  assert.equal(overlay.createPointFigures(context)[1].styles.backgroundColor,'#101828');
  assert.equal(overlay.createYAxisFigures(context)[0].attrs.text,'51000');
  const outside={...context,coordinates:[{y:-50}]};
  const figures=overlay.createPointFigures(outside);
  assert.equal(figures.length,1);assert.equal(figures[0].type,'text');
  assert.match(figures[0].attrs.text,/↑.*51000/);
  assert.deepEqual(overlay.createYAxisFigures(outside),[]);
  const levels=[{id:'a',price:10},{id:'b',price:11},{id:'c',price:12}];
  const tags=levels.map(level=>overlay.createPointFigures({...context,yAxis:{convertToPixel:p=>p},coordinates:[{y:level.price}],overlay:{extendData:{...context.overlay.extendData,...level,levels}}})[1]);
  assert.ok(tags[1].attrs.y-tags[0].attrs.y>=22);
  assert.ok(tags[2].attrs.y-tags[1].attrs.y>=22);
});
test('F4 price overlay is locked, uses full chart width and distinguishes dashed plans from protection', async () => {
  const { REPLAY_PRICE_LINE_OVERLAY: overlay } = await import('../../src/utils/replayPriceLines.js');
  const figures = overlay.createPointFigures({ coordinates: [{ x: 50, y: 30 }], bounding: { width: 500, height: 200 }, overlay: { extendData: { color: '#a16207', dashed: true, label: '手动计划（不执行）' } } });
  assert.equal(overlay.lock, true); assert.deepEqual(figures[0].attrs.coordinates, [{ x: 0, y: 30 }, { x: 500, y: 30 }]); assert.equal(figures[0].styles.style, 'dashed'); assert.match(figures[1].attrs.text, /不执行/);
});

test('F6 unavailable or stale derived review never masks a saved action or crosses sessions', async () => {
  const current = { ...session(), revealed: true }, api = recoveryApi();
  api.getReplaySession = async id => ({ session: { ...current, id } });
  api.cryptoAnalysis = async () => { throw Object.assign(new Error('派生核对失败'), { status: 500 }); };
  api.cryptoAction = async () => ({ session: { ...current, revision: ++current.revision } });
  const ui = createCryptoReplayController({ api, storage: memory(), uuid: () => 'review-independent' });
  assert.equal(await ui.sync('test'), true); assert.equal(ui.state.error, ''); assert.match(ui.state.analysisError, /原资金结果已保留/);
  assert.equal(await ui.act('command', { command: { type: 'cancel-all-orders' } }), true); assert.equal(ui.state.pending, null);
  api.cryptoAnalysis = async () => ({ sessionId: 'another', revision: 1, analysis: { maxDrawdownPercent: '90' } });
  await ui.select('another'); assert.equal(ui.state.analysis.sessionId, 'another');
  api.cryptoMarket = async () => { throw new Error('读取失败'); };
  await ui.select('new-unavailable'); assert.equal(ui.state.analysis, null); assert.deepEqual(ui.state.traces, []);
});

test('mark-price charts use real trading volume from the identical visible candle, never array position', () => {
  const candle = { startMinute: 0, knownThroughMinute: 3, complete: false, open:'10', high:'12', low:'9', close:'11' };
  const view = { candles:{ mark:[candle], last:[{...candle,startMinute:-5,knownThroughMinute:0,volumeContracts:'999'}, {...candle,volumeContracts:'12.5',volumeQuote:'125'}] } };
  const [mark] = cryptoChartBars(view,'mark');
  assert.equal(mark.volume,'12.5');
  assert.equal(mark.amount,'125');
  assert.equal(mark.endSequence,2);
  assert.equal(mark.open,'10');
  assert.equal(cryptoChartBars(view,'last')[0].volume,'999');
  assert.equal(view.candles.mark[0].volumeContracts,undefined);
});
test('a mark candle cannot borrow volume from a later prefix or display missing volume as zero', () => {
  const candle = { startMinute:0, knownThroughMinute:3, complete:false, open:'10',high:'12',low:'9',close:'11' };
  const view = { candles:{mark:[candle],last:[{...candle,knownThroughMinute:5,volumeContracts:'99999'}]} };
  assert.equal(cryptoChartBars(view,'mark')[0].volume,null);
  assert.equal(cryptoChartBars({candles:{mark:[candle]}},'mark')[0].volume,null);
});

function readFixture() {
  const storage = memory(), calls = { session: 0, market: 0, audit: [], history: 0, pool: 0, writes: [] };
  let current = session(); const committed = new Map();
  const api = {
    getReplaySession: async id => { calls.session++; return { session: { ...structuredClone(current), id } }; },
    cryptoMarket: async (_id, params) => { calls.market++; return marketFor(current, params); },
    cryptoAudit: async (_id, kind, params) => { const page = auditFor(current, kind, params); calls.audit.push({ kind, ...params, rows: page.items.length }); return page; },
    listReplaySessions: async () => { calls.history++; return { items: [{ ...current }] }; },
    cryptoPool: async () => { calls.pool++; return { admittedWindows: calls.pool }; },
    cryptoAction: async (_id, body) => {
      calls.writes.push(structuredClone(body));
      if (committed.has(body.actionId)) return { session: committed.get(body.actionId), idempotent: true };
      current = { ...current, revision: current.revision + 1 }; committed.set(body.actionId, structuredClone(current));
      return { session: structuredClone(current) };
    },
  };
  let uuid = 0;
  const ui = createCryptoReplayController({ api, storage, uuid: () => `read-write-${++uuid}` });
  return { api, ui, calls, storage, change: patch => { current = { ...current, ...patch }; } };
}

test('period-only sync reuses audit prefixes but preserves fresh session, history, pool and market requests', async () => {
  const c = readFixture(); await c.ui.sync('test');
  const before = { ...c.calls, audits: c.calls.audit.length };
  assert.equal(await c.ui.period(60), true);
  assert.equal(c.calls.audit.length, before.audits); assert.equal(c.calls.session, before.session + 1);
  assert.equal(c.calls.history, before.history + 1); assert.equal(c.calls.pool, before.pool + 1); assert.equal(c.calls.market, before.market + 1);
  c.change({ revision: 1, elapsedMinutes: 1 }); c.calls.audit.length = 0;
  assert.equal(await c.ui.period(15), true);
  assert.equal(c.ui.state.session.revision, 1); assert.equal(c.ui.state.market.elapsedMinutes, 1);
  assert.deepEqual(c.calls.audit.map(row => [row.kind, row.after, row.rows]), [['ledger', 0, 1], ['traces', 0, 0]]);
});

test('failed read retains the entire previous session batch and blocks writes until a successful sync', async () => {
  const c = readFixture(); await c.ui.sync('test');
  const old = { session: c.ui.state.session, markets: c.ui.state.markets, ledger: c.ui.state.ledger, traces: c.ui.state.traces };
  c.change({ revision: 1, elapsedMinutes: 1 }); const market = c.api.cryptoMarket;
  c.api.cryptoMarket = async () => { throw new Error('market offline'); };
  assert.equal(await c.ui.sync(), false); assert.equal(c.ui.state.readStale, true);
  for (const [key, value] of Object.entries(old)) assert.equal(c.ui.state[key], value);
  assert.equal(await c.ui.act('command', { command: { type: 'cancel-all-orders' } }), false); assert.equal(c.calls.writes.length, 0);
  await c.ui.fresh(); assert.equal(c.ui.state.session, old.session);
  c.api.cryptoMarket = market; assert.equal(await c.ui.sync(), true); assert.equal(c.ui.state.readStale, false);
  assert.equal(c.ui.state.session.revision, 1); assert.equal(c.ui.state.ledger.length, 2);
});

test('acknowledged write plus history failure never republishes a mixed batch or resubmits the write', async () => {
  const c = readFixture(); await c.ui.sync('test'); const previous = c.ui.state.session, history = c.api.listReplaySessions;
  c.api.listReplaySessions = async () => { throw new Error('history offline'); };
  assert.equal(await c.ui.act('command', { command: { type: 'cancel-all-orders' } }), false);
  assert.equal(c.ui.state.session, previous); assert.equal(c.ui.state.readStale, true); assert.equal(c.ui.state.pending, null);
  c.api.listReplaySessions = history; assert.equal(await c.ui.retry(), true);
  assert.equal(c.calls.writes.length, 1); assert.equal(c.ui.state.session.revision, 1); assert.equal(c.ui.state.readStale, false);
});

test('version retry refreshes core reads once while history and pool keep one request per synchronization', async () => {
  const c = readFixture(), audit = c.api.cryptoAudit; let change = true;
  c.api.cryptoAudit = async (...args) => { if (change) { change = false; c.change({ revision: 1, elapsedMinutes: 1 }); } return audit(...args); };
  assert.equal(await c.ui.sync('test'), true); assert.equal(c.ui.state.session.revision, 1);
  assert.equal(c.calls.session, 2); assert.equal(c.calls.history, 1); assert.equal(c.calls.pool, 1);
});

test('switching to an unreadable session clears old content and remembers the new target for recovery', async () => {
  const c = readFixture(); await c.ui.sync('test'); const get = c.api.getReplaySession;
  c.api.getReplaySession = async () => { throw new Error('session offline'); };
  assert.equal(await c.ui.select('two'), false); assert.equal(c.ui.state.session, null); assert.deepEqual(c.ui.state.markets, {}); assert.deepEqual(c.ui.state.ledger, []);
  assert.equal(c.ui.state.readStale, true); assert.equal(JSON.parse(c.storage.getItem(CRYPTO_STORAGE_KEY)).sessionId, 'two');
  c.api.getReplaySession = get; assert.equal(await c.ui.sync(), true); assert.equal(c.ui.state.session.id, 'two');
});

test('acknowledged retraining remembers the child even if its first read fails and never shows the parent', async () => {
  const c = readFixture(); await c.ui.sync('test'); const market = c.api.cryptoMarket;
  c.api.cryptoRetrain = async () => ({ session: { ...session(), id: 'child' } });
  c.api.cryptoMarket = async () => { throw new Error('child market offline'); };
  assert.equal(await c.ui.act('retrain'), false); assert.equal(c.ui.state.pending, null); assert.equal(c.ui.state.session, null);
  assert.equal(JSON.parse(c.storage.getItem(CRYPTO_STORAGE_KEY)).sessionId, 'child'); assert.equal(c.ui.state.readStale, true);
  c.api.cryptoMarket = market; assert.equal(await c.ui.sync(), true); assert.equal(c.ui.state.session.id, 'child');
});

test('the exact pending write remains retryable even while read synchronization is stale', async () => {
  const c = readFixture(); await c.ui.sync('test'); const action = c.api.cryptoAction, market = c.api.cryptoMarket;
  c.api.cryptoAction = async (...args) => { await action(...args); throw new Error('response lost'); };
  assert.equal(await c.ui.act('command', { command: { type: 'cancel-all-orders' } }), false);
  const pending = structuredClone(c.ui.state.pending);
  c.api.cryptoMarket = async () => { throw new Error('market offline'); }; await c.ui.sync(); assert.equal(c.ui.state.readStale, true);
  c.api.cryptoAction = action; c.api.cryptoMarket = market;
  assert.equal(await c.ui.retry(), true); assert.deepEqual(c.calls.writes[1], pending.body);
  assert.equal(c.ui.state.pending, null); assert.equal(c.ui.state.session.revision, 1); assert.equal(c.ui.state.readStale, false);
});

test('a directory 404 preserves the valid session and its recovery target', async () => {
  const c = readFixture(); await c.ui.sync('test'); const previous = c.ui.state.session;
  c.api.listReplaySessions = async () => { throw Object.assign(new Error('history missing'), { status: 404 }); };
  assert.equal(await c.ui.sync(), false); assert.equal(c.ui.state.session, previous);
  assert.equal(c.ui.state.readStale, true); assert.equal(JSON.parse(c.storage.getItem(CRYPTO_STORAGE_KEY)).sessionId, 'test');
});

for (const lateFailure of [false, true]) {
  test(`a late pool ${lateFailure ? 'failure' : 'success'} from a failed batch cannot change a later synchronization`, async () => {
    const c = readFixture(); await c.ui.sync('test'); const market = c.api.cryptoMarket;
    let resolvePool, rejectPool;
    c.api.cryptoPool = () => new Promise((resolve, reject) => { resolvePool = resolve; rejectPool = reject; });
    c.api.cryptoMarket = async () => { throw new Error('market offline'); };
    assert.equal(await c.ui.sync(), false);
    c.api.cryptoMarket = market;
    c.api.cryptoPool = async () => {
      if (!lateFailure) throw new Error('current pool unavailable');
      return { admittedWindows: 99 };
    };
    assert.equal(await c.ui.sync(), true);
    const expectedPool = c.ui.state.pool, expectedError = c.ui.state.poolError;
    if (lateFailure) rejectPool(new Error('old pool unavailable')); else resolvePool({ admittedWindows: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.ui.state.pool, expectedPool); assert.equal(c.ui.state.poolError, expectedError);
  });
}
