import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '../src/db.js';
import { createReplayLifecycleStore } from '../src/replay-lifecycle-store.js';
import { createCryptoReplayService, createFrozenOkxSource } from '../src/replay-crypto-session.js';
import { createOkxHistoryPoolSource, cryptoExposureConflict } from '../src/replay-crypto-pool.js';
import { createCryptoScenarioView, CRYPTO_TIMEFRAMES, MINUTE_MS, validateCryptoScenario } from '../src/replay-crypto-scenario.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),poolRoot=join(root,'storage/crypto-pool'),sha=(b)=>createHash('sha256').update(b).digest('hex');
assert.equal(execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),'codex/okx-crypto-training');
const json=(file)=>JSON.parse(readFileSync(file)),pointer=json(join(poolRoot,'current.json')),poolFolder=dirname(join(poolRoot,pointer.file)),catalog=json(join(poolRoot,pointer.file)),report=json(join(poolFolder,'admission-report.json'));
assert.equal(sha(readFileSync(join(poolRoot,pointer.file))),pointer.sha256);
const baseline=json(join(root,'docs/research/okx-sample-evidence/2026-10-20-p3b-orders-validation.json'));
const pureBaseline={};
for(const name of ['2026-10-20-p2-validation.json','2026-10-20-p3a-execution-validation.json','2026-10-20-p3b-orders-validation.json'])Object.assign(pureBaseline,json(join(root,'docs/research/okx-sample-evidence',name)).codeSHA256);
for(const [file,digest] of Object.entries(pureBaseline))assert.equal(sha(readFileSync(join(root,file))),digest,file);
assert.equal(sha(readFileSync(join(root,'storage/crypto-samples/okx-20240101-v1/manifest.json'))),baseline.dataManifestSHA256);
const seedFolder=join(root,'storage/crypto-samples/okx-20240101-v1'),seedManifest=json(join(seedFolder,'manifest.json'));
for(const item of Object.values(seedManifest.instruments))for(const ref of Object.values(item.files))assert.equal(sha(readFileSync(join(seedFolder,ref.file))),ref.sha256,ref.file);
const rawIndex=json(join(poolFolder,'raw/download-index.json'));assert.equal(sha(readFileSync(join(poolFolder,'raw/download-index.json'))),catalog.sourceIndexSHA256);
for(const entry of rawIndex.entries)assert.equal(sha(readFileSync(join(poolFolder,'raw',entry.file))),entry.sha256,entry.file);
const refs=new Map();for(const e of catalog.entries)for(const ref of [...e.files.last,...e.files.mark,e.files.funding])refs.set(ref.file,ref);
for(const ref of refs.values())assert.equal(sha(readFileSync(join(poolFolder,ref.file))),ref.sha256,ref.file);
assert.equal(report.candidateWindows,210);assert.equal(report.readyWindows,catalog.entries.length);assert.equal(report.batches.length,8);
assert.equal(report.readyWindows+report.excluded.length,210);
const observations=[],folder=mkdtempSync(join(tmpdir(),'crypto-p6-real-'));let database;
try {
  for(const instrumentId of ['BTC-USDT-SWAP','ETH-USDT-SWAP'])for(const year of [2024,2025]) {
    const candidates=catalog.entries.filter((e)=>e.instrumentId===instrumentId),index=candidates.findIndex((e)=>new Date(e.window.replayStartMs+8*60*MINUTE_MS).getUTCFullYear()===year);
    assert.ok(index>=0,`${instrumentId}/${year} has no admitted window`);
    const source=createOkxHistoryPoolSource({poolRoot,chooseIndex:()=>index}),input=source.load(instrumentId),validation=validateCryptoScenario(input.scenario),cutoff=input.scenario.window.replayStartMs+5*MINUTE_MS;
    // Poison every future candle and future final rate, including the unfinished minute.
    const altered=structuredClone(input.scenario);for(const kind of ['last','mark'])for(const b of altered[kind])if(b.ts+MINUTE_MS>cutoff)Object.assign(b,{open:'80000',high:'99999',low:'1',close:'88888',...(kind==='last'?{volumeContracts:'999999999',volumeBase:'99999999',volumeQuote:'99999999'}:{})});
    for(const event of altered.funding)if(event.ts>cutoff)event.settledRate='-.999';
    const original=createCryptoScenarioView(input.scenario),poisoned=createCryptoScenarioView(altered);
    for(const timeframeMinutes of CRYPTO_TIMEFRAMES)assert.deepEqual(original.visibleAt({elapsedMinutes:5,timeframeMinutes}),poisoned.visibleAt({elapsedMinutes:5,timeframeMinutes}));
    observations.push({instrumentId,year,dataVersion:input.dataVersion,validation,unchangedPrefixPeriods:CRYPTO_TIMEFRAMES.length});
    process.stderr.write(`${instrumentId}/${year}: actual scenario and 11 causal prefixes verified\n`);
  }
  // Switch only this isolated catalog. Real published files and real databases stay untouched.
  const testPool=join(folder,'pool'),v1=join(testPool,'v1');mkdirSync(v1,{recursive:true});symlinkSync(join(poolFolder,'normalized'),join(v1,'normalized'),'dir');
  writeFileSync(join(v1,'training-rules.json'),readFileSync(join(poolFolder,catalog.ruleSource.file)));
  const publish=(data)=>{const bytes=Buffer.from(JSON.stringify(data));writeFileSync(join(v1,'catalog.json'),bytes);writeFileSync(join(testPool,'current.json'),JSON.stringify({file:'v1/catalog.json',sha256:sha(bytes)}));};publish(catalog);
  const source=createOkxHistoryPoolSource({poolRoot:testPool,chooseIndex:()=>0});let loads=0;const tracked={load(...args){loads++;return source.load(...args);},summary:source.summary};
  const dbFile=join(folder,'replay.sqlite');database=createDatabase(dbFile);let service=createCryptoReplayService({store:createReplayLifecycleStore(database),snapshotSource:tracked});
  const create={market:'crypto-perpetual',instrumentId:'BTC-USDT-SWAP',actionId:'p6-real-first',leverage:'7',slippageBps:10};let s=service.create(create).session;
  const identity=database.getReplaySession(s.id).snapshot,sourceDescriptor=structuredClone(identity);
  assert.equal(s.attemptInfo.kind,'first');assert.equal(s.attemptInfo.countsTowardFirstScore,true);assert.deepEqual(service.create(create).session,s);
  assert.equal(loads,1);assert.throws(()=>service.market(s.id,{elapsedMinutes:1,limit:1}),e=>e.code==='REPLAY_CURSOR_FORBIDDEN');
  assert.doesNotMatch(JSON.stringify(service.market(s.id,{timeframeMinutes:1440,limit:2})),/replayStartMs|sourceUrl|2024-01-01|20240101|dataVersion/);
  const usage=database.getReplayCryptoExposureUsage(),summary=source.summary(usage);assert.ok(summary.instruments[0].unseenWindows<catalog.entries.filter(e=>e.instrumentId==='BTC-USDT-SWAP').length);
  assert.ok(cryptoExposureConflict(catalog.entries.find(e=>e.id==='eth-20240101').exposure,usage));
  // A stale selection is rejected inside the creation transaction (two writers are covered by unit tests).
  const fixed={load(inst){const value=createOkxHistoryPoolSource({poolRoot:testPool,chooseIndex:()=>0}).load(inst);return {...value,dataVersion:`source-revision.${value.dataVersion}`};}};
  const stale=createCryptoReplayService({store:createReplayLifecycleStore(database),snapshotSource:fixed});
  assert.throws(()=>stale.create({...create,instrumentId:'ETH-USDT-SWAP',actionId:'stale-cross-asset'}),e=>e.code==='REPLAY_EXPOSURE_CONFLICT');
  s=service.finish(s.id,{actionId:'finish',expectedRevision:s.revision}).session;
  s=service.saveBlindReview(s.id,{actionId:'blind',expectedRevision:s.revision,review:{thesis:'保留首次判断',tradePlan:'工程验证，不交易'}}).session;
  s=service.reveal(s.id,{actionId:'reveal',expectedRevision:s.revision}).session;const original=structuredClone(s);
  publish({...catalog,poolVersion:'test-upgrade-v2'});assert.equal(source.summary().poolVersion,'test-upgrade-v2');
  database.close();database=createDatabase(dbFile);service=createCryptoReplayService({store:createReplayLifecycleStore(database),snapshotSource:{load(){throw new Error('Current source unavailable');}}});
  assert.deepEqual(service.get(s.id).session,original);const childBody={actionId:'p6-retrain',expectedRevision:s.revision},child=service.retrain(s.id,childBody).session;
  assert.deepEqual(database.getReplaySession(child.id).snapshot,sourceDescriptor);assert.equal(child.attemptInfo.kind,'retrain');assert.equal(child.attemptInfo.countsTowardFirstScore,false);assert.equal(child.firstAttempt,undefined);assert.equal(child.elapsedMinutes,0);assert.deepEqual(child.config,original.config);assert.deepEqual(service.get(original.id).session,original);
  assert.deepEqual(service.retrain(original.id,childBody).session,child);assert.equal(loads,1);
  let reviewed=service.finish(child.id,{actionId:'child-finish',expectedRevision:child.revision}).session;reviewed=service.saveBlindReview(child.id,{actionId:'child-blind',expectedRevision:reviewed.revision,review:{thesis:'再次等待',tradePlan:'独立复练'}}).session;reviewed=service.reveal(child.id,{actionId:'child-reveal',expectedRevision:reviewed.revision}).session;assert.equal(reviewed.firstAttempt.id,original.id);assert.deepEqual(reviewed.firstAttempt.summary,original.summary);assert.deepEqual(service.get(original.id).session,original);assert.deepEqual(service.retrain(original.id,childBody).session,child);
  database.deleteReplaySession(original.id,'2026-10-21T12:00:00Z');assert.ok(database.getReplayCryptoExposureUsage().some(e=>e.deleted));
  // Legacy P4/P5 windows retain identity and also reserve correlated periods after P6 deployment.
  // Use a separate old database: a historical pre-P6 write must not be reclassified by a new pool.
  const oldDb=createDatabase(join(folder,'old.sqlite'));try{let old=createCryptoReplayService({store:createReplayLifecycleStore(oldDb),snapshotSource:createFrozenOkxSource()});const first=old.create({...create,actionId:'legacy'}).session,fp=oldDb.getReplaySession(first.id).scenarioFingerprint;old=createCryptoReplayService({store:createReplayLifecycleStore(oldDb),snapshotSource:tracked});assert.equal(oldDb.getReplaySession(first.id).scenarioFingerprint,fp);assert.deepEqual(old.get(first.id).session,first);assert.ok(cryptoExposureConflict(catalog.entries.find(e=>e.id==='eth-20240101').exposure,oldDb.getReplayCryptoExposureUsage()));}finally{oldDb.close();}
  const files=['backend/src/replay-crypto-pool.js','backend/src/replay-crypto-pool.test.js','backend/src/replay-crypto-session.js','backend/src/replay-crypto-session.test.js','backend/src/replay-crypto-persistence.js','backend/src/db.js','backend/src/replay-lifecycle-store.js','backend/src/app.js','backend/src/standalone-server.js','backend/scripts/verify-crypto-interface.mjs','web/src/services/api.js','backend/scripts/build-crypto-pool.mjs','backend/scripts/verify-crypto-pool.mjs','engine/scripts/download_okx_pool.py','engine/scripts/test_download_okx_pool.py','web/src/utils/cryptoReplayController.js','web/src/components/crypto/CryptoSetupPanel.vue','web/src/views/CryptoReplayView.vue','web/tests/unit/cryptoReplay.test.js'];
  const output={status:'verified-p6-actual-history-offline',poolVersion:catalog.poolVersion,catalogSHA256:pointer.sha256,sourceIndexSHA256:catalog.sourceIndexSHA256,rawFilesVerified:rawIndex.entries.length,normalizedFilesVerified:refs.size,pureBaselineFilesVerified:Object.keys(pureBaseline).length,originalSeedFilesVerified:6,coverage:catalog.coverage,batches:catalog.batches,readyWindows:report.readyWindows,excludedWindows:report.excluded,observations,checks:{allActualPrefixPeriods:observations.length*CRYPTO_TIMEFRAMES.length,futureCursorRejected:true,blindMetadataRedacted:true,poolUpgradeAndOfflineRestore:true,frozenRetrain:true,firstUnchanged:true,idempotentCreateAndRetrain:true,crossAssetAndSourceRevisionRaceRejected:true,deletedExposureRetained:true,legacyIdentityAndExposurePreserved:true},productionLedgerTouched:false,temporaryDatabaseRemovedOnExit:true,codeSHA256:Object.fromEntries(files.map(file=>[file,sha(readFileSync(join(root,file)))]))};
  const out=join(root,'docs/research/okx-sample-evidence/2026-10-21-p6-pool-validation.json');writeFileSync(out,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({status:output.status,rawFilesVerified:output.rawFilesVerified,normalizedFilesVerified:refs.size,actualScenes:observations.length,causalPrefixChecks:44}));
} finally {database?.close();rmSync(folder,{recursive:true,force:true});}
