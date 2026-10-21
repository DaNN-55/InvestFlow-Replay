import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createApp } from '../src/app.js';
import { createFrozenOkxSource } from '../src/replay-crypto-session.js';
const root = resolve(import.meta.dirname, '../..'), evidence = resolve(process.env.INVESTFLOW_CRYPTO_EVIDENCE_DIR ?? join(root, '.runtime/crypto-recovery-evidence'));
const { chromium, expect } = createRequire(join(root, 'web/package.json'))('@playwright/test');
const temp = mkdtempSync(join(tmpdir(), 'crypto-recovery-browser-')), results = [], pageErrors = [];
const source = createFrozenOkxSource(); let unavailable = false, sourceLoads = 0, app, server, vite, browser;
const frozenSource = { load(id) { sourceLoads++; if (unavailable) throw Object.assign(new Error('行情池文件缺失或不可读取，未填充或替换'), { status: 503, code: 'REPLAY_SNAPSHOT_UNAVAILABLE' }); return source.load(id); } };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function port() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const value = s.address().port; await new Promise(done => s.close(done)); return value; }
async function startBackend(at = 0) { app = createApp({ dbPath: join(temp, 'replay.sqlite'), cryptoSnapshotSource: frozenSource, engineUrl: 'http://127.0.0.1:1' }); server = app.listen(at, '127.0.0.1'); await new Promise(done => server.once('listening', done)); return server.address().port; }
async function stopBackend() { if (!server) return; await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); app.dispose(); server = null; }
try {
  mkdirSync(evidence, { recursive: true });
  const backendPort = await startBackend(), webPort = await port(), base = `http://127.0.0.1:${backendPort}`, web = `http://127.0.0.1:${webPort}/decision/crypto-replay`;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: join(root, 'web'), env: { ...process.env, INVESTFLOW_REPLAY_BACKEND_PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = ''; for (const stream of [vite.stdout, vite.stderr]) stream.on('data', chunk => { viteLog = (viteLog + chunk).slice(-4000); });
  let ready = false; for (let n = 0; n < 150; n++) { if (vite.exitCode !== null) throw new Error(viteLog); try { if ((await fetch(web)).ok) { ready = true; break; } } catch { /* owned local service startup */ } await delay(100); } assert.ok(ready, viteLog);
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => pageErrors.push(error.message));
  const key = 'investflow-crypto-attempt-v1';
  async function idle() { await expect(page.locator('.crypto-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 }); }
  async function click(name) { await page.getByRole('button', { name, exact: true }).click(); await idle(); }
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') { const response = await fetch(`${base}/api/quant/replay/sessions${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (response.status === 204) return null; const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; }
  const saved = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? '{}'), key);
  async function current() { return (await api(`/${(await saved()).sessionId}`)).session; }
  await page.goto(web); await idle(); await click('开始合约盲测'); const btc = await current();
  unavailable = true;
  await click('新开一局'); await click('开始合约盲测');
  await expect(page.getByRole('alert')).toContainText('行情池文件缺失'); assert.equal((await saved()).pending, null);
  await page.reload(); await idle(); await page.getByLabel('恢复历史合约练习').selectOption(btc.id); await idle(); assert.equal((await current()).id, btc.id);
  results.push({ name: 'F2 archived source-503 then reload and restore frozen session', passed: true });
  await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ sessionId: 'deleted-or-other-storage', pending: null })), key);
  await page.reload(); await idle(); await expect(page.getByRole('alert')).toHaveCount(0); assert.equal((await saved()).sessionId, null);
  await page.getByLabel('恢复历史合约练习').selectOption(btc.id); await idle(); assert.equal((await current()).id, btc.id);
  results.push({ name: 'F2 archived stale-404 loads history and clears stale reference', passed: true });
  unavailable = false;
  let lostCreate = false, committedEth;
  await page.route('**/api/quant/replay/sessions', async route => {
    if (!lostCreate && route.request().method() === 'POST') { lostCreate = true; const actual = await route.fetch(); committedEth = (await actual.json()).session; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '提交后响应不可用', details: null } }) }); }
    else await route.continue();
  });
  await click('新开一局'); await page.getByLabel('合约', { exact: true }).selectOption('ETH-USDT-SWAP'); await click('开始合约盲测');
  const createPending = (await saved()).pending; assert.ok(createPending); await page.unroute('**/api/quant/replay/sessions');
  await page.reload(); await idle(); await page.getByLabel('恢复历史合约练习').selectOption(btc.id); await idle();
  await expect(page.getByRole('button', { name: '提交委托', exact: true })).toBeDisabled();
  await page.getByLabel('K线周期').selectOption('60'); await idle(); assert.deepEqual((await saved()).pending, createPending);
  await click('重试原动作'); assert.equal((await current()).id, committedEth.id); assert.equal((await saved()).pending, null);
  assert.equal((await api('?market=crypto-perpetual')).total, 2);
  assert.equal((await api(`/${committedEth.id}/ledger`)).items.length, 1);
  results.push({ name: 'F2 committed-create generic 503 permits read-only history; exact retry creates and funds once', passed: true });
  await page.getByLabel('恢复历史合约练习').selectOption(btc.id); await idle(); await page.getByLabel('委托张数').fill('10'); await click('提交委托'); await click('推进 1 分钟');
  const beforeTopup = await current(); let lostTopup = false;
  await page.route('**/sessions/*/actions', async route => { if (!lostTopup && route.request().postDataJSON()?.command?.type === 'add-margin') { lostTopup = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await click('追加保证金'); const topupPending = (await saved()).pending; assert.equal(topupPending.id, btc.id);
  await page.reload(); await idle(); await page.getByLabel('恢复历史合约练习').selectOption(committedEth.id); await idle();
  await expect(page.getByRole('button', { name: '提交委托', exact: true })).toBeDisabled(); assert.deepEqual((await saved()).pending, topupPending);
  await page.unroute('**/sessions/*/actions'); await click('重试原动作'); const afterTopup = await current();
  assert.equal(afterTopup.id, btc.id); assert.equal(afterTopup.revision, beforeTopup.revision + 1);
  assert.equal(Number(afterTopup.account.availableBalance), Number(beforeTopup.account.availableBalance) - 500);
  assert.equal(Number(afterTopup.account.position.marginBalance), Number(beforeTopup.account.position.marginBalance) + 500);
  await page.screenshot({ path: join(evidence, 'recovered-after-lost-response.png') });
  results.push({ name: 'F2 lost committed topup response; switch to other session and retry original once', passed: true });
  async function finishReveal(s, prefix) {
    s = (await api(`/${s.id}/finish`, { actionId: `${prefix}-finish`, expectedRevision: s.revision })).session;
    assert.equal(s.status, 'completed');
    s = (await api(`/${s.id}/reviews/blind`, { actionId: `${prefix}-blind`, expectedRevision: s.revision, review: { thesis: `${prefix} 冻结首次判断`, tradePlan: '工程验证，保留原计划' } })).session;
    return (await api(`/${s.id}/reveal`, { actionId: `${prefix}-reveal`, expectedRevision: s.revision })).session;
  }
  const comparisons = [];
  for (const firstId of [btc.id, committedEth.id]) {
    const first = await finishReveal((await api(`/${firstId}`)).session, firstId);
    const child = await finishReveal((await api(`/${first.id}/retrain`, { actionId: `${firstId}-child`, expectedRevision: first.revision })).session, `${firstId}-child`);
    const active = (await api(`/${first.id}/retrain`, { actionId: `${firstId}-active`, expectedRevision: first.revision })).session;
    assert.equal(child.firstAttempt.id, first.id); await api(`/${first.id}`, undefined, 'DELETE');
    const deleted = await fetch(`${base}/api/quant/replay/sessions/${first.id}`); assert.equal(deleted.status, 404);
    assert.equal((await api(`/${active.id}`)).session.firstAttempt, undefined);
    comparisons.push({ first, child, expected: child.firstAttempt, ledger: (await api(`/${child.id}/ledger`)).items });
  }
  unavailable = true; const loadsBeforeRestart = sourceLoads; await stopBackend(); await startBackend(backendPort);
  for (const { first, child, expected, ledger } of comparisons) {
    const restored = (await api(`/${child.id}`)).session;
    assert.deepEqual(restored.firstAttempt, expected); assert.deepEqual(restored.summary, child.summary); assert.deepEqual((await api(`/${child.id}/ledger`)).items, ledger);
    assert.ok((await api('?market=crypto-perpetual')).items.every(item => item.id !== first.id));
    await page.evaluate(({ key, id }) => localStorage.setItem(key, JSON.stringify({ sessionId: id, pending: null })), { key, id: child.id });
    await page.reload(); await idle(); await expect(page.getByTestId('crypto-first-comparison')).toContainText(first.blindReview.thesis);
    await page.getByTestId('crypto-first-comparison').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `${first.instrumentId.startsWith('BTC') ? 'btc' : 'eth'}-deleted-first-comparison.png`) });
    results.push({ name: `F3 archived delete-first then restart/offline, frozen comparison visible: ${first.instrumentId}`, passed: true });
  }
  assert.equal(sourceLoads, loadsBeforeRestart); assert.deepEqual(pageErrors, []);
  const files = ['backend/src/db.js', 'backend/src/replay-crypto-persistence.js', 'backend/src/replay-crypto-session.js', 'backend/src/replay-crypto-session.test.js', 'web/src/utils/cryptoReplayController.js', 'web/src/views/CryptoReplayView.vue', 'web/tests/unit/cryptoReplay.test.js', 'backend/scripts/verify-crypto-recovery.mjs'];
  const output = { status: 'verified-f2-f3-real-http-and-browser', results, browserRuntimeErrors: pageErrors, fixture: 'unchanged frozen BTC/ETH sample', sourceLoadsAfterOfflineRestart: sourceLoads - loadsBeforeRestart, productionLedgerTouched: false, userTestingLedgerTouched: false, temporaryDatabaseRemovedOnExit: true, codeSHA256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])) };
  writeFileSync(join(evidence, 'recovery-browser-validation.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ status: output.status, flows: results.length, runtimeErrors: pageErrors.length, productionLedgerTouched: false }));
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) { vite.kill('SIGTERM'); await new Promise(done => vite.once('exit', done)); }
  await stopBackend(); rmSync(temp, { recursive: true, force: true });
}
