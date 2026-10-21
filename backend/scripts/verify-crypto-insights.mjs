import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import Decimal from 'decimal.js';
import { createApp } from '../src/app.js';
import { createFrozenOkxSource } from '../src/replay-crypto-session.js';
const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
const root = resolve(import.meta.dirname, '../..'), evidence = resolve(process.env.INVESTFLOW_CRYPTO_EVIDENCE_DIR ?? join(root, '.runtime/crypto-insights-evidence'));
const { chromium, expect } = createRequire(join(root, 'web/package.json'))('@playwright/test');
const folder = mkdtempSync(join(tmpdir(), 'crypto-insights-browser-')), results = [], errors = [], completed = [];
const original = createFrozenOkxSource(); let sourceAllowed = true, app, server, vite, browser;
const source = { load(id) { assert.ok(sourceAllowed, 'Frozen recovery must not acquire new data'); return original.load(id); } };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function port() { const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done)); const value = s.address().port; await new Promise(done => s.close(done)); return value; }
async function backend(at = 0) { app = createApp({ dbPath: join(folder, 'replay.sqlite'), cryptoSnapshotSource: source, engineUrl: 'http://127.0.0.1:1' }); server = app.listen(at, '127.0.0.1'); await new Promise(done => server.once('listening', done)); return server.address().port; }
async function stopBackend() { if (server) { await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); app.dispose(); server = null; } }
try {
  mkdirSync(evidence, { recursive: true });
  const backendPort = await backend(), webPort = await port(), base = `http://127.0.0.1:${backendPort}`, url = `http://127.0.0.1:${webPort}/decision/crypto-replay`;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: join(root, 'web'), env: { ...process.env, INVESTFLOW_REPLAY_BACKEND_PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [vite.stdout, vite.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  let ready = false; for (let n = 0; n < 150; n++) { if (vite.exitCode !== null) throw new Error(logs); try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* temporary service startup */ } await delay(100); } assert.ok(ready, logs);
  browser = await chromium.launch({ headless: true });
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') { const response = await fetch(`${base}/api/quant/replay/sessions${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; }
  async function pageFor() {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__priceLinePaints = []; const original = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { if (/手动计划|自动止|限价/.test(String(text))) window.__priceLinePaints.push(String(text)); return original.call(this, text, ...args); }; });
    await page.goto(url); await idle(page); return page;
  }
  async function idle(page) { await expect(page.locator('.crypto-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 }); }
  async function click(page, label) { await page.getByRole('button', { name: label, exact: true }).click(); await idle(page); await expect(page.getByRole('alert')).toHaveCount(0); }
  async function state(page) { const id = await page.evaluate(() => JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')).sessionId); return (await api(`/${id}`)).session; }
  async function preview(page) { await expect(page.getByRole('button', { name: '提交委托', exact: true })).toBeEnabled({ timeout: 15000 }); const s = await state(page); const response = await page.getByTestId('crypto-order-preview').innerText(); assert.ok(response.includes('不扣款')); return s; }
  async function create(page, instrument, leverage = '5') { await page.getByLabel('合约', { exact: true }).selectOption(instrument); await page.getByLabel('杠杆倍数').fill(leverage); await click(page, '开始合约盲测'); await expect(page.getByLabel('委托张数')).toHaveValue(''); await expect(page.getByRole('button', { name: '提交委托', exact: true })).toBeDisabled(); return state(page); }
  async function reveal(page) { await click(page, '结束并退出'); let s = await state(page); while (s.status === 'active') { await click(page, '推进 1 分钟'); s = await state(page); } assert.equal(s.status, 'completed'); await page.getByLabel('盲评判断').fill('冻结小样验证，保留入场依据'); await page.getByLabel('盲评交易计划').fill('核对计划、金额与执行偏差'); await click(page, '保存首次盲评'); await click(page, '揭晓完整行情'); await expect(page.getByTestId('crypto-plan-comparison')).toBeVisible(); return state(page); }
  for (const instrument of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) for (const side of ['long', 'short']) {
    const page = await pageFor(); let s = await create(page, instrument); const initial = structuredClone(s), price = new D(s.currentPrices.last), tick = s.contract.tickSz, face = new D(s.contract.ctVal).times(s.contract.ctMult);
    const quantize = value => new D(value).toNearest(tick).toFixed();
    await page.getByLabel('合约操作').selectOption(side); await page.getByLabel('委托张数').fill('10'); await preview(page);
    const q = (await api(`/${s.id}/preview`, { expectedRevision: s.revision, intent: side, orderType: 'market', sizingMode: 'contracts', amount: '10' })).preview;
    const fill = price.times(side === 'long' ? '1.0002' : '.9998').toNearest(tick, side === 'long' ? D.ROUND_CEIL : D.ROUND_FLOOR), notional = fill.times(face).times(10);
    assert.equal(q.fee, notional.times('.0005').toFixed(8)); assert.equal(q.initialMargin, notional.div(5).toFixed(8));
    assert.equal(q.estimatedPlanLoss, null); assert.deepEqual(await state(page), initial);
    if (side === 'long') await page.getByTestId('crypto-order-preview').screenshot({ path: join(evidence, `${instrument.startsWith('BTC') ? 'btc' : 'eth'}-pretrade.png`) });
    await page.getByLabel('仓位输入方式').selectOption('margin'); await page.getByLabel('保证金预算').fill(q.initialMargin); await preview(page); await expect(page.getByTestId('crypto-preview-quantity')).toContainText('10 张');
    await page.getByLabel('仓位输入方式').selectOption('risk'); await page.getByLabel('风险预算').fill('10'); await expect(page.getByTestId('crypto-order-preview')).toContainText('先保存手动退出计划');
    const exit = quantize(price.times(side === 'long' ? '.998' : '1.002'));
    await page.getByLabel('计划方式').selectOption('manual'); await page.getByLabel('手动退出价').fill(exit); await page.getByLabel('计划原因').fill('先保存明确退出参考，再按预算估仓'); await click(page, '保存退出计划'); await preview(page);
    assert.ok(new D(await page.getByTestId('crypto-preview-loss').innerText()).lte(10));
    await page.getByLabel('仓位输入方式').selectOption('contracts'); await page.getByLabel('委托张数').fill('10'); await preview(page); await click(page, '提交委托'); await click(page, '推进 1 分钟'); s = await state(page); assert.equal(s.account.position.contracts, '10');
    await expect(page.getByTestId('crypto-base-quantity')).not.toContainText('—'); await expect(page.getByTestId('crypto-notional')).not.toContainText('—'); await expect(page.getByTestId('crypto-liquidation-distance')).not.toContainText('未定义');
    const future = await page.request.get(`${base}/api/quant/replay/sessions/${s.id}/market?elapsedMinutes=${s.elapsedMinutes + 1}`); assert.equal(future.status(), 409);
    await page.getByLabel('K线周期').selectOption('1440'); await idle(page); await expect(page.locator('.replay-price-lines')).toContainText('手动计划（不执行）');
    await expect.poll(() => page.evaluate(() => window.__priceLinePaints.some(text => text.includes('手动计划（不执行）')))).toBe(true);
    const stop = quantize(price.times(side === 'long' ? '.9' : '1.1')), take = quantize(price.times(side === 'long' ? '1.1' : '.9'));
    await page.getByLabel('自动止损价').fill(stop); await page.getByLabel('自动止盈价').fill(take); await page.getByLabel('保护触发参考').selectOption('mark'); await click(page, '更新持仓保护');
    await page.getByLabel('委托类型').selectOption('limit'); await page.getByLabel('委托限价').fill(quantize(price.times(side === 'long' ? '.99' : '1.01'))); await preview(page); await click(page, '提交委托');
    await expect(page.locator('.replay-price-lines')).toContainText('限价'); await expect(page.locator('.replay-price-lines')).not.toContainText('自动止损');
    await page.getByLabel('图表价格').selectOption('mark'); await expect(page.locator('.replay-price-lines')).toContainText('自动止损'); await expect(page.locator('.replay-price-lines')).not.toContainText('手动计划');
    const protective = (await state(page)).protection; await page.reload(); await idle(page); assert.deepEqual((await state(page)).protection, protective);
    await page.getByLabel('图表价格').selectOption('last'); await expect(page.locator('.replay-price-lines')).toContainText('限价'); await click(page, '撤单'); await expect(page.locator('.replay-price-lines')).not.toContainText('限价');
    await page.getByLabel('图表价格').selectOption('mark'); await click(page, '仅取消止损'); await expect(page.locator('.replay-price-lines')).not.toContainText('自动止损'); await expect(page.locator('[data-risk-mode="manual"]')).toBeVisible();
    await page.getByLabel('自动止损价').fill(stop); await page.getByLabel('自动止盈价').fill(take); await page.getByLabel('保护触发参考').selectOption('mark'); await click(page, '更新持仓保护'); await expect(page.locator('[data-risk-mode="automatic"]')).toBeVisible();
    await page.getByLabel('委托类型').selectOption('market'); await page.getByLabel('合约操作').selectOption('reduce'); await page.getByLabel('委托张数').fill('4'); await preview(page); await click(page, '提交委托'); await click(page, '推进 1 分钟');
    assert.equal((await state(page)).account.position.contracts, '6'); await expect(page.locator('.replay-price-lines')).toContainText('6张');
    if (side === 'long') await page.locator('.crypto-chart').screenshot({ path: join(evidence, `${instrument.startsWith('BTC') ? 'btc' : 'eth'}-chart-lines.png`) });
    const before = await state(page); await click(page, '追加保证金'); const topup = await state(page); assert.equal(topup.account.position.contracts, before.account.position.contracts); assert.equal(new D(topup.summary.accountEquity).minus(before.summary.accountEquity).toFixed(8), '0.00000000');
    if (side === 'short') await page.getByLabel('自动止损价').fill('');
    await page.getByLabel('合约操作').selectOption(side); await page.getByLabel('委托张数').fill('2'); await preview(page); await click(page, '提交委托'); await click(page, '推进 1 分钟'); assert.equal((await state(page)).account.position.contracts, '8');
    if (side === 'short') { assert.equal((await state(page)).protection.stopLoss, null); await expect(page.locator('[data-risk-mode="manual"]')).toBeVisible(); }
    while ((await state(page)).elapsedMinutes < 482) await click(page, '推进 15 分钟');
    assert.notEqual((await state(page)).totals.fundingPayments, '0.00000000');
    const finished = await reveal(page), data = await api(`/${finished.id}/analysis`); assert.equal(data.analysis.finalEquity, finished.summary.accountEquity); assert.equal(data.analysis.slippageAttribution, finished.totals.slippageAttribution); assert.equal(data.analysis.trades[0].exitKind, 'training-end');
    if (side === 'short') {
      const traces = (await api(`/${finished.id}/traces?limit=200`)).items.filter(event => event.quote && event.intent === 'increase');
      const entryCost = traces.reduce((sum, event) => sum.plus(event.quote.notional), new D(0));
      assert.equal(data.analysis.trades[0].plannedPricePnl, entryCost.minus(new D(exit).times(face).times(12)).toFixed(8));
    }
    assert.equal(data.analysis.trades[0].actualPricePnl, finished.totals.realizedPricePnl); assert.notEqual(data.analysis.trades[0].plannedPricePnl, null); assert.ok(new D(data.analysis.maxDrawdownPercent).gt(0));
    await expect(page.getByTestId('crypto-max-drawdown')).not.toContainText('揭晓'); await expect(page.locator('.order-preview .preview-error')).toHaveCount(0);
    completed.push({ id: finished.id, session: finished, analysis: data });
    if (side === 'long') { await page.getByTestId('crypto-plan-comparison').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${instrument.startsWith('BTC') ? 'btc' : 'eth'}-review.png`) }); }
    if (instrument.startsWith('BTC') && side === 'long') {
      await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: join(evidence, 'mobile-review.png') });
    }
    await click(page, '按原版本复练'); await expect(page.getByLabel('委托张数')).toHaveValue(''); await expect(page.locator('.replay-price-lines')).toHaveCount(0); const child = await reveal(page); const childMetrics = await api(`/${child.id}/analysis`); assert.equal(childMetrics.analysis.returnPercent, '0.00000000'); assert.deepEqual(childMetrics.first, finished.firstAttempt ? (await api(`/${finished.firstAttempt.id}/analysis`)).analysis : data.analysis); assert.deepEqual((await api(`/${finished.id}`)).session, finished);
    results.push({ instrument, side, flow: 'sizing-risk-fields-controlled-lines-add-reduce-topup-funding-review-frozen-retrain', returnPercent: data.analysis.returnPercent, maxDrawdownPercent: data.analysis.maxDrawdownPercent, netPnl: finished.summary.netPnl });
    await page.close(); process.stderr.write(`${instrument} ${side} sizing/chart/review verified\n`);
  }
  for (const instrument of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) {
    const page = await pageFor(); await create(page, instrument, '100'); await page.getByLabel('委托张数').fill('10'); await preview(page); await click(page, '提交委托'); await click(page, '推进 1 分钟');
    for (let i = 0; i < 300 && (await state(page)).account.position; i++) await click(page, '推进 15 分钟');
    assert.equal((await state(page)).account.position, null); const s = await reveal(page), data = await api(`/${s.id}/analysis`);
    assert.equal(data.analysis.trades[0].comparisonStatus, 'different-settlement-model'); assert.equal(data.analysis.trades[0].actualPricePnl, null); assert.equal(data.analysis.waiverIsNotTradingProfit, true);
    await expect(page.getByTestId('crypto-plan-comparison')).toContainText('教学接管为独立结算口径'); results.push({ instrument, flow: 'teaching-takeover-review-no-fake-fill' }); await page.close();
  }
  sourceAllowed = false; await stopBackend(); await backend(backendPort);
  for (const item of completed) { assert.deepEqual((await api(`/${item.id}`)).session, item.session); assert.deepEqual(await api(`/${item.id}/analysis`), item.analysis); }
  assert.deepEqual(errors, []);
  const files = ['backend/src/replay-crypto-insights.js', 'backend/src/replay-crypto-session.js', 'backend/src/replay-crypto-session.test.js', 'backend/src/replay-crypto-persistence.js', 'backend/src/replay-lifecycle-store.js', 'backend/src/app.js', 'web/src/utils/cryptoReplayController.js', 'web/src/utils/cryptoOrderPreview.js', 'web/src/utils/cryptoReplayPresentation.js', 'web/src/utils/replayPriceLines.js', 'web/src/views/CryptoReplayView.vue', 'web/src/components/CandlestickChart.vue', 'web/src/composables/useReplayKlineChart.js', 'web/src/components/crypto/CryptoTradingPanel.vue', 'web/src/components/crypto/CryptoReviewPanel.vue', 'web/src/services/api.js', 'web/tests/unit/cryptoReplay.test.js', 'backend/scripts/verify-crypto-insights.mjs'];
  const output = { status: 'verified-f1-f4-f6-frozen-real-browser', results, actualCanvasPlanTextPainted: true, sourceDisabledRestartMatches: true, browserRuntimeErrors: errors, productionLedgerTouched: false, userTestingLedgerTouched: false, temporaryDatabaseRemovedOnExit: true, codeSHA256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])) };
  writeFileSync(join(evidence, 'insights-browser-validation.json'), JSON.stringify(output, null, 2) + '\n'); console.log(JSON.stringify({ status: output.status, flows: results.length, runtimeErrors: errors.length }));
} finally { await browser?.close(); if (vite && vite.exitCode === null) { vite.kill('SIGTERM'); await new Promise(done => vite.once('exit', done)); } await stopBackend(); rmSync(folder, { recursive: true, force: true }); }
