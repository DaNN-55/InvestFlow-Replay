import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoProtectionEstimate,formatProtectionEstimate,repriceProtectionLine } from '../../src/utils/cryptoProtectionEstimate.js';
import { cryptoChartLines } from '../../src/utils/cryptoReplayPresentation.js';
const session=side=>({id:'estimate',contract:{ctVal:'0.01',ctMult:'1'},config:{leverage:'10'},account:{position:{side,contracts:'2',entryPrice:'50000',entryNotional:'1000',marginBalance:'100'}},
  protection:{contracts:'2',stopLoss:{price:side==='long'?'49000':'51000',reference:'last'},takeProfit:{price:side==='long'?'52000':'48000',reference:'mark'}},orders:[]});

test('remaining long and short price PnL includes the contract face, with a leveraged opening-margin return',()=>{
  for(const side of ['long','short']) {
    const s=session(side),before=structuredClone(s);
    assert.deepEqual(cryptoProtectionEstimate(s,s.protection.stopLoss.price),{pnl:-20,returnPercent:-20,initialMargin:100});
    assert.deepEqual(cryptoProtectionEstimate(s,s.protection.takeProfit.price),{pnl:40,returnPercent:40,initialMargin:100});
    s.account.position.marginBalance='1000';s.currentPrices={last:'9000000',mark:'9000000'};
    assert.deepEqual(cryptoProtectionEstimate(s,s.protection.stopLoss.price),cryptoProtectionEstimate(before,before.protection.stopLoss.price));
    assert.equal(formatProtectionEstimate(cryptoProtectionEstimate(s,s.protection.stopLoss.price)),'预计 -20.00 USDT · -20.00%');
  }
});

test('partial exits halve remaining price PnL while retaining return, and exact cost wins over rounded weighted entry',()=>{
  const s=session('long');s.account.position.contracts='1';s.account.position.entryNotional='500';s.account.position.marginBalance='50';
  assert.deepEqual(cryptoProtectionEstimate(s,'49000'),{pnl:-10,returnPercent:-20,initialMargin:50});
  s.account.position={side:'long',contracts:'3',entryPrice:'33333.33',entryNotional:'1000.00000000',marginBalance:'100'};
  const estimate=cryptoProtectionEstimate(s,'33333.333333333336');assert.ok(Math.abs(estimate.pnl)<1e-10);
  assert.equal(formatProtectionEstimate(estimate),'预计 0.00 USDT · 0.00%');
  assert.equal(formatProtectionEstimate({pnl:-0.000001,returnPercent:-0.000001}),'预计 0.00 USDT · 0.00%');
});

test('only filled protective lines estimate returns, and previewing never mutates the original line or account',()=>{
  const s=session('long');s.orders=[{id:1,type:'limit',side:'long',limitPrice:'49500',remainingContracts:'1',attachedProtection:{stopLoss:{price:'48500',reference:'last'}}}];
  const before=structuredClone(s),lines=cryptoChartLines(s,'last'),line=lines.find(l=>l.protectionLeg==='stopLoss');
  assert.equal(line.estimateText,'预计 -20.00 USDT · -20.00%');
  const updated=repriceProtectionLine(line,'49500');assert.equal(updated.estimateText,'预计 -10.00 USDT · -10.00%');
  assert.equal(line.price,'49000');assert.equal(line.estimate.pnl,-20);assert.deepEqual(s,before);
  assert.ok(lines.filter(l=>!l.protectionLeg).every(l=>!l.estimate));
  assert.equal(cryptoChartLines(s,'mark').find(l=>l.protectionLeg==='takeProfit').estimate.pnl,40);
  s.account.position=null;s.protection=null;assert.ok(cryptoChartLines(s,'last').every(l=>!l.estimate));
});

test('missing or invalid position, price, margin basis and contract data never show invented percentages',()=>{
  for(const change of [s=>s.account.position=null,s=>s.account.position.side='other',s=>s.account.position.contracts='0',s=>s.account.position.entryNotional='0',s=>s.config.leverage='0',s=>s.contract.ctVal=undefined]) {
    const s=session('long');change(s);assert.equal(cryptoProtectionEstimate(s,'49000'),null);
  }
  for(const price of [0,-1,'',NaN,Infinity]) assert.equal(cryptoProtectionEstimate(session('long'),price),null);
  assert.equal(formatProtectionEstimate(null),'');
});

test('narrow chart estimate rows stay inside the pane and do not overlap neighbouring price labels',async()=>{
  const { REPLAY_PRICE_LINE_OVERLAY:overlay }=await import('../../src/utils/replayPriceLines.js');
  const line={id:'stop',price:'49000',label:'自动止损',color:'red',estimateText:'预计 -20.00 USDT · -20.00%',levels:[{id:'stop',price:49000,estimated:true},{id:'other',price:49001,estimated:true}]};
  const yAxis={convertToPixel:()=>195};
  const figures=overlay.createPointFigures({overlay:{extendData:line},coordinates:[{y:195}],bounding:{width:180,height:200},yAxis});
  const rows=figures.filter(f=>f.key?.startsWith('price-estimate-'));
  assert.equal(rows.length,2);assert.equal(rows[1].attrs.text,'收益率 -20.00%');
  assert.ok(rows.every(row=>row.attrs.y<200&&row.attrs.y>0));
});
