import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoPriceInputError } from '../../src/utils/cryptoPriceDraft.js';
import { errorText } from '../../src/utils/cryptoReplayPresentation.js';

test('price validation names the affected field and suggests a tick-aligned price without changing input', () => {
  assert.match(cryptoPriceInputError('65373.62', '0.1', '止损价'), /止损价 65373.62.*0.1 USDT.*65373.6/);
  assert.match(cryptoPriceInputError('64003.78', '0.1', '止盈价'), /止盈价 64003.78.*64003.8/);
  for (const price of ['65373.6', '65373.60', '.1']) assert.equal(cryptoPriceInputError(price, '0.1', '限价'), '');
  assert.match(cryptoPriceInputError('65373.6000000000000001', '0.1', '限价'), /不符合价格精度/);
  assert.equal(cryptoPriceInputError('0.000000000001', '0.000000000001', '限价'), '');
  for (const price of ['0', '-1', 'abc', '1e3']) assert.match(cryptoPriceInputError(price, '0.1', '限价'), /大于 0/);
});

test('server errors distinguish price precision from quantity units and preserve unrelated failures', () => {
  const contract = { tickSz: '0.1', lotSz: '0.01', minSz: '0.01' };
  assert.match(errorText(new Error('Fill price must match the contract tick'), contract), /价格.*0.1 USDT/);
  assert.match(errorText(new Error('Contracts violate minSz/lotSz'), contract), /数量.*0.01 张.*USDT 金额会先换算/);
  assert.equal(errorText(new Error('market read offline'), contract), 'market read offline');
});
