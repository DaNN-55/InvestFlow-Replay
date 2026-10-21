import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayBoardRules, inspectBoardBar, quantityError, resolveBoardQuantity } from './replay-board-rules.js';

const flat = (price, extra = {}) => ({ tradeDate: '2024-10-21', open: price, high: price, low: price, close: price, volume: 1000, preClose: 10, ...extra });
function inspect(tsCode, bar, extra = {}) {
  return inspectBoardBar({ tsCode, ...extra }, [flat(10, {tradeDate: '2024-10-18'}), bar], 2);
}

test('identifies only supported A-share boards and caps declarations by board/type', () => {
  for (const code of ['430001.BJ', '900901.SH', '200001.SZ', '510300.SH', '689009.SH', '000001.SH']) assert.equal(replayBoardRules({tsCode:code}), null);
  for (const [tsCode, maxLimitQuantity, maxMarketQuantity] of [['600000.SH',1000000,1000000],['300001.SZ',300000,150000],['688001.SH',100000,50000]]) {
    const rules = replayBoardRules({ tsCode });
    assert.equal(rules.maxLimitQuantity, maxLimitQuantity);
    assert.equal(rules.maxMarketQuantity, maxMarketQuantity);
    assert.equal(quantityError(rules,'buy',maxLimitQuantity,0,'limit'),'');
    assert.match(quantityError(rules,'buy',maxLimitQuantity+100,0,'limit'),/上限/);
    assert.match(quantityError(rules,'buy',maxMarketQuantity+100,0,'market'),/上限/);
  }
});

test('ordinary 6% one-price bars are not limits; main 10% and STAR/ChiNext 20% are directional limits', () => {
  assert.equal(inspect('600000.SH',flat(10.6)).status,'normal');
  assert.equal(inspect('300001.SZ',flat(11)).status,'normal');
  assert.equal(inspect('688001.SH',flat(11)).status,'normal');
  assert.equal(inspect('600000.SH',flat(11)).status,'limit_up');
  assert.equal(inspect('600000.SH',flat(9)).status,'limit_down');
  for (const code of ['300001.SZ','688001.SH']) {
    assert.equal(inspect(code,flat(12)).status,'limit_up');
    assert.equal(inspect(code,flat(8)).status,'limit_down');
  }
});

test('historical ChiNext transition uses trading date rather than present-day 20%', () => {
  assert.equal(inspect('300001.SZ',flat(11,{tradeDate:'2020-08-21'})).status,'limit_up');
  assert.equal(inspect('300001.SZ',flat(11,{tradeDate:'2020-08-24'})).status,'normal');
  assert.equal(inspect('300001.SZ',flat(12,{tradeDate:'2020-08-24'})).status,'limit_up');
});

test('rounds raw limits to cents before converting adjusted prices, including low-priced stocks', () => {
  const reference = 3.27;
  const price = 3.6 * 1.237;
  assert.equal(inspect('600000.SH',flat(price,{ rawPreClose:reference, rawClose:3.6, rawHigh:3.6, rawLow:3.6, adjustmentMultiplier:1.237 }),{priceAdjustment:{}}).status,'limit_up');
  assert.equal(inspect('600000.SH',flat(3.59,{rawPreClose:reference})).status,'normal');
  assert.equal(inspect('600000.SH',flat(.12,{rawPreClose:.11})).status,'limit_up');
});

test('hybrid uses daily reference throughout day; does not mistake a previous-minute 10% gain for a daily limit', () => {
  const snapshot={tsCode:'600000.SH',interval:'hybrid'};
  const bars=[flat(10,{tradeDate:'2024-10-18'}),flat(10.8),flat(11,{preClose:10.8})];
  assert.equal(inspectBoardBar(snapshot,bars,3).status,'limit_up');
  const bars2=[flat(10,{tradeDate:'2024-10-18'}),flat(9.5),flat(10.45,{preClose:9.5})];
  assert.equal(inspectBoardBar(snapshot,bars2,3).status,'normal');
  const bar=flat(22,{rawDailyPreClose:10,rawClose:11,rawHigh:11,rawLow:11,adjustmentMultiplier:2});
  assert.equal(inspect('600000.SH',bar,{interval:'hybrid',priceAdjustment:{}}).status,'limit_up');
});

test('ambiguous historical 5% and exceptional/out-of-band prices report unavailable; flags and explicit limits can resolve them', () => {
  assert.equal(inspect('600000.SH',flat(10.5)).status,'rule_unavailable');
  assert.equal(inspect('600000.SH',flat(10.5,{tradeDate:'2026-07-06'})).status,'normal');
  assert.equal(inspect('600000.SH',flat(10.5,{limitType:'U'})).status,'limit_up');
  assert.equal(inspect('600000.SH',flat(10.5,{rawUpperLimit:10.5,rawLowerLimit:9.5})).status,'limit_up');
  assert.equal(inspect('600000.SH',flat(12)).status,'rule_unavailable');
  assert.equal(inspect('600000.SH',flat(12,{noPriceLimit:true})).status,'normal');
  assert.equal(inspect('688001.SH',flat(10,{priceLimitStatus:'unknown'})).status,'rule_unavailable');
  assert.equal(inspect('688001.SH',flat(10),{priceAdjustment:{}}).status,'rule_unavailable');
});

test('STAR budget rounding is by share, includes fees, and still respects minimum declaration', () => {
  const rules=replayBoardRules({tsCode:'688001.SH'});
  const fee=()=>({totalFee:5});
  const order={quantityType:'cash_ratio',ratio:1};
  assert.equal(resolveBoardQuantity(order,{cash:2015},10,{},rules,fee),201);
  assert.equal(resolveBoardQuantity(order,{cash:2004},10,{},rules,fee),0);
  assert.match(quantityError(rules,'sell',199,299),/一次性/);
  assert.equal(quantityError(rules,'sell',199,199),'');
  assert.equal(quantityError(rules,'sell',199,400,'market',199),'');
  assert.equal(quantityError(replayBoardRules({tsCode:'600000.SH'}),'sell',99,400,'market',199),'');
});
