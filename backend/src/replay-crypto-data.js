// Approved asset identities. A fresh download is a new release, not a replacement for these bytes.
import { readFileSync, statSync, realpathSync, existsSync, mkdirSync, mkdtempSync, copyFileSync, renameSync, linkSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const DEFAULT_CRYPTO_DATA_ROOT = fileURLToPath(new URL('../../storage/', import.meta.url));
export const SAMPLE_VERSION = 'okx-20240101-v1';
export const POOL_VERSION = 'okx-2024-2025-v1';
export const SAMPLE_MANIFEST_SHA = '048fd665a006077050585ba34c8b498caab3672d21bd4311a270c412fe3e6f56';
export const POOL_CATALOG_SHA = 'df58e4fd6d8a69f8e7de824e3cbb03bc85bad83c8dd97de9cd9ffa7d47539ede';
export const RULE_SHA = '1a1f5a04615ab6e2229cb8abc5685ea20d13a47ef131027d571255824c0f78e6';
export const RULE_FILE = fileURLToPath(new URL('../../docs/research/okx-rule-snapshots/2026-10-19-training-rule-manifest.draft.json', import.meta.url));
const REPORT_SHA = '64dcd0919a09374441123f37dcaeae6aa8d2fcd44a40b2fc636e3fd28c1a754d';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, status) => { throw Object.assign(new Error(message), { code, status }); };
export function cryptoDataPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0')) fail('REPLAY_SNAPSHOT_CORRUPT', '行情资产路径无效', 500);
  const file = resolve(root, name);
  if (!file.startsWith(resolve(root) + sep)) fail('REPLAY_SNAPSHOT_CORRUPT', '行情资产路径越界', 500);
  // Existing links may not escape the configured asset root.
  try { if (!realpathSync(file).startsWith(realpathSync(root) + sep)) fail('REPLAY_SNAPSHOT_CORRUPT', '行情资产链接越界', 500); }
  catch (error) { if (error.status) throw error; /* read below reports missing assets */ }
  return file;
}
export function checkedCryptoBytes(root, ref) {
  if (!/^[a-f0-9]{64}$/.test(ref?.sha256 ?? '')) fail('REPLAY_SNAPSHOT_CORRUPT', '行情资产校验身份无效', 500);
  let bytes;
  try { bytes = readFileSync(cryptoDataPath(root, ref.file)); }
  catch (error) { if (error.status) throw error; fail('REPLAY_SNAPSHOT_UNAVAILABLE', '行情资产缺失或不可读取，请先准备并校验数据', 503); }
  if (sha(bytes) !== ref.sha256) fail('REPLAY_SNAPSHOT_CORRUPT', '行情资产校验失败，未替换冻结版本', 500);
  return bytes;
}
// Each request still checks metadata; byte hashes are reused only while the file identity is unchanged.
export function createCryptoAssetChecker() {
  const cache = new Map();
  return (root, ref) => {
    const file = cryptoDataPath(root, ref.file); let s;
    try { s = statSync(file, { bigint: true }); } catch { fail('REPLAY_SNAPSHOT_UNAVAILABLE', '行情资产缺失，请先准备并校验数据', 503); }
    const signature = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, ref.sha256].join(':');
    if (cache.get(file) !== signature) { checkedCryptoBytes(root, ref); cache.set(file, signature); }
  };
}
export function sampleAssetDescriptor(dataRoot = DEFAULT_CRYPTO_DATA_ROOT) {
  const root = resolve(dataRoot, 'crypto-samples', SAMPLE_VERSION);
  const manifest = JSON.parse(checkedCryptoBytes(root, { file: 'manifest.json', sha256: SAMPLE_MANIFEST_SHA }));
  return { root, manifest, refs: Object.values(manifest.instruments).flatMap(i => Object.values(i.files)) };
}
export function unavailableCryptoSummary() {
  return { mode: 'unavailable', ready: false, poolVersion: null, targetYears: [2024, 2025], admittedWindows: 0,
    instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'].map(instrumentId => ({ instrumentId, admittedWindows: 0, unseenWindows: 0 })),
    note: '本地行情尚未准备或校验失败。请按行情数据准备指南导入冻结小样或历史池；已有练习仍可从历史恢复。' };
}
function releasePlan(dataRoot, kind) {
  if (!['sample', 'pool'].includes(kind)) throw new Error('kind must be sample or pool');
  const directory = kind === 'sample' ? `crypto-samples/${SAMPLE_VERSION}` : `crypto-pool/${POOL_VERSION}`;
  const root = resolve(dataRoot, directory), refs = new Map();
  const add = ref => { const old = refs.get(ref.file); if (old && old.sha256 !== ref.sha256) throw new Error('Conflicting asset identity'); refs.set(ref.file, ref); return JSON.parse(checkedCryptoBytes(root, ref)); };
  let data, index;
  if (kind === 'sample') {
    data = add({ file: 'manifest.json', sha256: SAMPLE_MANIFEST_SHA });
    index = add(data.sourceIndex);
    for (const inst of Object.values(data.instruments)) for (const ref of Object.values(inst.files)) refs.set(ref.file, ref);
    checkedCryptoBytes(dirname(RULE_FILE), { file: RULE_FILE.split('/').at(-1), sha256: RULE_SHA });
  } else {
    data = add({ file: 'catalog.json', sha256: POOL_CATALOG_SHA });
    index = add({ file: 'raw/download-index.json', sha256: data.sourceIndexSHA256 });
    add({ file: 'admission-report.json', sha256: REPORT_SHA });
    refs.set(data.ruleSource.file, data.ruleSource);
    for (const e of data.entries) for (const list of Object.values(e.files)) for (const ref of Array.isArray(list) ? list : [list]) {
      if (refs.has(ref.file) && refs.get(ref.file).sha256 !== ref.sha256) throw new Error('Conflicting normalized identity');
      refs.set(ref.file, ref);
    }
    if (index.failures?.length) throw new Error('Source acquisition has failures');
  }
  for (const ref of index.entries) refs.set(`raw/${ref.file}`, { file: `raw/${ref.file}`, sha256: ref.sha256 });
  return { root, directory, refs: [...refs.values()], windows: kind === 'sample' ? Object.keys(data.instruments).length : data.entries.length };
}
export function verifyCryptoRelease({ dataRoot = DEFAULT_CRYPTO_DATA_ROOT, kind = 'sample', published = false } = {}) {
  if (kind === 'pool' && published) {
    let pointer;
    try { pointer = JSON.parse(readFileSync(resolve(dataRoot, 'crypto-pool/current.json'))); }
    catch { fail('REPLAY_SNAPSHOT_UNAVAILABLE', '已发布行情池指针缺失或无效', 503); }
    if (pointer.file !== `${POOL_VERSION}/catalog.json` || pointer.sha256 !== POOL_CATALOG_SHA) fail('REPLAY_SNAPSHOT_CORRUPT', '行情池指针不是受验收的冻结版本', 500);
  }
  const plan = releasePlan(dataRoot, kind); let bytes = 0;
  for (const ref of plan.refs) bytes += checkedCryptoBytes(plan.root, ref).length;
  return { kind, version: kind === 'sample' ? SAMPLE_VERSION : POOL_VERSION, verifiedFiles: plan.refs.length, bytes, admittedWindows: plan.windows };
}
export function prepareCryptoRelease({ from, dataRoot = DEFAULT_CRYPTO_DATA_ROOT, kind = 'sample' }) {
  if (!from) throw new Error('An explicit --from frozen data root is required');
  // All input identities are checked before writing anything into the destination.
  const verified = verifyCryptoRelease({ dataRoot: from, kind }), plan = releasePlan(from, kind);
  const destination = resolve(dataRoot, plan.directory), pointer = resolve(dataRoot, 'crypto-pool/current.json');
  const pointerBytes = Buffer.from(JSON.stringify({ file: `${POOL_VERSION}/catalog.json`, sha256: POOL_CATALOG_SHA }, null, 2) + '\n');
  if (kind === 'pool' && existsSync(pointer)) {
    const p = JSON.parse(readFileSync(pointer));
    if (p.file !== `${POOL_VERSION}/catalog.json` || p.sha256 !== POOL_CATALOG_SHA) throw new Error('Existing pool pointer conflicts; refusing to replace it');
  }
  if (existsSync(destination)) {
    verifyCryptoRelease({ dataRoot, kind }); // corrupt/conflicting versions are never overwritten
  } else {
    mkdirSync(dataRoot, { recursive: true });
    const stage = mkdtempSync(resolve(dataRoot, '.crypto-prepare-'));
    try {
      const stagedVersion = resolve(stage, plan.directory);
      for (const ref of plan.refs) {
        const to = resolve(stagedVersion, ref.file); mkdirSync(dirname(to), { recursive: true });
        copyFileSync(cryptoDataPath(plan.root, ref.file), to);
      }
      verifyCryptoRelease({ dataRoot: stage, kind });
      mkdirSync(dirname(destination), { recursive: true });
      // A concurrent publication is not overwritten.
      renameSync(stagedVersion, destination);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  if (kind === 'pool' && !existsSync(pointer)) {
    // Pointer is published only after the complete version has passed validation.
    const stage = mkdtempSync(resolve(dataRoot, '.crypto-pointer-'));
    try {
      const file = resolve(stage, 'current.json'); writeFileSync(file, pointerBytes);
      try { linkSync(file, pointer); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const p = JSON.parse(readFileSync(pointer));
        if (p.file !== `${POOL_VERSION}/catalog.json` || p.sha256 !== POOL_CATALOG_SHA) throw new Error('Concurrent pool publication conflicts');
      }
    }
    finally { rmSync(stage, { recursive: true, force: true }); }
  }
  return { ...verified, dataRoot: resolve(dataRoot), published: true };
}
