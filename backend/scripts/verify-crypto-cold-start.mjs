// Real frozen assets, independent roots, actual standalone HTTP configuration and browser UI.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SAMPLE_VERSION, POOL_VERSION } from '../src/replay-crypto-data.js';
const root = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.env.INVESTFLOW_CRYPTO_EVIDENCE_DIR ?? join(root, '.runtime/crypto-cold-start-evidence'));
const temp = mkdtempSync(join(tmpdir(), 'crypto-f5-cold-start-'));
const { chromium, expect } = createRequire(join(root, 'web/package.json'))('@playwright/test');
const delay = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
let backend, vite, browser, base, web, backendPort, webPort;
const cases = [], pageErrors = [], integrity = [];
async function port() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const n = s.address().port; await new Promise(done => s.close(done)); return n; }
async function stop(child) { if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(done => child.once('exit', done)); } }
async function ready(url, child, log) { for (let i = 0; i < 150; i++) { if (child.exitCode !== null) throw new Error(log()); try { if ((await fetch(url)).ok) return; } catch { /* owned startup */ } await delay(100); } throw new Error(log()); }
function processAt(args, cwd, env) { const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', chunk => { log = (log + chunk).slice(-5000); }); return { child, log: () => log }; }
async function start(dataRoot, storageRoot) {
 const p = processAt(['--no-warnings', 'src/standalone-server.js'], join(root, 'backend'), {
  INVESTFLOW_REPLAY_BACKEND_PORT: String(backendPort), INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT: dataRoot,
  INVESTFLOW_REPLAY_STORAGE_ROOT: storageRoot, INVESTFLOW_REPLAY_CRYPTO_SOURCE: '', INVESTFLOW_REPLAY_ENGINE_URL: 'http://127.0.0.1:1',
 }); backend = p.child; await ready(`${base}/api/quant/replay/sessions?market=crypto-perpetual`, backend, p.log);
}
function cli(command, dataRoot, kind = 'sample', from) {
 const args = ['--no-warnings', join(root, 'backend/scripts/crypto-data.mjs'), command, '--data-root', dataRoot, '--kind', kind];
 if (from) args.push('--from', from);
 return JSON.parse(execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function api(path, body, expected) {
 const response = await fetch(`${base}/api/quant/replay/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 const value = await response.json(); if (expected) assert.equal(response.status, expected, JSON.stringify(value)); else assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function change(s, route, extra = {}, suffix = route) { return (await api(`sessions/${s.id}/${route}`, { actionId: `${s.id}-${suffix}`, expectedRevision: s.revision, ...extra })).session; }
function fingerprints(storageRoot) {
 const db = new DatabaseSync(join(storageRoot, 'app/replay.sqlite'), { readOnly: true });
 try {
  return db.prepare('SELECT id, snapshot_json FROM replay_sessions WHERE market = ? ORDER BY id').all('crypto-perpetual').map(row => ({ id: row.id, snapshotSHA256: hash(row.snapshot_json) }));
 } finally { db.close(); }
}
async function screen(page, name) { await page.goto(web); await expect(page.locator('.crypto-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 }); await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true }); }
try {
 mkdirSync(evidence, { recursive: true }); backendPort = await port(); webPort = await port();
 base = `http://127.0.0.1:${backendPort}`; web = `http://127.0.0.1:${webPort}/decision/crypto-replay`;
 const v = processAt(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], join(root, 'web'), { INVESTFLOW_REPLAY_BACKEND_PORT: String(backendPort) }); vite = v.child; await ready(web, vite, v.log);
 browser = await chromium.launch({ headless: true });
 for (const kind of ['empty', 'sample', 'pool']) {
  const folder = join(temp, kind), dataRoot = join(folder, 'data'), storageRoot = join(folder, 'ledger'); mkdirSync(dataRoot, { recursive: true });
  const initial = cli('status', dataRoot); assert.equal(initial.admittedWindows, 0); assert.equal(initial.mode, 'unavailable');
  let prepared, checked;
  if (kind !== 'empty') {
   prepared = cli('prepare', dataRoot, kind, join(root, 'storage')); checked = cli('check', dataRoot, kind);
   assert.equal(checked.admittedWindows, kind === 'sample' ? 2 : 210);
   assert.deepEqual(cli('prepare', dataRoot, kind, join(root, 'storage')), prepared);
   assert.ok(!existsSync(join(dataRoot, 'app'))); assert.ok(!existsSync(join(dataRoot, 'trade-records')));
   assert.ok(!readdirSync(dataRoot).some(name => name.startsWith('.crypto-')));
  }
  await start(dataRoot, storageRoot);
  const summary = await api('crypto-pool'); assert.equal(summary.admittedWindows, kind === 'empty' ? 0 : kind === 'sample' ? 2 : 210);
  assert.ok(!/replayStartMs|backgroundStartMs|catalog\.json|normalized\//.test(JSON.stringify(summary)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
  await screen(page, `${kind}-setup`);
  if (kind === 'empty') {
   await expect(page.getByRole('button', { name: '开始合约盲测', exact: true })).toBeDisabled();
   await expect(page.getByRole('status')).toContainText('本地行情尚未准备');
   const error = await api('sessions', { actionId: 'empty-create', market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP' }, 503);
   assert.equal(error.error.code, 'REPLAY_SNAPSHOT_UNAVAILABLE'); assert.equal(error.error.details.actionOutcome, 'not-committed');
   assert.equal((await api('sessions?market=crypto-perpetual')).total, 0);
   cases.push({ kind, summary, noFalseReadiness: true, createRejectedBeforeWrite: true, browserDisabled: true });
  } else {
   await expect(page.getByRole('button', { name: '开始合约盲测', exact: true })).toBeEnabled();
   const sessions = [];
   for (const instrumentId of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) {
    let s = (await api('sessions', { actionId: `${kind}-${instrumentId}`, market: 'crypto-perpetual', instrumentId, startingCash: '10000', leverage: '5', slippageBps: 2 })).session;
    const future = await api(`sessions/${s.id}/market?elapsedMinutes=1`, undefined, 409); assert.equal(future.error.code, 'REPLAY_CURSOR_FORBIDDEN');
    const visible = await api(`sessions/${s.id}/market?timeframeMinutes=1440&limit=100`);
    assert.ok(visible.candles.last.every(b => b.knownThroughMinute <= 0));
    s = await change(s, 'actions', { command: { type: 'market-open', side: 'long', contracts: '1' } }, 'open');
    s = await change(s, 'advance', { minutes: 1 }); assert.ok(s.account.position);
    s = await change(s, 'finish');
    s = await change(s, 'reviews/blind', { review: { thesis: 'F5 冷启动验证', tradePlan: '验证冻结版本，保持首次结果' } });
    s = await change(s, 'reveal');
    sessions.push({ session: s, ledger: await api(`sessions/${s.id}/ledger`) });
   }
   const before = fingerprints(storageRoot);
   await stop(backend); backend = null; renameSync(dataRoot, dataRoot + '-offline'); await start(dataRoot, storageRoot);
   assert.equal((await api('crypto-pool')).admittedWindows, 0);
   const rejected = await api('sessions', { actionId: `${kind}-offline-new`, market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP' }, 503); assert.equal(rejected.error.code, 'REPLAY_SNAPSHOT_UNAVAILABLE');
   for (const { session: s, ledger } of sessions) {
    assert.deepEqual((await api(`sessions/${s.id}`)).session, s); assert.deepEqual(await api(`sessions/${s.id}/ledger`), ledger);
   }
   assert.deepEqual(fingerprints(storageRoot), before);
   await screen(page, `${kind}-offline-history`); await expect(page.getByRole('button', { name: '开始合约盲测', exact: true })).toBeDisabled();
   await page.getByLabel('恢复历史合约练习').selectOption(sessions[0].session.id);
   await expect(page.locator('.crypto-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
   await expect(page.getByRole('button', { name: '按原版本复练', exact: true })).toBeVisible();
   await page.screenshot({ path: join(evidence, `${kind}-offline-restored.png`), fullPage: true });
   for (const { session: first } of sessions) {
    const body = { actionId: `${first.id}-offline-child`, expectedRevision: first.revision };
    const child = (await api(`sessions/${first.id}/retrain`, body)).session;
    assert.equal(child.attemptInfo.kind, 'retrain');
    assert.deepEqual((await api(`sessions/${first.id}`)).session, first);
    assert.equal((await api(`sessions/${first.id}/retrain`, body)).session.id, child.id);
    const all = fingerprints(storageRoot); assert.equal(all.find(r => r.id === first.id).snapshotSHA256, all.find(r => r.id === child.id).snapshotSHA256);
   }
   cases.push({ kind, prepared, checked, summary, instruments: sessions.map(s => s.session.instrumentId), restoredFrozenSnapshots: before,
    offlineRestartRestoresExactly: true, frozenRetrainBothAssets: true, retrainIdempotent: true, originalLedgerUnchanged: true, browserSetupAndOfflineRecovery: true, futureCursorRejected: true });
   await stop(backend); backend = null; renameSync(dataRoot + '-offline', dataRoot);
   // Damage only this test-owned installation. Cached success cannot hide it, nor can prepare overwrite it.
   const version = kind === 'sample' ? join(dataRoot, 'crypto-samples', SAMPLE_VERSION) : join(dataRoot, 'crypto-pool', POOL_VERSION);
   const manifest = JSON.parse(readFileSync(join(version, kind === 'sample' ? 'manifest.json' : 'catalog.json')));
   const normalRef = kind === 'sample' ? manifest.instruments['BTC-USDT-SWAP'].files.last : manifest.entries[0].files.last[0];
   for (const file of [normalRef.file, 'raw/download-index.json']) {
    const target = join(version, file), bytes = readFileSync(target); writeFileSync(target, 'broken-F5-test-only');
    assert.throws(() => cli('check', dataRoot, kind));
    assert.throws(() => cli('prepare', dataRoot, kind, join(root, 'storage'))); assert.equal(readFileSync(target, 'utf8'), 'broken-F5-test-only');
    const unready = file === normalRef.file ? (() => { try { return cli('status', dataRoot).admittedWindows === 0; } catch { return true; } })() : null;
    if (unready !== null) assert.equal(unready, true);
    writeFileSync(target, bytes); integrity.push({ kind, damaged: file.startsWith('raw/') ? 'raw-index' : 'normalized', fullCheckRejected: true, conflictingInstallNotOverwritten: true, runtimeRejectedWhenRequired: unready });
   }
   const rawIndex = JSON.parse(readFileSync(join(version, 'raw/download-index.json'))), rawPath = join(version, 'raw', rawIndex.entries[0].file), raw = readFileSync(rawPath);
   writeFileSync(rawPath, 'broken-source-F5'); assert.throws(() => cli('prepare', join(temp, `${kind}-bad-destination`), kind, dataRoot));
   assert.ok(!existsSync(join(temp, `${kind}-bad-destination`))); writeFileSync(rawPath, raw);
   integrity.push({ kind, damaged: 'raw-source', sourceRejectedBeforeDestinationWrite: true });
   if (kind === 'pool') {
    const pointerPath = join(dataRoot, 'crypto-pool/current.json'), pointerBytes = readFileSync(pointerPath);
    writeFileSync(pointerPath, JSON.stringify({ file: 'unapproved/catalog.json', sha256: '0'.repeat(64) }));
    assert.throws(() => cli('prepare', dataRoot, kind, join(root, 'storage')));
    assert.equal(JSON.parse(readFileSync(pointerPath)).file, 'unapproved/catalog.json');
    integrity.push({ kind, damaged: 'conflicting-pointer', notOverwritten: true });
    writeFileSync(pointerPath, pointerBytes);
    rmSync(pointerPath); assert.throws(() => cli('status', dataRoot)); assert.throws(() => cli('check', dataRoot, 'pool'));
    integrity.push({ kind, damaged: 'published-pointer-missing', noSampleFallback: true });
   }
  }
  await context.close(); await stop(backend); backend = null;
 }
 assert.deepEqual(pageErrors, []);
 writeFileSync(join(evidence, 'cold-start-validation.json'), JSON.stringify({ status: 'verified-f5-cold-start', cases, integrity, runtimeErrors: pageErrors,
  productionLedgerTouched: false, frozenSourceAssetsModified: false, temporaryRootsRemovedOnExit: true,
  codeSHA256: Object.fromEntries(['backend/src/replay-crypto-data.js', 'backend/scripts/crypto-data.mjs', 'backend/scripts/verify-crypto-cold-start.mjs', 'backend/src/replay-crypto-session.js', 'backend/src/replay-crypto-pool.js', 'backend/src/standalone-server.js', 'web/src/components/crypto/CryptoSetupPanel.vue'].map(file => [file, hash(readFileSync(join(root, file)))])),
 }, null, 2) + '\n');
 console.log(JSON.stringify({ status: 'verified-f5-cold-start', cases: cases.length, integrityChecks: integrity.length, runtimeErrors: pageErrors.length }));
} finally {
 await browser?.close(); await stop(vite); await stop(backend); rmSync(temp, { recursive: true, force: true });
}
