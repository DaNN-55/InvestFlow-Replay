import { createCryptoAssetChecker, unavailableCryptoSummary } from './replay-crypto-data.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomInt, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCryptoScenario, DAY_MS, MINUTE_MS } from './replay-crypto-scenario.js';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
export const CRYPTO_EXPOSURE_VERSION = 'okx-btc-eth-exposure-v1';
export function cryptoExposure(instrumentId, window) {
  const { backgroundStartMs, replayStartMs, replayEndMs, executionEndMs } = window ?? {};
  if (!['BTC-USDT-SWAP', 'ETH-USDT-SWAP'].includes(instrumentId) || ![backgroundStartMs,replayStartMs,replayEndMs,executionEndMs].every(Number.isSafeInteger)
    || !(backgroundStartMs < replayStartMs && replayStartMs < replayEndMs && executionEndMs === replayEndMs + MINUTE_MS)) fail('REPLAY_SNAPSHOT_CORRUPT','行情暴露窗口无效',500);
  return { version: CRYPTO_EXPOSURE_VERSION, group: 'OKX-BTC-ETH-USDT-SWAP', instrumentId, backgroundStartMs, replayStartMs, replayEndMs, executionEndMs };
}
export function cryptoExposureConflict(exposure, usage = []) {
  const overlaps = (start, end) => exposure.replayStartMs < end && exposure.replayEndMs > start;
  for (const seen of usage) {
    if (overlaps(seen.replayStartMs, seen.replayEndMs)) return 'used-or-related-replay-window';
    if (overlaps(seen.backgroundStartMs, seen.knownThroughMs)) return 'already-visible-background-or-prefix';
  }
  return null;
}
export function selectCryptoPoolEntries(entries, instrumentId, usage) {
  return entries.filter((entry) => entry.instrumentId === instrumentId && !cryptoExposureConflict(entry.exposure, usage));
}
function localFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) fail('REPLAY_SNAPSHOT_CORRUPT','行情池路径无效',500);
  const file = resolve(root,name);
  if (!file.startsWith(resolve(root)+sep)) fail('REPLAY_SNAPSHOT_CORRUPT','行情池路径越界',500);
  return file;
}
function verifiedBytes(root, entry) {
  let bytes;
  try { bytes = readFileSync(localFile(root,entry.file)); } catch(error) { if (error.status) throw error; fail('REPLAY_SNAPSHOT_UNAVAILABLE','行情池文件缺失或不可读取，未填充或替换',503); }
  if (hash(bytes) !== entry.sha256) fail('REPLAY_SNAPSHOT_CORRUPT','行情池文件校验失败',500);
  return bytes;
}
export function createOkxHistoryPoolSource({ legacySource, poolRoot = fileURLToPath(new URL('../../storage/crypto-pool/',import.meta.url)), chooseIndex = randomInt } = {}) {
  const root = resolve(poolRoot), dayCache = new Map(), check = createCryptoAssetChecker();
  let checkedCatalog = null;
  function catalog() {
    const pointer = localFile(root,'current.json');
    if (!existsSync(pointer)) {
      if (checkedCatalog || (existsSync(root) && readdirSync(root,{withFileTypes:true}).some((dir)=>dir.isDirectory() && existsSync(resolve(root,dir.name,'catalog.json'))))) fail('REPLAY_SNAPSHOT_UNAVAILABLE','已发布行情池的指针缺失，未退回旧样本',503);
      return null;
    }
    try {
      const ref = JSON.parse(readFileSync(pointer));
      const file = localFile(root,ref.file), bytes = readFileSync(file);
      if (hash(bytes) !== ref.sha256) fail('REPLAY_SNAPSHOT_CORRUPT','行情池目录校验失败',500);
      if (checkedCatalog?.file === file && checkedCatalog.sha256 === ref.sha256) return checkedCatalog;
      const data = JSON.parse(bytes);
      if (data.schemaVersion !== 'okx-history-pool-v1' || !Array.isArray(data.entries) || !data.coverage || !data.ruleSource || !/^[a-zA-Z0-9._-]{1,60}$/.test(data.poolVersion ?? '')) fail('REPLAY_SNAPSHOT_CORRUPT','不支持的行情池目录',500);
      const ids = new Set();
      for (const entry of data.entries) {
        const exposure = cryptoExposure(entry.instrumentId,entry.window);
        if (Object.keys(exposure).some((key)=>exposure[key]!==entry.exposure?.[key]) || Object.keys(entry.exposure ?? {}).length !== Object.keys(exposure).length || ids.has(entry.id)
          || entry.window.replayStartMs-entry.window.backgroundStartMs!==90*DAY_MS || entry.window.replayEndMs-entry.window.replayStartMs!==3*DAY_MS) fail('REPLAY_SNAPSHOT_CORRUPT','行情池场景约定无效',500);
        ids.add(entry.id);
      }
      checkedCatalog = { data, root: resolve(file,'..'), sha256: ref.sha256, file };
      return checkedCatalog;
    } catch(error) { if (error.status) throw error; fail('REPLAY_SNAPSHOT_UNAVAILABLE','行情池目录不可用，未退回旧样本冒充首次',503); }
  }
  function chunk(folder, entry) {
    const key=resolve(folder,entry.file)+':'+entry.sha256;
    const bytes=verifiedBytes(folder,entry);
    if (dayCache.has(key)) return dayCache.get(key);
    const rows=JSON.parse(gunzipSync(bytes));
    if (dayCache.size>=400) dayCache.clear(); dayCache.set(key,rows); return rows;
  }
  function readScenario(current, entry) {
    const window={...entry.window}, scenario={ instrumentId:entry.instrumentId,window,fundingAudit:{...entry.fundingAudit} };
    for (const kind of ['last','mark']) scenario[kind]=entry.files[kind].flatMap((ref)=>chunk(current.root,ref)).filter((bar)=>bar.ts>=window.backgroundStartMs && bar.ts<window.executionEndMs).map((bar)=>({...bar}));
    const cadence=entry.fundingAudit.cadenceMs;
    const firstSlot=Math.floor(window.backgroundStartMs/cadence)*cadence-cadence, lastSlot=Math.ceil(window.executionEndMs/cadence)*cadence;
    scenario.funding=chunk(current.root,entry.files.funding).filter((event)=>{ const slot=Math.round(event.ts/cadence)*cadence;return slot>=firstSlot && slot<=lastSlot; }).map((event)=>({...event}));
    validateCryptoScenario(scenario);return scenario;
  }
  return {
    load(instrumentId,{usage=[]}={}) {
      const current=catalog();
      if (!current) { if (!legacySource) fail('REPLAY_SNAPSHOT_UNAVAILABLE','行情池尚未发布',503); return legacySource.load(instrumentId); }
      const eligible=selectCryptoPoolEntries(current.data.entries,instrumentId,usage);
      if (!eligible.length) fail('REPLAY_POOL_EXHAUSTED','没有尚未暴露的可用场景；请从历史练习显式复练，不会重置首次成绩',409);
      const index=chooseIndex(eligible.length);
      if (!Number.isSafeInteger(index)||index<0||index>=eligible.length) fail('REPLAY_SNAPSHOT_CORRUPT','场景选择器无效',500);
      const selected=eligible[index], scenario=readScenario(current,selected);
      const rules=JSON.parse(verifiedBytes(current.root,current.data.ruleSource));
      return { rules,scenario,dataVersion:`${current.data.poolVersion}.${selected.id}`,dataManifestSHA256:current.sha256,
        exposure:{...selected.exposure},poolVersion:current.data.poolVersion };
    },
    summary(usage=[]) {
      const current=catalog();
      if (!current) return legacySource?.summary?.() ?? unavailableCryptoSummary();
      check(current.root, current.data.ruleSource);
      const refs = new Map();
      for (const entry of current.data.entries) for (const list of Object.values(entry.files)) for (const ref of Array.isArray(list) ? list : [list]) refs.set(ref.file, ref);
      for (const ref of refs.values()) check(current.root, ref);
      return { mode:'history-pool',ready:true,poolVersion:current.data.poolVersion,targetYears:[2024,2025],coverage:structuredClone(current.data.coverage),
        admittedWindows:current.data.entries.length,excludedWindows:{...current.data.excludedCounts},
        instruments:['BTC-USDT-SWAP','ETH-USDT-SWAP'].map((instrumentId)=>({instrumentId,admittedWindows:current.data.entries.filter((e)=>e.instrumentId===instrumentId).length,unseenWindows:selectCryptoPoolEntries(current.data.entries,instrumentId,usage).length})),
        note:'已见背景、前缀和 BTC/ETH 相关时段不计作新的首次；复练保留原结果。' };
    },
  };
}
