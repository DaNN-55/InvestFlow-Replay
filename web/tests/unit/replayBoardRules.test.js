import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReplayBarOrderModel, replayQuantityError } from '../../src/utils/replayOrderRules.js';
import { getReplayAutoplayStopReason } from '../../src/utils/replayAutoplay.js';

test('board ticket validates increments, minimum, maximum and odd-lot exit without rounding input', () => {
  const star={board:'star',minimumBuy:200,quantityStep:1,maxLimitQuantity:100000,maxMarketQuantity:50000};
  const main={board:'main',minimumBuy:100,quantityStep:100,maxLimitQuantity:1000000,maxMarketQuantity:1000000};
  const error=(rules,side,quantity,holding=0)=>replayQuantityError({rules,side,quantity,holding});
  assert.equal(error(star,'buy',201),'');
  assert.match(error(star,'buy',199),/200股/);
  assert.match(error(star,'buy',50001),/最多/);
  assert.equal(error(star,'sell',199,199),'');
  assert.match(error(star,'sell',198,199),/一次性/);
  assert.equal(error(main,'sell',99,299),'');
  assert.match(error(main,'sell',98,299),/零股/);
  assert.match(error(main,'buy',150),/100股/);
  assert.equal(replayQuantityError({rules:star,side:'sell',quantity:199,holding:400,available:199}),'');
});

test('new board model keeps advanced orders and pauses autoplay on unavailable historical rules', () => {
  assert.equal(isReplayBarOrderModel('bar-orders-v2'),true);
  assert.equal(isReplayBarOrderModel('bar-orders-v1'),true);
  assert.equal(isReplayBarOrderModel('legacy-next-open'),false);
  const session={id:'board',status:'active',executionModelVersion:'bar-orders-v2',pendingOrders:[{orderType:'stop'}],executions:[]};
  assert.equal(getReplayAutoplayStopReason(session),'');
  session.marketEvent={status:'rule_unavailable'};
  assert.match(getReplayAutoplayStopReason(session),/规则信息不足/);
});
