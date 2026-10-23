import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyAmount } from '../../src/utils/cryptoReplayPresentation.js';

test('money display preserves sub-cent signs, exact zero, missing values and cent boundaries',()=>{
  for(const [value,expected] of [[null,'—'],[undefined,'—'],['','—'],['invalid','—'],['0.00000000','0.00'],['-0.00000000','0.00'],['0.00000001','<0.01'],['-0.00999999','-<0.01'],['0.01','0.01'],['-0.01','-0.01'],['1234.56789012','1,234.57']]) assert.equal(moneyAmount(value),expected);
});
