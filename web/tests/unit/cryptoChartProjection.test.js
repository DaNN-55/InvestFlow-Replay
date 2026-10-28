import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCryptoCharts } from '../../src/utils/cryptoChartProjection.js';

function fixture() {
  const session = {
    id: 'projection', revision: 3, status: 'active', ending: false,
    contract: { ctVal: '0.01', ctMult: '1', tickSz: '0.1' }, config: { leverage: '10' },
    account: { position: { side: 'long', contracts: '2', entryPrice: '50000', entryNotional: '1000' } },
    risk: { unrealizedPnl: '12.50' }, trainingJournal: { plan: { mode: 'manual', manualExitPrice: '48500' } },
    protection: { contracts: '2', stopLoss: { price: '49000', reference: 'last' }, takeProfit: { price: '52000', reference: 'mark' } },
    orders: [{ id: 7, type: 'limit', side: 'long', intent: 'increase', limitPrice: '48000', remainingContracts: '3',
      attachedProtection: { stopLoss: { price: '47000', reference: 'last' } } }],
  };
  const bar = { startMinute: 0, knownThroughMinute: 3, complete: false, open: '49990.1', high: '50001.2', low: '49989.3', close: '50000.4' };
  const market = timeframeMinutes => ({ timeframeMinutes, candles: {
    last: [{ ...bar, volumeContracts: '0', volumeQuote: '0.00000001' }], mark: [{ ...bar }],
  } });
  return { session, markets: { 5: market(5), 15: market(15), 60: market(60) },
    display: { periods: [5, 5, 15, 60], kinds: ['last', 'mark', 'last', 'mark'] }, interaction: {} };
}
const line = (result, index, id) => result.models[index].lines.find(item => item.id === `projection:${id}`);
const actionable = model => model.lines.filter(item => item.draggable || item.cancellable);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('projection preserves pane order, raw bar values, causal volume matching and forming labels', () => {
  const input = fixture(), result = projectCryptoCharts(input);
  assert.equal(result.models.length, 4);
  for (const model of result.models) {
    assert.equal(model.showVolume, true);
    assert.equal(model.bars[0].close, '50000.4'); assert.equal(model.bars[0].volume, '0');
    assert.equal(model.bars[0].amount, '0.00000001'); assert.equal(model.bars[0].endSequence, 2);
    assert.equal(model.bars[0].displayLabel, 'D1 00:00 · 形成中');
  }
  assert.equal(result.models[1].bars[0].volumeContracts, undefined);
  input.markets[5].candles.mark[0].knownThroughMinute = 2;
  const changed = projectCryptoCharts(input);
  assert.equal(changed.models[0].showVolume, true); assert.equal(changed.models[1].showVolume, false);
  assert.equal(changed.models[1].bars[0].volume, null);
});

test('one missing volume suppresses that pane volume and missing markets keep empty bars', () => {
  const input = fixture(); input.markets[5].candles.last.push({ ...input.markets[5].candles.last[0], startMinute: 5, volumeContracts: null });
  delete input.markets[15];
  const { models } = projectCryptoCharts(input);
  assert.equal(models[0].showVolume, false); assert.deepEqual(models[2].bars, []); assert.equal(models[2].showVolume, false);
  assert.ok(models[2].lines.length > 0); // Loading remains a workspace concern, as before.
});

test('price references retain position, manual plan, order and attached protection semantics', () => {
  const input = fixture(), result = projectCryptoCharts(input);
  assert.deepEqual(result.models[0].lines.map(item => item.id), ['projection:position', 'projection:manual', 'projection:order-7', 'projection:order-7-stopLoss', 'projection:stopLoss', 'projection:takeProfit']);
  assert.deepEqual(result.models[1].lines.map(item => item.id), ['projection:position', 'projection:order-7-stopLoss', 'projection:stopLoss', 'projection:takeProfit']);
  assert.equal(line(result, 1, 'stopLoss').reference, 'last');
  assert.match(line(result, 1, 'stopLoss').compactLabel, /最新价触发/);
  assert.equal(line(result, 0, 'takeProfit').reference, 'mark');
  assert.equal(line(result, 0, 'position').moneyTitle, '12.50 USDT');
  assert.equal(line(result, 0, 'order-7').cancelLabel, '限价委托 #7，48000');
  assert.equal(line(result, 0, 'stopLoss').cancelLabel, '自动止损，49000');
  assert.equal(line(result, 1, 'takeProfit').cancelLabel, '自动止盈，52000');
  assert.deepEqual(actionable(result.models[0]).map(item => item.id), ['projection:order-7', 'projection:stopLoss', 'projection:takeProfit']);
  assert.ok(actionable(result.models[0]).every(item => item.draggable && item.cancellable));
  assert.equal(line(result, 0, 'order-7-stopLoss').estimate, undefined);
  input.session.orders[0].protectionApplied = true;
  assert.equal(line(projectCryptoCharts(input), 0, 'order-7-stopLoss'), undefined);
});

for (const block of ['busy', 'blocked', 'draft', 'completed', 'ending']) {
  test(`${block} disables editing on every pane without hiding original lines`, () => {
    const input = fixture();
    if (block === 'draft') input.interaction.priceDraft = { leg: 'stopLoss', price: '49500' };
    else if (block === 'completed') input.session.status = 'completed';
    else if (block === 'ending') input.session.ending = true;
    else input.interaction[block] = true;
    const result = projectCryptoCharts(input);
    assert.ok(result.models.every(model => actionable(model).length === 0));
    assert.ok(result.models.every(model => model.lines.some(item => item.id === 'projection:position')));
  });
}

for (const draggingIndex of [0, 1, 3]) {
  test(`drag source ${draggingIndex} alone retains editing even when periods and kinds match`, () => {
    const input = fixture(); input.display.kinds.fill('last'); input.display.periods.fill(5);
    input.interaction.draggingIndex = draggingIndex;
    const result = projectCryptoCharts(input);
    assert.deepEqual(result.models.map(model => actionable(model).length), [0, 1, 2, 3].map(index => index === draggingIndex ? 3 : 0));
    assert.ok(result.models.every(model => model.lines.length === 6));
  });
}

for (const leg of ['stopLoss', 'takeProfit']) {
  test(`triggered ${leg} cannot drag, remains cancellable, and locks sibling protection only`, () => {
    const input = fixture(); input.session.protection.triggeredLeg = leg;
    const result = projectCryptoCharts(input), stop = line(result, 0, 'stopLoss'), profit = line(result, 1, 'takeProfit');
    assert.equal(stop.draggable, false); assert.equal(profit.draggable, false);
    assert.equal(stop.cancellable, leg === 'stopLoss'); assert.equal(profit.cancellable, leg === 'takeProfit');
    assert.equal(line(result, 0, 'order-7').draggable, true); assert.equal(line(result, 0, 'order-7').cancellable, true);
    assert.deepEqual(result.rewardRisk, { ratio: null, reason: '保护已触发', text: '—', preview: false });
  });
}

test('absent position prevents protection editing but does not lock pending limit orders', () => {
  const input = fixture(); input.session.account.position = null;
  const result = projectCryptoCharts(input);
  assert.deepEqual(actionable(result.models[0]).map(item => item.id), ['projection:order-7']);
  assert.equal(actionable(result.models[1]).length, 0); assert.equal(result.rewardRisk, null);
});

test('protective draft overlays every price kind and preserves the original line, reference and sibling', () => {
  const input = fixture(); input.interaction.priceDraft = { leg: 'stopLoss', price: '49500' };
  const result = projectCryptoCharts(input), ghost = line(result, 0, 'stopLoss:draft');
  assert.deepEqual(result.models.map(model => model.lines.filter(item => item.preview).length), [1, 1, 1, 1]);
  assert.equal(line(result, 0, 'stopLoss').price, '49000'); assert.equal(line(result, 1, 'takeProfit').price, '52000');
  assert.equal(ghost.price, '49500'); assert.equal(ghost.contracts, '2'); assert.equal(ghost.label, '待确认止损');
  assert.equal(ghost.estimate.pnl, -10); assert.equal(ghost.estimateText, '预计 -10.00 USDT · -10.00%');
  assert.equal(ghost.preview, true); assert.equal(ghost.dashed, true);
  assert.equal(ghost.draggable, false); assert.equal(ghost.cancellable, false); assert.equal(ghost.protectionLeg, null); assert.equal(ghost.orderId, null);
  assert.equal(result.draftEstimate, ghost.estimateText);
  assert.deepEqual(result.rewardRisk, { ratio: 4, reward: 40, risk: 10, reason: '', text: '4.00 : 1', preview: true });
});

test('order price and quantity draft retains original reserve display and never borrows protection estimates', () => {
  const input = fixture(); input.interaction.priceDraft = { kind: 'order', orderId: 7, price: '47900.1', remainingContracts: '1.25' };
  const result = projectCryptoCharts(input), ghost = line(result, 0, 'order-7:draft');
  assert.equal(line(result, 0, 'order-7').price, '48000'); assert.equal(line(result, 0, 'order-7').contracts, '3');
  assert.equal(ghost.price, '47900.1'); assert.equal(ghost.contracts, '1.25'); assert.equal(ghost.compactLabel, '待确认 · 1.25张');
  assert.equal(ghost.label, '待确认委托'); assert.equal(ghost.estimate, undefined); assert.equal(result.draftEstimate, '');
  assert.equal(ghost.draggable, false); assert.equal(ghost.cancellable, false); assert.equal(ghost.orderId, null);
  assert.equal(line(result, 1, 'order-7:draft'), undefined);
  assert.equal(result.rewardRisk.ratio, 2); assert.equal(result.rewardRisk.preview, false);
});

test('order id zero remains actionable and matched by the draft without truthiness shortcuts', () => {
  const input = fixture(); input.session.orders[0].id = 0;
  input.interaction.priceDraft = { kind: 'order', orderId: 0, price: '47900' };
  const result = projectCryptoCharts(input);
  assert.equal(line(result, 0, 'order-0:draft').price, '47900');
  input.interaction = {};
  assert.equal(line(projectCryptoCharts(input), 0, 'order-0').draggable, true);
});

test('missing draft target does not synthesize a line or change draft ownership', () => {
  const input = fixture(); input.interaction.priceDraft = { kind: 'order', orderId: 99, price: '47000' };
  const result = projectCryptoCharts(input);
  assert.ok(result.models.every(model => model.lines.every(item => !item.preview)));
  assert.ok(result.models.every(model => actionable(model).length === 0));
});

test('moving protection price wins the ratio while the confirmation estimate still uses its captured draft', () => {
  const input = fixture();
  input.interaction = { priceDraft: { leg: 'stopLoss', price: '49500' }, movingPrice: { leg: 'takeProfit', price: 51000 } };
  const result = projectCryptoCharts(input);
  assert.deepEqual(result.rewardRisk, { ratio: 1, reward: 20, risk: 20, reason: '', text: '1.00 : 1', preview: true });
  assert.equal(result.draftEstimate, '预计 -10.00 USDT · -10.00%');
  input.interaction.movingPrice = { orderId: 7, price: 47000 };
  assert.equal(projectCryptoCharts(input).rewardRisk.ratio, 4);
  input.interaction.priceDraft = null;
  assert.equal(projectCryptoCharts(input).rewardRisk.ratio, 2); assert.equal(projectCryptoCharts(input).rewardRisk.preview, false);
});

for (const [leg, price, reason] of [['stopLoss', 50000, '止损不在亏损区'], ['takeProfit', 49900, '止盈不在盈利区']]) {
  test(`${reason} retains the explanation and preview flag instead of inventing a ratio`, () => {
    const input = fixture(); input.interaction.movingPrice = { leg, price };
    assert.deepEqual(projectCryptoCharts(input).rewardRisk, { ratio: null, reason, text: '—', preview: true });
  });
}

test('missing protection legs leave the ratio absent even during a price preview', () => {
  const input = fixture(); delete input.session.protection.takeProfit;
  input.interaction.movingPrice = { leg: 'stopLoss', price: 49500 };
  assert.equal(projectCryptoCharts(input).rewardRisk, null);
});

test('projection reads frozen inputs, returns independent results and keeps no state between sessions', () => {
  const input = fixture(); input.interaction.priceDraft = { leg: 'stopLoss', price: '49500' };
  const before = structuredClone(input); freeze(input);
  const first = projectCryptoCharts(input), second = projectCryptoCharts(input);
  assert.deepEqual(first, second); assert.deepEqual(input, before);
  first.models[0].lines[0].label = 'local'; first.models[0].bars[0].close = '1';
  assert.notEqual(second.models[0].lines[0].label, 'local'); assert.equal(second.models[0].bars[0].close, '50000.4');
  const next = fixture(); next.session.id = 'next';
  assert.ok(projectCryptoCharts(next).models.every(model => model.lines.every(item => item.id.startsWith('next:'))));
  assert.deepEqual(input, before);
});
