import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { createDatabase } from "./db.js";
import { createReplayInteraction } from "./replay-interaction.js";
import { createReplayLifecycleStore } from "./replay-lifecycle-store.js";

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
const candle = (overrides = {}) => ({ open: 10, high: 10.2, low: 9.9, close: 10,
  volume: 1000000, amount: 10000000, limitType: "N", ...overrides });
function harness(future, { hybrid = true, slippageBps = 0, costConfig = {}, tsCode = "000001.SZ", executionModelVersion, snapshotExtra = {}, observationDate } = {}) {
  const root = mkdtempSync(join(tmpdir(), "replay-bar-orders-"));
  const path = join(root, "ledger.sqlite");
  let db;
  let api;
  let action = 0;
  const bars = [...Array.from({ length: 250 }, (_, i) => candle({ sequence: i + 1, tradeDate: observationDate ?? `2024-observation-${i}` })),
    ...future.map((bar, i) => candle({ sequence: i + 251, tradeDate: "2024-10-21", ...bar }))];
  const scenario = { sourceDataVersion: "fixed-order-fixture", tsCode, symbol: tsCode.split('.')[0], exchange: tsCode.endsWith('.SH') ? "SSE" : "SZSE", name: "测试股票",
    observationBars: 250, gameLength: future.length, interval: hybrid ? "hybrid" : "1d", stepMinutes: 5, trainingDays: 20, bars, ...snapshotExtra };
  function open() {
    db = createDatabase(path);
    api = createReplayInteraction({ store: createReplayLifecycleStore(db),
      scenarioSource: { createReplayScenario: async () => scenario, prefetchReplayStocks: async () => ({}) } });
  }
  open();
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let id;
  const h = {
    path,
    async create() {
      // Use the real session storage with the fixed snapshot; shorter windows keep tests focused.
      const created = db.createReplaySession({ id: `session-${++action}`, sourceDataVersion: scenario.sourceDataVersion,
        gameLength: future.length, observationBars: 250, revealedFutureBars: 0, status: "active", revision: 0, snapshot: scenario, executionModelVersion,
        account: { initialCapital: 100000, cash: 100000, positionQuantity: 0, availableQuantity: 0, lockedQuantity: 0, averageCost: 0, realizedPnl: 0, totalFees: 0 },
        costConfig: { commissionRate: 0.0003, minCommission: 5, stampTaxRate: 0.0005, transferFeeRate: 0.00001, slippageBps, ...costConfig },
        createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" });
      id = created.id; return h.get();
    },
    get: () => api.get(id).session,
    order: (order) => api.submitOrder(id, { actionId: `order-${++action}`, expectedRevision: h.get().revision, ...order }).session,
    advance: () => api.advance(id, { actionId: `advance-${++action}`, expectedRevision: h.get().revision }).session,
    finish: () => api.finish(id, { actionId: `finish-${++action}`, expectedRevision: h.get().revision }).session,
    cancel(orderId, body = { actionId: `cancel-${++action}`, expectedRevision: h.get().revision }) { return api.cancelOrder(id, orderId, body); },
    reopen() { db.close(); open(); return h.get(); },
    retrain() {
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE replay_sessions SET revealed_at = '2026-10-19T00:00:00Z' WHERE id = ?").run(id);
      raw.close();
      return db.retrainReplaySession({ sourceSessionId: id, id: `retrain-${++action}`, createdAt: '2026-10-19T00:00:00Z' });
    },
  };
  return h;
}

test("limit waits, fills in parts, shares capacity and cancellation preserves fills across restart", async () => {
  const h = harness([
    candle({ open: 10.1, low: 10.03 }), candle({ low: 9.98, volume: 1000 }),
    candle({ volume: 1000 }), candle({ volume: 1000 }), candle(),
  ]);
  await h.create();
  let s = h.order({ side: "buy", quantity: 5000, orderType: "limit", limitPrice: 10 });
  const id = s.pendingOrders[0].orderId;
  assert.equal(h.advance().executions.length, 0);
  s = h.advance();
  assert.equal(s.account.positionQuantity, 1000);
  assert.equal(s.pendingOrders[0].remainingQuantity, 4000);
  assert.equal(h.reopen().pendingOrders[0].remainingQuantity, 4000);
  s = h.advance();
  assert.deepEqual(s.executions.map((fill) => fill.quantity), [1000, 1000]);
  const command = { actionId: "retry-cancel", expectedRevision: s.revision };
  s = h.cancel(id, command).session;
  assert.equal(s.pendingOrders.length, 0);
  assert.equal(s.executions.at(-1).status, "cancelled");
  assert.equal(h.cancel(id, command).idempotent, true);
  assert.equal(h.advance().account.positionQuantity, 2000);
  assert.equal(h.reopen().account.positionQuantity, 2000);
});

test("board-specific submissions reject invalid quantities instead of silently rounding, and STAR preserves 201 shares", async () => {
  for (const tsCode of ['600000.SH', '000001.SZ', '300001.SZ', '301001.SZ']) {
    const h = harness([candle(), candle()], { tsCode });
    const s = await h.create();
    assert.equal(s.executionModelVersion, 'bar-orders-v2');
    assert.equal(s.tradingRules.minimumBuy, 100);
    assert.throws(() => h.order({ side: 'buy', quantity: 150 }), /100股/);
    h.order({ side: 'buy', quantity: 100 });
    assert.equal(h.advance().account.positionQuantity, 100);
  }
  const h = harness([candle(), candle()], { tsCode: '688001.SH' });
  await h.create();
  assert.throws(() => h.order({ side: 'buy', quantity: 100 }), /至少200股/);
  h.order({ side: 'buy', quantity: 201 });
  assert.equal(h.advance().account.positionQuantity, 201);
  assert.equal(h.reopen().account.positionQuantity, 201);
});

test("STAR partial fills are shares, not new declarations; sub-200 tail can sell out after T+1", async () => {
  const h = harness([candle({ volume: 199 }), candle({ volume: 2 }),
    candle({ tradeDate: '2024-10-22', volume: 2 }), candle({ tradeDate: '2024-10-22', volume: 199 }),
    candle({ tradeDate: '2024-10-22' })], { tsCode: '688001.SH' });
  await h.create();
  h.order({ side: 'buy', quantity: 201, orderType: 'limit', limitPrice: 10 });
  assert.equal(h.advance().account.positionQuantity, 199);
  assert.equal(h.advance().account.positionQuantity, 201);
  h.order({ side: 'sell', quantity: 200 });
  assert.equal(h.advance().account.positionQuantity, 199);
  h.cancel(h.get().pendingOrders[0].orderId);
  assert.throws(() => h.order({ side: 'sell', quantity: 198 }), /一次性/);
  h.order({ side: 'sell', quantity: 199 });
  assert.equal(h.advance().account.positionQuantity, 0);
});

test("main-board odd lots can be sold once, alone or with lots, without trapping a partial-fill tail", async () => {
  const h = harness([candle({ volume: 299 }), candle({ tradeDate: '2024-10-22' }), candle({ tradeDate: '2024-10-22' }), candle({ tradeDate: '2024-10-22' })]);
  await h.create();
  h.order({ side: 'buy', quantity: 300, orderType: 'limit', limitPrice: 10 });
  h.advance();
  assert.equal(h.get().executions.at(-1).status, 'expired');
  assert.throws(() => h.order({ side: 'sell', quantity: 198 }), /零股/);
  h.order({ side: 'sell', quantity: 99 });
  assert.equal(h.advance().account.positionQuantity, 200);
  h.order({ side: 'sell', positionRatio: 1 });
  assert.equal(h.advance().account.positionQuantity, 0);
});

test("ratio orders honor STAR minimum and one-share increments and an exhausted small budget is rejected", async () => {
  const h = harness([candle(), candle({ tradeDate: '2024-10-22' }), candle({ tradeDate: '2024-10-22' })], { tsCode: '688001.SH', costConfig: { minCommission: 0, commissionRate: 0, transferFeeRate: 0 } });
  await h.create();
  h.order({ side: 'buy', cashRatio: 0.0201 });
  assert.equal(h.advance().account.positionQuantity, 201);
  h.order({ side: 'sell', positionRatio: 0.5 });
  assert.equal(h.advance().executions.at(-1).status, 'rejected');
  h.order({ side: 'sell', positionRatio: 1 });
  assert.equal(h.advance().account.positionQuantity, 0);
});

test("bar-orders-v1 retains old rounding and restores/retrains with the source model", async () => {
  const h = harness([candle(), candle()], { tsCode: '688001.SH', executionModelVersion: 'bar-orders-v1' });
  await h.create();
  h.order({ side: 'buy', quantity: 150 });
  assert.equal(h.advance().account.positionQuantity, 100);
  assert.equal(h.reopen().executionModelVersion, 'bar-orders-v1');
  h.finish();
  assert.equal(h.retrain().executionModelVersion, 'bar-orders-v1');
});

test("board execution permits ordinary single-price bars and blocks only the constrained side at exact limits", async () => {
  for (const [tsCode, price, expected] of [['600000.SH',10.6,'filled'],['600000.SH',11,'rejected'],
    ['300001.SZ',11,'filled'],['300001.SZ',12,'rejected'],['688001.SH',11,'filled'],['688001.SH',12,'rejected']]) {
    const h=harness([candle({open:price,high:price,low:price,close:price,limitType:null,
      rawPreClose:10,rawOpen:price,rawHigh:price,rawLow:price,rawClose:price,adjustmentMultiplier:1}),candle()],{tsCode,hybrid:false});
    await h.create();
    h.order({side:'buy',quantity:200});
    const s=h.advance();
    assert.equal(s.executions[0].status,expected,`${tsCode} at ${price}`);
    if(expected==='rejected') assert.equal(s.executions[0].reasonCode,'one_price_limit_up');
    assert.equal(s.tradingRules.board, tsCode.startsWith('688')?'star':tsCode.startsWith('300')?'chinext':'main');
    const serialized=JSON.stringify(s);
    for(const secret of [tsCode,'rawDailyPreClose','rawHigh','adjustmentMultiplier','tradeDate']) assert.equal(serialized.includes(secret),false,secret);
  }
  const h=harness([candle({open:9,high:9,low:9,close:9,preClose:10,limitType:null}),
    candle({tradeDate:'2024-10-22',open:9.9,high:9.9,low:9.9,close:9.9,preClose:9,limitType:null}),
    candle({tradeDate:'2024-10-23'})],{hybrid:false});
  await h.create();
  h.order({side:'buy',quantity:100});
  assert.equal(h.advance().account.positionQuantity,100); // Buying at a lower limit is allowed.
  h.order({side:'sell',positionRatio:1});
  assert.equal(h.advance().account.positionQuantity,0); // Selling at an upper limit is allowed.
});

test("uncertain historical limits are visible and do not create a fill", async () => {
  const h=harness([candle({open:10.5,high:10.5,low:10.5,close:10.5,limitType:null}),candle()],{hybrid:false});
  await h.create();
  h.order({side:'buy',quantity:100});
  const s=h.advance();
  assert.equal(s.account.positionQuantity,0);
  assert.equal(s.marketEvent.status,'rule_unavailable');
  assert.equal(s.executions[0].reasonCode,'rule_unavailable');
});

test("STAR latched stop clears even a single-share tail after a partial exit and rebound", async () => {
  const h=harness([candle(),candle({low:9.7}),candle({tradeDate:'2024-10-22',volume:200}),
    candle({tradeDate:'2024-10-22',open:10.1,volume:1}),candle({tradeDate:'2024-10-22'})],{tsCode:'688001.SH'});
  await h.create();
  h.order({side:'buy',quantity:201,decision:buyDecision});
  h.advance(); h.advance();
  assert.equal(h.advance().account.positionQuantity,1);
  assert.equal(h.reopen().pendingOrders[0].remainingQuantity,1);
  assert.equal(h.advance().account.positionQuantity,0);
});

test("unsupported real markets are rejected while the existing synthetic demo keeps its original model", async () => {
  for(const tsCode of ['430001.BJ','510300.SH','900901.SH']) {
    const h=harness([candle(),candle()],{tsCode});
    await assert.rejects(h.create(),/仅支持/);
  }
  const h=harness([candle(),candle()],{tsCode:'DEMO001.SYN',hybrid:false,
    snapshotExtra:{exchange:'DEMO',priceAdjustment:{method:'synthetic-unadjusted',factorSource:'fixture-generator'}}});
  const created=await h.create();
  assert.equal(created.executionModelVersion,'bar-orders-v1');
  assert.equal(created.marketKind,'synthetic');
  assert.equal(created.tradingRules,null);
  h.order({side:'buy',quantity:100});
  assert.equal(h.advance().account.positionQuantity,100);
});

test("day orders expire without losing partial fills and finish closes every remaining order", async () => {
  const h = harness([candle({ volume: 1000 }), candle({ volume: 1000 }), candle({ tradeDate: "2024-10-22" }), candle({ tradeDate: "2024-10-22" })]);
  await h.create();
  h.order({ side: "buy", quantity: 5000, orderType: "limit", limitPrice: 10 });
  h.advance();
  let s = h.advance();
  assert.equal(s.account.positionQuantity, 2000);
  assert.equal(s.executions.at(-1).status, "expired");
  assert.equal(s.pendingOrders.length, 0);
  assert.equal(h.advance().account.positionQuantity, 2000);
  h.order({ side: "buy", quantity: 100, orderType: "limit", limitPrice: 8 });
  s = h.finish();
  assert.equal(s.status, "completed");
  assert.equal(s.pendingOrders.length, 0);
  assert.equal(s.executions.at(-1).status, "cancelled");
});

test("several orders share the same bar capacity and partial fills do not repeat minimum commission", async () => {
  const h = harness([candle({ volume: 1000 }), candle({ volume: 1000 }), candle()]);
  await h.create();
  h.order({ side: "buy", quantity: 600, orderType: "limit", limitPrice: 10 });
  h.order({ side: "buy", quantity: 700, orderType: "limit", limitPrice: 10 });
  let s = h.advance();
  assert.deepEqual(s.executions.map((fill) => fill.quantity), [600, 400]);
  assert.equal(s.pendingOrders[0].remainingQuantity, 300);
  s = h.advance();
  assert.equal(s.account.positionQuantity, 1300);
  assert.deepEqual(s.executions.map((fill) => fill.commission), [5, 5, 0]);
  assert.equal(new Set(s.executions.map((fill) => fill.executionId)).size, 3);
  assert.ok(Math.abs(s.account.totalFees - s.executions.reduce((sum, fill) => sum + fill.totalFee, 0)) < 1e-8);
  assert.ok(s.account.cash > 0);
});

test("buy and sell limits survive slippage without exceeding the limit, including opening gaps", async () => {
  const h = harness([candle({ open: 9.8, low: 9.5 }), candle({ open: 10.2, high: 10.3, tradeDate: "2024-10-22" }), candle({ tradeDate: "2024-10-23" })], { slippageBps: 200 });
  await h.create();
  h.order({ side: "buy", quantity: 100, orderType: "limit", limitPrice: 10 });
  const buy = h.advance().executions[0];
  assert.ok(buy.price <= 10);
  h.order({ side: "sell", quantity: 100, orderType: "limit", limitPrice: 10 });
  const sell = h.advance().executions.at(-1);
  assert.equal(sell.status, "filled");
  assert.ok(sell.price >= 10);
});

test("daily orders get the next trading day before their unfilled remainder expires", async () => {
  const h = harness([candle({ tradeDate: "2024-10-21", volume: 1000 }), candle({ tradeDate: "2024-10-22" })], { hybrid: false });
  await h.create();
  h.order({ side: "buy", quantity: 5000, orderType: "limit", limitPrice: 10 });
  const s = h.advance();
  assert.equal(s.account.positionQuantity, 1000);
  assert.equal(s.executions.at(-1).reasonCode, "day_expired");
  assert.equal(h.advance().account.positionQuantity, 1000);
});

const buyDecision = {
  reasonTags: ["回踩"], confidence: 3, thesis: "价格到达事先观察的支撑位置", plan: "按既定计划买入并观察后续走势",
  riskPlan: "价格跌破防守价后执行预设止损", stopLossPrice: 9.8,
};

test("stop latches through T+1, partial execution, rebound, overnight and database restart", async () => {
  const h = harness([
    candle(), candle({ low: 9.7, close: 9.9 }),
    candle({ tradeDate: "2024-10-22", open: 9.9, low: 9.85, volume: 500 }),
    candle({ tradeDate: "2024-10-22", open: 10.05, low: 9.9, volume: 300 }),
    candle({ tradeDate: "2024-10-23", open: 10.2, high: 10.3, low: 10, volume: 200 }),
    candle({ tradeDate: "2024-10-23" }),
  ]);
  await h.create();
  h.order({ side: "buy", quantity: 1000, decision: buyDecision });
  let s = h.advance();
  assert.equal(s.pendingOrders[0].orderType, "stop");
  assert.equal(s.pendingOrders[0].triggeredSequence, null);
  s = h.advance();
  assert.equal(s.pendingOrders[0].triggeredSequence, 252);
  assert.equal(s.pendingOrders[0].reasonCode, "insufficient_sellable");
  assert.equal(s.account.positionQuantity, 1000);
  assert.equal(h.reopen().pendingOrders[0].triggeredSequence, 252);
  s = h.advance();
  assert.equal(s.account.positionQuantity, 500);
  assert.equal(s.executions.at(-1).price, 9.9);
  s = h.advance();
  assert.equal(s.account.positionQuantity, 200);
  assert.equal(s.executions.at(-1).price, 10.05);
  h.reopen();
  s = h.advance();
  assert.equal(s.account.positionQuantity, 0);
  assert.equal(s.pendingOrders.length, 0);
  assert.equal(h.advance().account.positionQuantity, 0);
  assert.deepEqual(s.executions.filter((fill) => fill.side === "sell").map((fill) => fill.quantity), [500, 300, 200]);
});

test("trigger gaps use executable prices, and cancelling a triggered stop preserves the remaining position", async () => {
  const h = harness([candle(), candle({ tradeDate: "2024-10-22", open: 9.6, high: 9.7, low: 9.5, close: 9.6, volume: 500 }),
    candle({ tradeDate: "2024-10-22", low: 9.4 }), candle({ tradeDate: "2024-10-23" })]);
  await h.create();
  h.order({ side: "buy", quantity: 1000, decision: buyDecision });
  h.advance();
  let s = h.advance();
  assert.equal(s.executions.at(-1).price, 9.6);
  const stop = s.pendingOrders.find((order) => order.orderType === "stop");
  assert.throws(() => h.order({ side: "buy", quantity: 100 }), /止损退出进行中/);
  h.cancel(stop.orderId);
  s = h.reopen();
  assert.equal(s.account.positionQuantity, 500);
  assert.equal(s.pendingOrders.length, 0);
  assert.equal(h.advance().account.positionQuantity, 500);
  assert.equal(h.advance().account.positionQuantity, 500);
});

test("cancelling protection does not silently rearm it when its parent buy fills again", async () => {
  const h = harness([candle({ volume: 500 }), candle({ volume: 500 }), candle({ tradeDate: "2024-10-22", low: 9.5 }), candle({ tradeDate: "2024-10-22" })]);
  await h.create();
  h.order({ side: "buy", quantity: 1000, orderType: "limit", limitPrice: 10, decision: buyDecision });
  const first = h.advance();
  h.cancel(first.pendingOrders.find((order) => order.orderType === "stop").orderId);
  assert.equal(h.advance().account.positionQuantity, 1000);
  const s = h.advance();
  assert.equal(s.account.positionQuantity, 1000);
  assert.equal(s.pendingOrders.some((order) => order.orderType === "stop"), false);
});

test("standalone stops protect existing holdings, and blocked limits persist until day expiry", async () => {
  const h = harness([candle(), candle({ low: 9.7 }), candle({ tradeDate: "2024-10-22", open: 9.9, low: 9.85, volume: 0 }),
    candle({ tradeDate: "2024-10-22", open: 9.9, low: 9.85, volume: 1000 }), candle({ tradeDate: "2024-10-23" })]);
  await h.create();
  h.order({ side: "buy", quantity: 1000 });
  h.advance();
  h.order({ side: "sell", positionRatio: 1, orderType: "stop", stopPrice: 9.8 });
  h.advance();
  const blocked = h.advance();
  assert.equal(blocked.account.positionQuantity, 1000);
  assert.equal(blocked.pendingOrders[0].reasonCode, "suspended");
  assert.equal(h.advance().account.positionQuantity, 0);
});

test("cancellation rejects stale revisions, wrong sessions and already completed orders", async () => {
  const h = harness([candle(), candle(), candle()]);
  await h.create();
  const order = h.order({ side: "buy", quantity: 100 }).pendingOrders[0];
  assert.throws(() => h.cancel(order.orderId, { actionId: "stale", expectedRevision: 0 }), /版本冲突/);
  assert.throws(() => h.cancel("not-in-this-session"), /找不到/);
  h.advance();
  assert.throws(() => h.cancel(order.orderId), /已经结束/);
});

test("natural completion and early finish stop protection without selling fictitious shares", async () => {
  for (const early of [false, true]) {
    const h = harness([candle(), candle()]);
    await h.create();
    h.order({ side: "buy", quantity: 100, decision: buyDecision });
    h.advance();
    const s = early ? h.finish() : h.advance();
    assert.equal(s.status, "completed");
    assert.equal(s.pendingOrders.length, 0);
    assert.equal(s.account.positionQuantity, 100);
    assert.equal(h.reopen().account.positionQuantity, 100);
  }
});

test("a triggered exit cancels pending buys so a completed stop cannot silently reopen the position", async () => {
  const h = harness([candle(), candle({ tradeDate: "2024-10-22", low: 9.7, volume: 2000 }),
    candle({ tradeDate: "2024-10-22", low: 9.7 }), candle({ tradeDate: "2024-10-23" })]);
  await h.create();
  h.order({ side: "buy", quantity: 1000 });
  h.advance();
  h.order({ side: "buy", quantity: 1000, orderType: "limit", limitPrice: 10 });
  h.order({ side: "sell", positionRatio: 1, orderType: "stop", stopPrice: 9.8 });
  let s = h.advance();
  assert.equal(s.account.positionQuantity, 0);
  assert.equal(s.executions.some((item) => item.reasonCode === "stop_cancelled_buy"), true);
  s = h.advance();
  assert.equal(s.account.positionQuantity, 0);
  assert.equal(s.pendingOrders.length, 0);
});

test("legacy fill uniqueness migration retains old fills and the old session execution model", async () => {
  const h = harness([candle(), candle({ tradeDate: "2024-10-22" }), candle({ tradeDate: "2024-10-23" })]);
  const created = await h.create();
  let raw = new DatabaseSync(h.path);
  raw.prepare("UPDATE replay_sessions SET execution_model_version = 'legacy-next-open' WHERE id = ?").run(created.id);
  raw.close();
  h.order({ side: "buy", quantity: 100, actionId: "legacy-buy", expectedRevision: 0 });
  const bought = h.advance();
  raw = new DatabaseSync(h.path);
  const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'replay_fills'").get().sql;
  raw.exec(`ALTER TABLE replay_fills RENAME TO replay_fills_many;
    ${schema.replace(/order_id TEXT NOT NULL/i, "order_id TEXT NOT NULL UNIQUE")};
    INSERT INTO replay_fills SELECT * FROM replay_fills_many; DROP TABLE replay_fills_many;`);
  raw.close();
  const restored = h.reopen();
  assert.deepEqual(restored.executions, bought.executions);
  assert.equal(restored.executionModelVersion, "legacy-next-open");
  assert.deepEqual(h.order({ side: "buy", quantity: 100, actionId: "legacy-buy", expectedRevision: 0 }), restored);
  assert.throws(() => h.order({ side: "buy", quantity: 100, orderType: "limit", limitPrice: 10 }), /旧会话/);
  h.order({ side: "sell", positionRatio: 1 });
  assert.equal(h.advance().account.positionQuantity, 0);
});

test("declaration limits use the first executable bar across the ChiNext rule transition", async () => {
  const before = harness([candle({ tradeDate: "2020-08-21" }), candle({ tradeDate: "2020-08-24" })],
    { hybrid: false, tsCode: "300001.SZ", observationDate: "2020-08-20" });
  assert.equal((await before.create()).tradingRules.maxMarketQuantity, 1000000);
  before.order({ side: "buy", quantity: 200000 });

  const after = harness([candle({ tradeDate: "2020-08-24" }), candle({ tradeDate: "2020-08-25" })],
    { hybrid: false, tsCode: "300001.SZ", observationDate: "2020-08-21" });
  const initial = await after.create();
  assert.equal(initial.tradingRules.maxMarketQuantity, 150000);
  assert.equal(initial.tradingRules.maxLimitQuantity, 300000);
  assert.throws(() => after.order({ side: "buy", quantity: 150100 }), /申报数量上限/);
  assert.throws(() => after.order({ side: "buy", quantity: 300100, orderType: "limit", limitPrice: 10 }), /申报数量上限/);
  assert.equal(after.get().revision, initial.revision);
  assert.equal(after.get().pendingOrders.length, 0);
  after.order({ side: "buy", quantity: 100 });
  assert.equal(after.advance().account.positionQuantity, 100);
});
