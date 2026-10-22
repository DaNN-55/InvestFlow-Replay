import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';

// Synthetic, deterministic minute data in a disposable database. Future prices
// jump sharply so using a final coarse candle instead of its prefix is visible.
export function cryptoTestDocument(instrumentId = 'BTC-USDT-SWAP') {
  const M = 60000, start = Date.parse('2024-01-01T00:00:00+08:00');
  const window = {backgroundStartMs:start-1440*M,replayStartMs:start,replayEndMs:start+180*M,executionEndMs:start+181*M};
  const bars = Array.from({length:1621},(_,i)=> {
    const minute=i-1440, price=minute>=60?9000000:50000+minute;
    return {ts:window.backgroundStartMs+i*M,open:String(price),high:String(price+2),low:String(price-2),close:String(price+1),sourceConfirm:'1'};
  });
  return {
    rules:JSON.parse(readFileSync(new URL('../../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json',import.meta.url))),
    dataVersion:'test-multichart-private',dataManifestSHA256:'b'.repeat(64),
    scenario:{instrumentId,window,last:bars.map((b,i)=>({...b,volumeContracts:String(100000+i),volumeBase:'1000',volumeQuote:'50000000'})),mark:structuredClone(bars),
      fundingAudit:{cadenceMs:60*M,maxSourceOffsetMs:2000},
      funding:Array.from({length:30},(_,i)=>({ts:start+(i-25)*60*M,settledRate:'.0001'}))},
  };
}

export async function startCryptoTestServer() {
  const root=mkdtempSync(join(tmpdir(),'investflow-crypto-charts-'));
  const app=createApp({dbPath:join(root,'replay.sqlite'),storageRoot:root,workspaceRoot:root,tradeRecordsRoot:join(root,'records'),
    cryptoSnapshotSource:{load:instrumentId=>cryptoTestDocument(instrumentId)}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,
    async close() {await new Promise(resolve=>server.close(resolve));app.dispose();rmSync(root,{recursive:true,force:true});},
  };
}
