import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { cryptoExposure, cryptoExposureConflict, selectCryptoPoolEntries, createOkxHistoryPoolSource } from './replay-crypto-pool.js';
import { createCryptoScenarioView, MINUTE_MS as M, DAY_MS as DAY } from './replay-crypto-scenario.js';
const H=8*60*M, START=Date.parse('2024-01-01T00:00:00+08:00');
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const window=(replay=START)=>({backgroundStartMs:replay-90*DAY,replayStartMs:replay,replayEndMs:replay+3*DAY,executionEndMs:replay+3*DAY+M});
const entry=(instrumentId='BTC-USDT-SWAP',replay=START)=>({id:`${instrumentId}-${replay}`,instrumentId,window:window(replay),exposure:cryptoExposure(instrumentId,window(replay))});
test('unseen selection excludes used/correlated replay, visible backgrounds and prefixes with exact half-open bounds',()=>{
 const target=entry(); const seen={...target.exposure,knownThroughMs:START};
 assert.equal(cryptoExposureConflict(target.exposure,[seen]),'used-or-related-replay-window');
 assert.equal(selectCryptoPoolEntries([target,entry('ETH-USDT-SWAP')],'ETH-USDT-SWAP',[seen]).length,0);
 const later={...cryptoExposure('ETH-USDT-SWAP',window(START+4*DAY)),knownThroughMs:START+4*DAY};
 assert.equal(cryptoExposureConflict(target.exposure,[later]),'already-visible-background-or-prefix');
 const old={...cryptoExposure('BTC-USDT-SWAP',window(START-3*DAY)),knownThroughMs:START};
 assert.equal(cryptoExposureConflict(target.exposure,[old]),null);
 assert.equal(cryptoExposureConflict(target.exposure,[{...old,knownThroughMs:START+M}]),'already-visible-background-or-prefix');
});
test('pool absence uses explicit legacy source; broken published pointer never silently falls back',t=>{
 const folder=mkdtempSync(join(tmpdir(),'crypto-p6-catalog-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));let loads=0;
 const source=createOkxHistoryPoolSource({poolRoot:folder,legacySource:{load(){loads++;return {legacy:true};}}});assert.deepEqual(source.load('BTC-USDT-SWAP'),{legacy:true});assert.equal(source.summary().mode,'unavailable');assert.equal(source.summary().admittedWindows,0);
 writeFileSync(join(folder,'current.json'),JSON.stringify({file:'missing/catalog.json',sha256:'a'.repeat(64)}));assert.throws(()=>source.load('BTC-USDT-SWAP'),e=>e.code==='REPLAY_SNAPSHOT_UNAVAILABLE');assert.equal(loads,1);
});
function fixture(t){
 const folder=mkdtempSync(join(tmpdir(),'crypto-p6-loader-')),data=join(folder,'v1');mkdirSync(data);t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const e=entry(),w=e.window,count=(w.executionEndMs-w.backgroundStartMs)/M;
 const put=(file,bytes)=>{writeFileSync(join(data,file),bytes);return{file,sha256:sha(bytes)};};
 const rows=Array.from({length:count},(_,i)=>({ts:w.backgroundStartMs+i*M,open:'50000',high:'50001',low:'49999',close:'50000',sourceConfirm:'1'}));
 const mark=put('mark.json.gz',gzipSync(JSON.stringify(rows)));const last=put('last.json.gz',gzipSync(JSON.stringify(rows.map(r=>({...r,volumeContracts:'1000',volumeBase:'10',volumeQuote:'500000'})))));
 const first=Math.floor(w.backgroundStartMs/H)*H-H,lastSlot=Math.ceil(w.executionEndMs/H)*H;
 const funding=[];for(let ts=first;ts<=lastSlot;ts+=H)funding.push({ts,settledRate:'.0001',sourceRate:'1E-4',method:null,formulaType:null});
 const f=put('funding.json.gz',gzipSync(JSON.stringify(funding)));
 e.files={last:[last],mark:[mark],funding:f};e.fundingAudit={cadenceMs:H,maxSourceOffsetMs:120000};
 const ruleSource=put('rules.json',readFileSync(new URL('../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json',import.meta.url)));
 const catalog={schemaVersion:'okx-history-pool-v1',poolVersion:'test-pool-v1',entries:[e],ruleSource,coverage:{targetDays:731,instruments:[]},excludedCounts:{}};
 function publish(){const bytes=Buffer.from(JSON.stringify(catalog));writeFileSync(join(data,'catalog.json'),bytes);writeFileSync(join(folder,'current.json'),JSON.stringify({file:'v1/catalog.json',sha256:sha(bytes)}));}
 publish();return{folder,data,e,catalog,publish};
}
test('real-format pool loads verified independent input, redacts candidate details and rejects exhausted/corrupt/missing data',t=>{
 const f=fixture(t),source=createOkxHistoryPoolSource({poolRoot:f.folder,chooseIndex:()=>0});
 const summary=source.summary();assert.equal(summary.mode,'history-pool');assert.equal(summary.instruments[0].unseenWindows,1);
 summary.coverage.targetDays=0;assert.equal(source.summary().coverage.targetDays,731);
 for(const privateKey of ['replayStartMs','training-rules','files','20240101'])assert.ok(!JSON.stringify(summary).includes(privateKey));
 const one=source.load('BTC-USDT-SWAP');assert.equal(one.scenario.last.length,133921);assert.equal(one.exposure.replayStartMs,START);
 one.scenario.last[0].close='50001';one.scenario.window.replayEndMs=0;one.scenario.fundingAudit.cadenceMs=1;one.exposure.replayEndMs=0;assert.equal(source.load('BTC-USDT-SWAP').scenario.last[0].close,'50000');
 const usage=[{...source.load('BTC-USDT-SWAP').exposure,knownThroughMs:START}];assert.throws(()=>source.load('BTC-USDT-SWAP',{usage}),e=>e.code==='REPLAY_POOL_EXHAUSTED');
 writeFileSync(join(f.data,'mark.json.gz'),'corrupt');assert.throws(()=>source.summary(),e=>e.code==='REPLAY_SNAPSHOT_CORRUPT');assert.throws(()=>source.load('BTC-USDT-SWAP'),e=>e.code==='REPLAY_SNAPSHOT_CORRUPT');
 rmSync(join(f.data,'mark.json.gz'));assert.throws(()=>source.summary(),e=>e.code==='REPLAY_SNAPSHOT_UNAVAILABLE');assert.throws(()=>source.load('BTC-USDT-SWAP'),e=>e.code==='REPLAY_SNAPSHOT_UNAVAILABLE');
 rmSync(join(f.folder,'current.json'));assert.throws(()=>source.summary(),e=>e.code==='REPLAY_SNAPSHOT_UNAVAILABLE');
 assert.throws(()=>createOkxHistoryPoolSource({poolRoot:f.folder,legacySource:{load(){throw new Error('must not fall back');}}}).load('BTC-USDT-SWAP'),e=>e.code==='REPLAY_SNAPSHOT_UNAVAILABLE');
});
test('a new pooled scene retains the existing prefix/funding no-future contract at every chart period',t=>{
 const f=fixture(t),source=createOkxHistoryPoolSource({poolRoot:f.folder,chooseIndex:()=>0}),s=source.load('BTC-USDT-SWAP').scenario;
 const altered=structuredClone(s),cutoff=START+5*M;
 for(const kind of ['last','mark'])for(const b of altered[kind])if(b.ts+M>cutoff)Object.assign(b,{open:'80000',high:'99999',low:'1',close:'88888'});
 for(const event of altered.funding)if(event.ts>cutoff)event.settledRate='-.999';
 const a=createCryptoScenarioView(s),b=createCryptoScenarioView(altered);
 for(const timeframeMinutes of [1,3,5,15,30,60,120,240,360,720,1440])assert.deepEqual(a.visibleAt({elapsedMinutes:5,timeframeMinutes}),b.visibleAt({elapsedMinutes:5,timeframeMinutes}));
});
test('catalog stream/window swaps and traversal are rejected instead of entering the admitted pool',t=>{
 const f=fixture(t);f.catalog.entries[0].exposure.instrumentId='ETH-USDT-SWAP';f.publish();
 assert.throws(()=>createOkxHistoryPoolSource({poolRoot:f.folder}).summary(),e=>e.code==='REPLAY_SNAPSHOT_CORRUPT');
 writeFileSync(join(f.folder,'current.json'),JSON.stringify({file:'../outside/catalog.json',sha256:'a'.repeat(64)}));
 assert.throws(()=>createOkxHistoryPoolSource({poolRoot:f.folder}).summary(),e=>e.code==='REPLAY_SNAPSHOT_CORRUPT');
});
