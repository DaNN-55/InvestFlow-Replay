import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import Decimal from 'decimal.js';
import { decodeCryptoSourceJob } from '../src/replay-crypto-source-job.js';
import { DAY_MS, MINUTE_MS, BEIJING_OFFSET_MS, normalizeOkxFunding, validateCryptoScenario, aggregateCryptoBars } from '../src/replay-crypto-scenario.js';
import { cryptoExposure } from '../src/replay-crypto-pool.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),folder=resolve(root,'storage/crypto-pool/okx-2024-2025-v1'),raw=resolve(folder,'raw');
const hash=(b)=>createHash('sha256').update(b).digest('hex'),json=(p)=>JSON.parse(readFileSync(p));
const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
check(execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim()==='codex/okx-crypto-training','Use authorized crypto branch');
const version='okx-2024-2025-v1',manifest=resolve(folder,'catalog.json'),reportFile=resolve(folder,'admission-report.json');
const command=process.argv[2]??'build';check(['build','verify'].includes(command),'Expected build or verify');
const insts=['BTC-USDT-SWAP','ETH-USDT-SWAP'],start=Date.parse('2023-10-03T00:00:00+08:00'),targetStart=Date.parse('2024-01-01T00:00:00+08:00'),end=Date.parse('2026-01-01T00:00:00+08:00');
const date=(ts)=>new Date(ts+BEIJING_OFFSET_MS).toISOString().slice(0,10);
function frozen(file,bytes) { mkdirSync(dirname(file),{recursive:true});if(existsSync(file))check(hash(readFileSync(file))===hash(bytes),`Frozen output differs: ${file}`);else{check(command==='build',`Frozen output missing: ${file}`);writeFileSync(file+'.partial',bytes);renameSync(file+'.partial',file);}return{file:relative(folder,file),sha256:hash(bytes),bytes:bytes.length}; }
function pack(file,rows){return{...frozen(resolve(folder,file),gzipSync(JSON.stringify(rows),{level:9})),rows:rows.length};}
const index=json(resolve(raw,'download-index.json'));check(index.failures.length===0,'Source acquisition has failures');
const lookup=new Map(index.entries.map((e)=>[e.file,e]));
const days=[],chunks={},failures=[],coarseChecks=[],monthFailures=new Set(),coarseDone=new Set();
for(let t=start;t<end+MINUTE_MS;t+=DAY_MS)days.push(t);
for(const inst of insts){chunks[inst]={last:new Map(),mark:new Map()};for(const kind of ['last','mark']){
 for(const ts of days){const key=`${inst}-${kind}-1m-${date(ts).replaceAll('-','')}.json.gz`,entry=lookup.get(key);try{
  check(entry,`Missing raw day ${key}`);const rows=decodeCryptoSourceJob(readFileSync(resolve(raw,key)),entry);
  check(rows.length===(Math.min(ts+DAY_MS,end+MINUTE_MS)-ts)/MINUTE_MS,`Day length ${key}`);
  const ref=pack(`normalized/${inst}/${kind}/${date(ts)}.json.gz`,rows);chunks[inst][kind].set(ts,{...ref,sourceFile:key,sourceSHA256:entry.sha256});
 }catch(error){failures.push({instrumentId:inst,kind,date:date(ts),reason:error.message,classification:entry?'source-integrity-or-data-rejected':'not-downloaded'});}}
 process.stderr.write(`${inst} ${kind}: ${chunks[inst][kind].size}/${days.length} day blocks normalized\n`);
}}
const fundingEntries=index.entries.filter((e)=>e.kind==='fundingArchive');
for(const e of fundingEntries){check(e.file===`funding-${e.date}.zip` && e.url===`https://static.okx.com/cdn/okex/traderecords/swaprates/daily/${e.date.replaceAll('-','')}/allswap-fundingrates-${e.date}.zip?v=1001`,'Funding source identity differs');check(hash(readFileSync(resolve(raw,e.file)))===e.sha256,`Funding raw hash ${e.file}`);}
const fundingRaw=JSON.parse(execFileSync('python3',['-c',`import csv,io,json,zipfile,sys
from pathlib import Path
p=Path(sys.argv[1]);idx=json.loads(p.read_text());out=[]
for e in idx['entries']:
 if e.get('kind')!='fundingArchive':continue
 with zipfile.ZipFile(p.parent/e['file']) as z:
  for name in z.namelist():
   if not name.endswith('.csv'):continue
   for r in csv.DictReader(io.StringIO(z.read(name).decode('utf-8-sig'))):
    if r.get('instrument_name') in idx['instruments']:out.append({**r,'sourceDate':e['date']})
print(json.dumps(out))`,resolve(raw,'download-index.json')],{maxBuffer:16*1024*1024}));
const fundings={},fundingFiles={},fundingAudit=[];
for(const inst of insts){fundings[inst]=[];
 for(const e of fundingEntries){const observed=fundingRaw.filter((r)=>r.instrument_name===inst&&r.sourceDate===e.date);let valid=true,reason=null;
  try{const rows=normalizeOkxFunding(observed,inst),cadence=8*60*MINUTE_MS,slots=new Set(rows.map((r)=>Math.round(r.ts/cadence)*cadence));
   check(rows.length===3 && slots.size===3 && rows.every((r)=>date(Math.round(r.ts/cadence)*cadence)===e.date && Math.abs(r.ts-Math.round(r.ts/cadence)*cadence)<=120000),'Historical 8h window audit not supported or missing/duplicate source event');fundings[inst].push(...rows);
  }catch(error){valid=false;reason=error.message;failures.push({instrumentId:inst,kind:'funding',date:e.date,classification:'funding-admission-rejected',reason});}
  fundingAudit.push({instrumentId:inst,date:e.date,sourceEvents:observed.length,sourceSHA256:e.sha256,valid,reason});
 }
 fundings[inst].sort((a,b)=>a.ts-b.ts);fundingFiles[inst]=pack(`normalized/${inst}/funding.json.gz`,fundings[inst]);
}
function read(ref){check(hash(readFileSync(resolve(folder,ref.file)))===ref.sha256,'Normalized block changed');return JSON.parse(gunzipSync(readFileSync(resolve(folder,ref.file))));}
for(const entry of index.entries.filter((e)=>e.bar==='1H'||e.bar==='1D')){
 const key=`${entry.instrumentId}:${entry.kind}:${date(entry.start).slice(0,7)}`;
 try{const minute=[];for(let ts=entry.start;ts<entry.endExclusive;ts+=DAY_MS){const ref=chunks[entry.instrumentId][entry.kind].get(ts);check(ref,'Missing day for coarse check');minute.push(...read(ref));}
  const tf=entry.intervalMs/MINUTE_MS,derived=aggregateCryptoBars(minute,tf),official=decodeCryptoSourceJob(readFileSync(resolve(raw,entry.file)),entry);
  check(derived.length===official.length,'Coarse coverage differs');const fields=['open','high','low','close',...(entry.kind==='last'?['volumeContracts','volumeBase','volumeQuote']:[])];
  for(let i=0;i<official.length;i++){check(derived[i].ts===official[i].ts&&derived[i].minuteCount===tf,'Coarse time/count differs');for(const f of fields)check(new Decimal(derived[i][f]).eq(official[i][f]),`Coarse mismatch ${f} at ${official[i].ts}`);}
  coarseDone.add(`${key}:${tf}`);
  coarseChecks.push({instrumentId:entry.instrumentId,kind:entry.kind,month:date(entry.start).slice(0,7),timeframeMinutes:tf,bars:official.length,exact:true,sourceSHA256:entry.sha256});
 }catch(error){monthFailures.add(key);failures.push({instrumentId:entry.instrumentId,kind:entry.kind,month:date(entry.start).slice(0,7),reason:error.message,classification:'official-crosscheck-rejected'});}
}
const entries=[],excluded=[];
for(let replay=targetStart;replay+3*DAY_MS<=end;replay+=7*DAY_MS){for(const inst of insts){const window={backgroundStartMs:replay-90*DAY_MS,replayStartMs:replay,replayEndMs:replay+3*DAY_MS,executionEndMs:replay+3*DAY_MS+MINUTE_MS};const files={last:[],mark:[],funding:fundingFiles[inst]};
 try{for(const kind of ['last','mark'])for(let ts=window.backgroundStartMs;ts<window.executionEndMs;ts+=DAY_MS){const ref=chunks[inst][kind].get(ts);check(ref,`Missing ${kind} day ${date(ts)}`);check(ts===end || (coarseDone.has(`${inst}:${kind}:${date(ts).slice(0,7)}:60`) && coarseDone.has(`${inst}:${kind}:${date(ts).slice(0,7)}:1440`)),`Missing official crosscheck ${kind}/${date(ts).slice(0,7)}`);check(!monthFailures.has(`${inst}:${kind}:${date(ts).slice(0,7)}`),`Rejected official crosscheck ${kind}/${date(ts).slice(0,7)}`);files[kind].push(ref);}
  const scenario={instrumentId:inst,window,fundingAudit:{cadenceMs:8*60*MINUTE_MS,maxSourceOffsetMs:120000,appliesOnlyToThisHistoricalWindow:true}};
  for(const kind of ['last','mark'])scenario[kind]=files[kind].flatMap(read).filter((bar)=>bar.ts>=window.backgroundStartMs&&bar.ts<window.executionEndMs);
  const cadence=scenario.fundingAudit.cadenceMs,firstSlot=Math.floor(window.backgroundStartMs/cadence)*cadence-cadence,lastSlot=Math.ceil(window.executionEndMs/cadence)*cadence;
  scenario.funding=fundings[inst].filter((e)=>{const slot=Math.round(e.ts/cadence)*cadence;return slot>=firstSlot&&slot<=lastSlot;});
  const validation=validateCryptoScenario(scenario);entries.push({id:`${inst.startsWith('BTC')?'btc':'eth'}-${date(replay).replaceAll('-','')}`,instrumentId:inst,window,exposure:cryptoExposure(inst,window),files,fundingAudit:scenario.fundingAudit,validation});
 }catch(error){excluded.push({instrumentId:inst,replayStart:date(replay),reason:error.message,code:error.code??'ADMISSION_REJECTED'});}}
 if(entries.length%20===0)process.stderr.write(`Scene admission ${date(replay)}: ${entries.length} ready / ${excluded.length} excluded\n`);
}
const coverage={targetDays:731,backgroundDays:90,instruments:insts.map((instrumentId)=>({instrumentId,background:{targetDays:90,lastDays:[...chunks[instrumentId].last.keys()].filter(t=>t<targetStart).length,markDays:[...chunks[instrumentId].mark.keys()].filter(t=>t<targetStart).length,fundingArchiveDays:fundingAudit.filter(e=>e.instrumentId===instrumentId&&e.valid&&e.date>=date(start)&&e.date<date(targetStart)).length},executionMinute:{last:chunks[instrumentId].last.has(end),mark:chunks[instrumentId].mark.has(end)},years:[2024,2025].map((year)=>{const a=Date.parse(`${year}-01-01T00:00:00+08:00`),b=Date.parse(`${year+1}-01-01T00:00:00+08:00`);const expected=(b-a)/DAY_MS;return{year,targetDays:expected,lastDays:[...chunks[instrumentId].last.keys()].filter((t)=>t>=a&&t<b).length,markDays:[...chunks[instrumentId].mark.keys()].filter((t)=>t>=a&&t<b).length,fundingArchiveDays:fundingAudit.filter((e)=>e.instrumentId===instrumentId&&e.date.startsWith(String(year))&&e.valid).length};})}))};
const batches=[];for(const year of [2024,2025])for(let quarter=1;quarter<=4;quarter++){const a=Date.parse(`${year}-${String((quarter-1)*3+1).padStart(2,'0')}-01T00:00:00+08:00`),b=quarter===4?Date.parse(`${year+1}-01-01T00:00:00+08:00`):Date.parse(`${year}-${String(quarter*3+1).padStart(2,'0')}-01T00:00:00+08:00`);batches.push({batch:`${year}Q${quarter}`,targetDays:(b-a)/DAY_MS,admittedWindows:entries.filter((e)=>e.window.replayStartMs>=a&&e.window.replayStartMs<b).length,excludedWindows:excluded.filter((e)=>Date.parse(e.replayStart+'T00:00:00+08:00')>=a&&Date.parse(e.replayStart+'T00:00:00+08:00')<b).length});}
const ruleBytes=readFileSync(resolve(root,'docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json'));check(hash(ruleBytes)==='1a1f5a04615ab6e2229cb8abc5685ea20d13a47ef131027d571255824c0f78e6','Frozen rules changed');
const ruleSource=frozen(resolve(folder,'training-rules.json'),ruleBytes);
const report={schemaVersion:'okx-pool-admission-report-v1',poolVersion:version,sourceIndexSHA256:hash(readFileSync(resolve(raw,'download-index.json'))),coverage,batches,rawFiles:index.entries.length,failures,excluded,coarseChecks,fundingAudit,readyWindows:entries.length,candidateWindows:entries.length+excluded.length};
const catalog={schemaVersion:'okx-history-pool-v1',poolVersion:version,sourceIndexSHA256:report.sourceIndexSHA256,coverage,batches,ruleSource,entries,excludedCounts:Object.fromEntries([...new Set(excluded.map((e)=>e.code))].map((code)=>[code,excluded.filter((e)=>e.code===code).length]))};
frozen(reportFile,Buffer.from(JSON.stringify(report,null,2)+'\n'));const bytes=Buffer.from(JSON.stringify(catalog,null,2)+'\n');frozen(manifest,bytes);
if(command==='build'){check(entries.length>0,'No admitted scenarios; do not publish');const pointer=resolve(folder,'..','current.json'),body=Buffer.from(JSON.stringify({file:relative(resolve(folder,'..'),manifest),sha256:hash(bytes)},null,2)+'\n');writeFileSync(pointer+'.partial',body);renameSync(pointer+'.partial',pointer);}
else {const pointer=json(resolve(folder,'..','current.json'));check(pointer.sha256===hash(bytes),'Published pointer differs');}
console.log(JSON.stringify({status:command==='build'?'published':'verified',poolVersion:version,readyWindows:entries.length,excludedWindows:excluded.length,dataFailures:failures.length,rawFiles:index.entries.length,catalogSHA256:hash(bytes),coverage}));
