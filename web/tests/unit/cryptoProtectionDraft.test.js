import test from 'node:test';
import assert from 'node:assert/strict';
import {snapProtectionPrice,createProtectionDraft,protectionDraftCurrent,protectionDraftCommand,protectionDraftTriggered} from '../../src/utils/cryptoPriceDraft.js';

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

test('limit draft uses exact order identity and captured revision without changing size, fills or attachments',async()=>{
  const {createPriceDraft,priceDraftCurrent,priceDraftCommand,priceDraftReached}=await import('../../src/utils/cryptoPriceDraft.js');
  const s=session();s.account.position=null;s.protection=null;
  s.orders=[{id:2,type:'limit',intent:'increase',side:'long',limitPrice:'49000',remainingContracts:'1',filledContracts:'2',attachedProtection:{stopLoss:{price:'48000',reference:'mark'}}}];
  const before=structuredClone(s),draft=createPriceDraft(s,{orderId:2},49200.123);
  assert.deepEqual(s,before);assert.equal(draft.price,'49200.1');
  assert.deepEqual(priceDraftCommand(s,draft),{expectedRevision:4,command:{type:'amend-limit',orderId:2,limitPrice:'49200.1'}});
  for(const change of [s=>s.revision++,s=>s.id='other',s=>s.orders=[],s=>s.orders[0].remainingContracts='0.5',s=>s.orders[0].attachedProtection=null,s=>s.status='completed',s=>s.ending=true]) {
    const changed=structuredClone(before);change(changed);assert.equal(priceDraftCurrent(changed,draft),false);assert.equal(priceDraftCommand(changed,draft),null);
  }
  assert.equal(createPriceDraft(s,{orderId:2},49000),null);
  assert.equal(createPriceDraft(s,{orderId:3},49200),null);
  s.orders[0].type='market';assert.equal(createPriceDraft(s,{orderId:2},49200),null);
  for(const side of ['long','short']) for(const intent of ['increase','reduce']) {
    s.orders[0]={...before.orders[0],side,intent};const buy=(side==='long')!==(intent==='reduce');
    assert.equal(priceDraftReached(s,createPriceDraft(s,{orderId:2},buy?50100:49900)),true);
    assert.equal(priceDraftReached(s,createPriceDraft(s,{orderId:2},buy?49900:50100)),false);
  }
});

test('order cancellation captures remaining quantity and revision for limit and pending market orders',async()=>{
  const {createPriceCancellation,priceCancellationCurrent,priceCancellationCommand}=await import('../../src/utils/cryptoPriceDraft.js');
  const s=session();s.orders=[{id:2,type:'limit',limitPrice:'49000',contracts:'3',remainingContracts:'1',filledContracts:'2'},{id:3,type:'limit',limitPrice:'48000',remainingContracts:'1'}];
  const before=structuredClone(s),draft=createPriceCancellation(s,{orderId:2});assert.deepEqual(s,before);
  assert.deepEqual(priceCancellationCommand(s,draft),{expectedRevision:4,command:{type:'cancel-order',orderId:2}});
  for(const change of [s=>s.revision++,s=>s.id='other',s=>s.orders.shift(),s=>s.orders[0].remainingContracts='0.5',s=>s.ending=true]) {
    const changed=structuredClone(before);change(changed);assert.equal(priceCancellationCurrent(changed,draft),false);assert.equal(priceCancellationCommand(changed,draft),null);
  }
  assert.equal(createPriceCancellation(s,{orderId:9}),null);
  s.orders[0].type='market';delete s.orders[0].limitPrice;
  const market=createPriceCancellation(s,{orderId:2});
  assert.equal(market.order.remainingContracts,'1');
  assert.deepEqual(priceCancellationCommand(s,market),{expectedRevision:4,command:{type:'cancel-order',orderId:2}});
  const partial=structuredClone(s);partial.orders[0].remainingContracts='0.5';assert.equal(priceCancellationCommand(partial,market),null);
  s.orders[0].remainingContracts='0';assert.equal(createPriceCancellation(s,{orderId:2}),null);
});

test('chart cancellation targets a single actual protective leg, including an already-triggered remaining exit',async()=>{
  const {createPriceCancellation,priceCancellationCurrent,priceCancellationCommand}=await import('../../src/utils/cryptoPriceDraft.js');
  const s=session(),before=structuredClone(s);
  for(const leg of ['stopLoss','takeProfit']) {
    const draft=createPriceCancellation(s,{leg});assert.deepEqual(s,before);
    assert.deepEqual(priceCancellationCommand(s,draft),{expectedRevision:4,command:{type:'cancel-protection',leg}});
    for(const change of [s=>s.revision++,s=>s.account.position.contracts='1',s=>s.protection[leg]=null,s=>s.protection.triggeredLeg=leg,s=>s.status='completed']) {
      const changed=structuredClone(before);change(changed);assert.equal(priceCancellationCurrent(changed,draft),false);
    }
  }
  s.protection.triggeredLeg='stopLoss';s.protection.takeProfit=null;
  const triggered=createPriceCancellation(s,{leg:'stopLoss'});assert.ok(triggered);assert.equal(priceCancellationCurrent(s,triggered),true);
  assert.equal(createPriceCancellation(s,{leg:'takeProfit'}),null);
  assert.equal(createPriceCancellation(s,{leg:'manual'}),null);
  s.account.position=null;assert.equal(createPriceCancellation(s,{leg:'stopLoss'}),null);
});


test('remaining quantity draft requires exact lot steps and preserves captured fills and revision',async()=>{
  const {createQuantityDraft,createOrderDraft,orderDraftCommand}=await import('../../src/utils/cryptoPriceDraft.js');
  const s=session();s.contract.lotSz='0.01';s.contract.minSz='0.01';s.orders=[{id:2,type:'limit',limitPrice:'49000',contracts:'3',filledContracts:'2',remainingContracts:'1'}];
  const before=structuredClone(s);
  for(const value of ['0','-1','bad','1','0.001','1e2']) assert.equal(createQuantityDraft(s,{orderId:2},value),null);
  const draft=createQuantityDraft(s,{orderId:2},'02.500');assert.deepEqual(s,before);assert.equal(draft.remainingContracts,'2.5');assert.equal(draft.order.filledContracts,'2');
  const orderDraft=createOrderDraft(s,{orderId:2},'49000','02.500');
  assert.deepEqual(orderDraftCommand(s,orderDraft),{expectedRevision:4,command:{type:'amend-order',orderId:2,limitPrice:'49000',remainingContracts:'2.5'}});
  const changed=structuredClone(s);changed.orders[0].filledContracts='2.5';changed.orders[0].remainingContracts='0.5';assert.equal(orderDraftCommand(changed,orderDraft),null);
});


test('combined order draft permits either field or both to change and preserves the captured revision',async()=>{
  const {createOrderDraft,orderDraftCommand}=await import('../../src/utils/cryptoPriceDraft.js');
  const s=session();s.contract.lotSz='0.01';s.orders=[{id:2,type:'limit',limitPrice:'49000',remainingContracts:'1',filledContracts:'2'}];
  assert.equal(createOrderDraft(s,{orderId:2},'49000','1'),null);
  for(const [price,qty] of [['48000','1'],['49000','2'],['48000','2']]) {
    const draft=createOrderDraft(s,{orderId:2},price,qty);
    assert.deepEqual(orderDraftCommand(s,draft),{expectedRevision:4,command:{type:'amend-order',orderId:2,limitPrice:price,remainingContracts:qty}});
    const changed=structuredClone(s);changed.revision++;assert.equal(orderDraftCommand(changed,draft),null);
  }
});
