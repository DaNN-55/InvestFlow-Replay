import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './db.js';
import { createReplayLifecycleStore } from './replay-lifecycle-store.js';
import { createReplayInteraction } from './replay-interaction.js';
import { createCryptoReplayService } from './replay-crypto-session.js';
const rules = JSON.parse(readFileSync(new URL('../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json', import.meta.url)));
function context(t) {
 const folder = mkdtempSync(join(tmpdir(), 'replay-g1-mixed-')), database = createDatabase(join(folder, 'mixed.sqlite'));
 t.after(() => { database.close(); rmSync(folder, { recursive: true, force: true }); });
 const store = createReplayLifecycleStore(database), start = Date.parse('2024-01-01T00:00:00+08:00'), m = 60000;
 const crypto = createCryptoReplayService({ store, snapshotSource: { load(instrumentId) {
  const bars = Array.from({ length: 241 }, (_, i) => ({ ts: start + (i - 60) * m, open: '50000', high: '50001', low: '49999', close: '50000', sourceConfirm: '1' }));
  return { rules, dataVersion: 'g1-unit-fixture', dataManifestSHA256: 'a'.repeat(64), scenario: { instrumentId,
   window: { backgroundStartMs: start - 60 * m, replayStartMs: start, replayEndMs: start + 180 * m, executionEndMs: start + 181 * m },
   last: bars.map(b => ({ ...b, volumeContracts: '10000', volumeBase: '100', volumeQuote: '5000000' })), mark: bars,
   fundingAudit: { cadenceMs: 60 * m, maxSourceOffsetMs: 2000 }, funding: Array.from({ length: 7 }, (_, i) => ({ ts: start + (i - 2) * 60 * m, settledRate: '.0001' })) } };
 } } });
 const interaction = createReplayInteraction({ store, crypto, scenarioSource: {} });
 function stock(id, model) {
  const bars = Array.from({ length: 270 }, (_, i) => ({ sequence: i + 1, tradeDate: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10), open: 10, high: 10.1, low: 9.9, close: 10, preClose: 10, volume: 100000, amount: 1000000 }));
  return database.createReplaySession({ id, sourceDataVersion: 'g1-stock-fixture', executionModelVersion: model,
   gameLength: 20, observationBars: 250, revealedFutureBars: 0, status: 'active', revision: 0,
   snapshot: { tsCode: '600000.SH', exchange: 'SSE', interval: '1d', observationBars: 250, gameLength: 20, bars, benchmark: { code: '000001.SH', name: 'fixed benchmark', bars: bars.slice(249) } },
   account: { initialCapital: 100000, cash: 100000, positionQuantity: 0, availableQuantity: 0, lockedQuantity: 0, averageCost: 0, realizedPnl: 0, totalFees: 0 },
   costConfig: { commissionRate: .0003, minCommission: 5, stampTaxRate: .0005, transferFeeRate: .00001, slippageBps: 5 },
   createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' });
 }
 return { database, store, crypto, interaction, stock };
}
test('G1 supports each frozen stock executor without downgrading unknown versions', t => {
 const c = context(t);
 for (const model of ['legacy-next-open', 'bar-orders-v1', 'bar-orders-v2']) {
  const s = c.stock(model, model); assert.equal(c.interaction.get(s.id).session.executionModelVersion, model);
  const body = { actionId: 'stock-order', expectedRevision: 0, side: 'buy', quantity: 100 };
  const ordered = c.interaction.submitOrder(s.id, body).session;
  const advanced = c.interaction.advance(s.id, { actionId: 'stock-step', expectedRevision: ordered.revision }).session;
  assert.equal(advanced.account.positionQuantity, 100); assert.equal(advanced.executionModelVersion, model);
  assert.equal(c.interaction.submitOrder(s.id, body).idempotent, true);
 }
 const s = c.stock('future', 'future-stock-v999');
 assert.throws(() => c.interaction.get(s.id), e => e.code === 'REPLAY_VERSION_UNSUPPORTED');
 assert.throws(() => c.interaction.advance(s.id, { actionId: 'never', expectedRevision: 0 }), e => e.code === 'REPLAY_VERSION_UNSUPPORTED');
 assert.equal(c.database.getReplaySession(s.id).revision, 0);
});
test('G1 mixed ledger isolates stock analytics and novelty context from crypto snapshots', t => {
 const c = context(t); c.stock('stock', 'bar-orders-v2');
 const before = c.database.getReplayScenarioUsage();
 const crypto = c.crypto.create({ market: 'crypto-perpetual', actionId: 'crypto', instrumentId: 'BTC-USDT-SWAP' }).session;
 assert.deepEqual(c.database.getReplayTrainingAnalyticsData().sessions.map(s => s.id), ['stock']);
 assert.deepEqual(c.database.getReplayScenarioUsage(), before);
 assert.equal(before.cacheContext.benchmarkCode, '000001.SH');
 assert.deepEqual(c.interaction.list({}).items.map(s => s.id), ['stock']);
 assert.deepEqual(c.interaction.list({ market: 'crypto-perpetual' }).items.map(s => s.id), [crypto.id]);
 const all=c.interaction.list({market:'all',pageSize:1});
 assert.equal(all.total,2);assert.equal(all.items.length,1);
 const second=c.interaction.list({market:'all',pageSize:1,page:2});
 assert.equal(new Set([all.items[0].id,second.items[0].id]).size,2);
 const found=c.interaction.list({market:'all',keyword:'BTC-USDT-SWAP'});
 assert.equal(found.total,1);assert.equal(found.items[0].id,crypto.id);
 assert.equal(found.items[0].reveal,undefined);
 assert.throws(()=>c.interaction.list({market:'unsupported'}),e=>e.code==='INVALID_REPLAY_COMMAND');
});
test('G1 cross-market comparison and stock mutation refuse crypto without changing money or revision', t => {
 const c = context(t), s = c.crypto.create({ market: 'crypto-perpetual', actionId: 'crypto', instrumentId: 'BTC-USDT-SWAP' }).session;
 const before = c.crypto.audit(s.id, 'ledger');
 assert.throws(() => c.interaction.comparison(s.id), e => e.code === 'INVALID_REQUEST');
 assert.throws(() => c.database.submitReplayOrder({ sessionId: s.id, side: 'buy', quantity: 100, actionId: 'wrong-market', expectedRevision: 0 }), e => e.code === 'REPLAY_VERSION_UNSUPPORTED');
 assert.deepEqual(c.crypto.get(s.id).session, s); assert.deepEqual(c.crypto.audit(s.id, 'ledger'), before);
});
