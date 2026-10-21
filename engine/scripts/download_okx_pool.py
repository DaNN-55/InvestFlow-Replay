"""Resume public OKX 2024-2025 raw history acquisition; no account/ledger access."""
from __future__ import annotations
import argparse, concurrent.futures, gzip, hashlib, json, shutil, subprocess, threading, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
M=60000; DAY=1440*M; BJT=timezone(timedelta(hours=8))
INST=('BTC-USDT-SWAP','ETH-USDT-SWAP'); HEADERS={'User-Agent':'Mozilla/5.0','Accept':'application/json'}
GATES={key:[threading.Lock(),0.] for key in ['last','mark','funding']}
INTERVAL={'last':.115,'mark':.215,'funding':.06}
def sha(b): return hashlib.sha256(b).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat()
def atomic(path, data):
    part=path.with_name(path.name+'.partial');part.write_bytes(data);part.replace(path)
def fetch(url, kind):
    for attempt in range(6):
        lock,_=GATES[kind]
        with lock:
            wait=max(0,GATES[kind][1]+INTERVAL[kind]-time.monotonic())
            if wait:time.sleep(wait)
            GATES[kind][1]=time.monotonic()
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=30) as response:raw=response.read()
            if kind!='funding':
                obj=json.loads(raw)
                if obj.get('code')!='0':raise ValueError('OKX '+str(obj.get('code'))+': '+str(obj.get('msg')))
            return raw
        except Exception:
            if attempt==5:raise
            time.sleep(min(12,2**attempt))
def candles(job, rawdir, seed):
    path=rawdir/(job['key']+'.json.gz');meta=path.with_suffix('.source.json')
    if not path.exists():
        seeded=seed/path.name
        if seeded.exists():
            source=json.loads(gzip.decompress(seeded.read_bytes()))
            if all(source['job'].get(k)==job.get(k) for k in ['kind','instrumentId','bar','start','endExclusive']):shutil.copyfile(seeded,path)
    if path.exists():
        data=path.read_bytes()
        if meta.exists() and json.loads(meta.read_text()).get('sha256')!=sha(data):raise ValueError('Cached file hash changed '+str(path))
        obj=json.loads(gzip.decompress(data));stored=obj['job']
        if not all(stored.get(k)==job.get(k) for k in ['key','kind','instrumentId','bar','start','endExclusive']):raise ValueError('Cache identity mismatch '+str(path))
        for p in obj['pages']:
            if sha(p['responseText'].encode())!=p['responseSHA256']:raise ValueError('Cache response corrupt '+str(path))
        info={**stored,'file':path.name,'sha256':sha(data),'pages':len(obj['pages'])}
        if not meta.exists():atomic(meta,(json.dumps(info,indent=2)+'\n').encode())
        return info
    cursor=job['endExclusive'];pages=[]
    while cursor>job['start']:
        url='https://www.okx.com/api/v5/market/'+job['endpoint']+'?'+urlencode({'instId':job['instrumentId'],'bar':job['bar'],'after':cursor,'limit':job['limit']})
        raw=fetch(url,job['kind']);rows=json.loads(raw).get('data',[])
        if not rows:raise ValueError('Empty historical page '+url)
        stamps=[int(row[0]) for row in rows]
        if max(stamps)>=cursor or min(stamps)>=cursor:raise ValueError('Pagination did not move '+url)
        pages.append({'url':url,'fetchedAtUTC':now(),'responseText':raw.decode(),'responseSHA256':sha(raw)})
        cursor=min(stamps)
    data=gzip.compress(json.dumps({'job':job,'pages':pages},separators=(',',':')).encode(),mtime=0)
    atomic(path,data);info={**job,'file':path.name,'sha256':sha(data),'pages':len(pages)};atomic(meta,(json.dumps(info,indent=2)+'\n').encode());return info
def funding(day, rawdir, seed):
    date=day.strftime('%Y-%m-%d');path=rawdir/('funding-'+date+'.zip');meta=path.with_suffix('.source.json')
    if not path.exists() and (seed/path.name).exists() and (seed/meta.name).exists():shutil.copyfile(seed/path.name,path);shutil.copyfile(seed/meta.name,meta)
    if path.exists() and meta.exists():
        info=json.loads(meta.read_text())
        if sha(path.read_bytes())!=info['sha256']:raise ValueError('Funding cache corrupt '+date)
        return info
    url=f'https://static.okx.com/cdn/okex/traderecords/swaprates/daily/{day:%Y%m%d}/allswap-fundingrates-{date}.zip?v=1001'
    raw=fetch(url,'funding')
    if not raw.startswith(b'PK'):raise ValueError('Not a ZIP '+url)
    info={'kind':'fundingArchive','date':date,'url':url,'fetchedAtUTC':now(),'file':path.name,'sha256':sha(raw)}
    atomic(path,raw);atomic(meta,(json.dumps(info,indent=2)+'\n').encode());return info
def jobs_for(start,end):
    jobs=[];day=start
    while day<end:
        stop=min(day+timedelta(days=1),end)
        for inst in INST:
            for kind,endpoint in [('last','history-candles'),('mark','history-mark-price-candles')]:jobs.append({'key':f'{inst}-{kind}-1m-{day:%Y%m%d}','kind':kind,'instrumentId':inst,'bar':'1m','intervalMs':M,'start':int(day.timestamp()*1000),'endExclusive':int(stop.timestamp()*1000),'endpoint':endpoint,'limit':300})
        day=stop
    month=start
    coarse_end=end-timedelta(minutes=1)
    while month<coarse_end:
        next_month=(month.replace(day=28)+timedelta(days=4)).replace(day=1,hour=0,minute=0,second=0,microsecond=0);stop=min(next_month,coarse_end)
        for inst in INST:
            for kind,endpoint in [('last','history-candles'),('mark','history-mark-price-candles')]:
                for bar,interval in [('1H',60*M),('1D',DAY)]:jobs.append({'key':f'{inst}-{kind}-{bar}-{month:%Y%m%d}','kind':kind,'instrumentId':inst,'bar':bar,'intervalMs':interval,'start':int(month.timestamp()*1000),'endExclusive':int(stop.timestamp()*1000),'endpoint':endpoint,'limit':300})
        month=stop
    return jobs
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=Path('storage/crypto-pool/okx-2024-2025-v1/raw'));p.add_argument('--workers',type=int,default=12);args=p.parse_args()
    if subprocess.check_output(['git','branch','--show-current'],text=True).strip()!='codex/okx-crypto-training':raise SystemExit('Use authorized crypto branch')
    args.output.mkdir(parents=True,exist_ok=True);seed=Path('storage/crypto-samples/okx-20240101-v1/raw')
    start=datetime(2023,10,3,tzinfo=BJT);end=datetime(2026,1,1,0,1,tzinfo=BJT)
    jobs=jobs_for(start,end);days=[];day=start-timedelta(days=1)
    while day<=end+timedelta(days=1):days.append(day);day+=timedelta(days=1)
    success=[];failures=[];started=time.monotonic();total=len(jobs)+len(days)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        tasks={pool.submit(candles,j,args.output,seed):j for j in jobs};tasks.update({pool.submit(funding,d,args.output,seed):{'date':d.isoformat(),'kind':'fundingArchive'} for d in days})
        for future in concurrent.futures.as_completed(tasks):
            try:success.append(future.result())
            except Exception as e:failures.append({'job':tasks[future],'error':str(e),'classification':'download-or-source-error-needs-audit'})
            n=len(success)+len(failures)
            if n%20==0 or n==total:
                report={'downloadVersion':'okx-p6-download-v1','completed':len(success),'failed':len(failures),'total':total,'seconds':round(time.monotonic()-started),'latest':tasks[future],'failures':failures}
                atomic(args.output/'download-progress.json',(json.dumps(report,indent=2)+'\n').encode());print(json.dumps({k:report[k] for k in ['completed','failed','total','seconds']}),flush=True)
    index={'downloadVersion':'okx-p6-download-v1','exchange':'OKX','timezone':'Asia/Shanghai','fetchedAtUTC':now(),'backgroundStart':int(start.timestamp()*1000),'targetStart':int(datetime(2024,1,1,tzinfo=BJT).timestamp()*1000),'targetEnd':int((end-timedelta(minutes=1)).timestamp()*1000),'executionEndExclusive':int(end.timestamp()*1000),'instruments':list(INST),'entries':sorted(success,key=lambda x:x['file']),'failures':failures}
    target=args.output/('download-attempt.json' if failures else 'download-index.json');data=(json.dumps(index,indent=2)+'\n').encode()
    if target.name=='download-index.json' and target.exists():
        prior=json.loads(target.read_text())
        if prior['entries']!=index['entries']:raise ValueError('Frozen source index exists; create another version')
    else:atomic(target,data)
    print(json.dumps({'status':'incomplete' if failures else 'downloaded','index':str(target),'files':len(success),'failures':len(failures)}),flush=True)
    if failures:raise SystemExit(1)
if __name__=='__main__':main()
