import test from 'node:test';
import assert from 'node:assert/strict';
import { findReplayMinuteIndex, replayRange } from '../../src/utils/cryptoChartSync.js';
import { cryptoVisiblePeriods, normalizeCryptoPreferences } from '../../src/utils/cryptoWorkspacePreferences.js';
import { cryptoQuantityToContracts } from '../../src/utils/cryptoQuantity.js';
const hourly=[{startSequence:-60,endSequence:-1},{startSequence:0,endSequence:14}];
const five=[{startSequence:0,endSequence:4},{startSequence:5,endSequence:9},{startSequence:10,endSequence:14}];
test('cross-period cursor uses replay minutes and never clamps unavailable minutes onto a known candle',()=>{
 assert.equal(findReplayMinuteIndex(hourly,7),1);assert.equal(findReplayMinuteIndex(five,7),1);
 assert.equal(findReplayMinuteIndex(hourly,-30),0);assert.equal(findReplayMinuteIndex(five,-30),-1);
 assert.equal(findReplayMinuteIndex(hourly,15),-1);assert.equal(findReplayMinuteIndex(five,15),-1);
 assert.equal(findReplayMinuteIndex([],0),-1);assert.equal(findReplayMinuteIndex(hourly,NaN),-1);
});
test('range linking uses candle minute boundaries including only the known part of a forming candle',()=>{
 assert.deepEqual(replayRange(hourly,{from:0,to:2}),{fromMinute:-60,toMinute:14});
 assert.deepEqual(replayRange(five,{from:1,to:3}),{fromMinute:5,toMinute:14});
 assert.equal(replayRange([],{from:0,to:3}),null);
});
test('invalid saved preferences cannot request arbitrary periods or layouts, and duplicate periods load once',()=>{
 const p=normalizeCryptoPreferences({layout:'unknown',periods:[2,'60',15,240],kinds:['evil','mark'],collapsed:'yes'});
 assert.equal(p.layout,'dual');assert.deepEqual(p.periods,[60,60,15,240]);assert.deepEqual(cryptoVisiblePeriods(p),[60]);
 assert.equal(p.collapsed,false);assert.equal(p.kinds[0],'last');assert.equal(p.kinds[1],'mark');
});
test('coin and quote inputs round down to contract lot steps using decimal arithmetic',()=>{
 const contract={ctVal:'0.01',ctMult:'1',lotSz:'0.01'};
 assert.equal(cryptoQuantityToContracts('0.010099999999999999','base',contract,'50000'),'1');
 assert.equal(cryptoQuantityToContracts('1000','quote',contract,'50000'),'2');
 assert.equal(cryptoQuantityToContracts('1000','quote',contract,'50001'),'1.99');
 assert.equal(cryptoQuantityToContracts('1.3','contracts',contract,'50000'),'1.3');
 assert.equal(cryptoQuantityToContracts('-1','base',contract,'50000'),null);
 assert.equal(cryptoQuantityToContracts('1','quote',contract,'0'),null);
});
