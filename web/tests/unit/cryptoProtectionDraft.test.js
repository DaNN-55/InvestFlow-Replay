import test from 'node:test';
import assert from 'node:assert/strict';
import {snapProtectionPrice,createProtectionDraft,protectionDraftCurrent,protectionDraftCommand,protectionDraftTriggered} from '../../src/utils/cryptoProtectionDraft.js';

const session=()=>({id:'one',revision:4,status:'active',contract:{tickSz:'0.1'},currentPrices:{last:'50000',mark:'50010'},account:{position:{side:'long',contracts:'2',entryPrice:'50000'}},
  protection:{contracts:'2',triggeredLeg:null,stopLoss:{price:'49000',reference:'last'},takeProfit:{price:'51000',reference:'mark'}}});

test('drag prices snap to decimal exchange ticks without floating artifacts',()=>{
  assert.equal(snapProtectionPrice(49000.049999,'0.1'),'49000');
  assert.equal(snapProtectionPrice(49000.05,'0.1'),'49000.1');
  assert.equal(snapProtectionPrice(123.17,'0.25'),'123.25');
  assert.equal(snapProtectionPrice(3.1415926,'0.0001'),'3.1416');
  for(const v of [0,-1,NaN,Infinity]) assert.equal(snapProtectionPrice(v,'0.1'),null);
  assert.equal(snapProtectionPrice(1,'0'),null);
});

test('a draft never mutates active protection and confirms the captured revision preserving the sibling reference',()=>{
  const s=session(),before=structuredClone(s),draft=createProtectionDraft(s,'stopLoss',49200.123);
  assert.equal(draft.price,'49200.1');assert.deepEqual(s,before);
  assert.deepEqual(protectionDraftCommand(s,draft),{expectedRevision:4,command:{type:'set-protection',stopLoss:{price:'49200.1',reference:'last'},takeProfit:{price:'51000',reference:'mark'}}});
  assert.equal(createProtectionDraft(s,'stopLoss',49000),null);
  for(const change of [s=>s.revision++,s=>s.id='other',s=>s.protection.stopLoss=null,s=>s.protection.triggeredLeg='stopLoss',s=>s.account.position=null,s=>s.account.position.contracts='1',s=>s.status='completed',s=>s.ending=true]) {
    const changed=structuredClone(before);change(changed);
    assert.equal(protectionDraftCurrent(changed,draft),false);
    assert.equal(protectionDraftCommand(changed,draft),null);
  }
});

test('no draggable draft for an absent or triggered leg, and both sides flag an already reached trigger',()=>{
  const s=session();
  assert.equal(createProtectionDraft(s,'entry',49200),null);
  s.protection.triggeredLeg='stopLoss';assert.equal(createProtectionDraft(s,'stopLoss',49200),null);s.protection.triggeredLeg=null;
  assert.equal(protectionDraftTriggered(s,createProtectionDraft(s,'stopLoss',50100)),true);
  assert.equal(protectionDraftTriggered(s,createProtectionDraft(s,'takeProfit',49900)),true);
  s.account.position.side='short';
  assert.equal(protectionDraftTriggered(s,createProtectionDraft(s,'stopLoss',49900)),true);
  assert.equal(protectionDraftTriggered(s,createProtectionDraft(s,'takeProfit',50200)),true);
  assert.equal(protectionDraftTriggered(s,createProtectionDraft(s,'takeProfit',49800)),false);
});
