import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import Decimal from 'decimal.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireWeb = createRequire(join(root, 'web/package.json'));
const { chromium, expect } = requireWeb('@playwright/test');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'codex/okx-crypto-training');
const baseline = JSON.parse(readFileSync(join(root, 'docs/research/okx-sample-evidence/2026-10-20-p3b-orders-validation.json')));
for (const [file, sha] of Object.entries(baseline.codeSHA256)) assert.equal(hash(readFileSync(join(root, file))), sha, file);
const folder = mkdtempSync(join(tmpdir(), 'crypto-p5-ui-'));
const evidenceFolder = join(root, 'docs/research/okx-sample-evidence');
mkdirSync(evidenceFolder, { recursive: true });
const servers = [], results = [], screenshots = [], pageErrors = [];
let browser;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() { const s = createServer(); await new Promise((done) => s.listen(0, '127.0.0.1', done)); const port = s.address().port; await new Promise((done) => s.close(done)); return port; }
async function start(args, cwd, env, url) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); servers.push(child);
  let logs = ''; child.stdout.on('data', (d) => { logs = (logs + d).slice(-6000); }); child.stderr.on('data', (d) => { logs = (logs + d).slice(-6000); });
  for (let i = 0; i < 150; i++) { if (child.exitCode != null) throw new Error(logs); try { if ((await fetch(url)).ok) return; } catch { /* Wait for owned temporary service only. */ } await delay(100); }
  throw new Error(`Temporary server did not start: ${logs}`);
}
const backendPort = await freePort(), webPort = await freePort();
const backend = `http://127.0.0.1:${backendPort}`, web = `http://127.0.0.1:${webPort}`;
const output = { status: 'verified-p5-real-browser-offline', branch: 'codex/okx-crypto-training', frozenManifestSHA256: hash(readFileSync(join(root, "storage/crypto-samples/okx-20240101-v1/manifest.json"))),
  source: 'frozen BTC/ETH 2024-01-01 72h, no expanded pool', productionLedgerTouched: false, temporaryDatabaseRemovedOnExit: true, results, screenshots };
try {
  await start(['--no-warnings', 'src/standalone-server.js'], join(root,'backend'), { INVESTFLOW_REPLAY_BACKEND_PORT: backendPort, INVESTFLOW_REPLAY_CRYPTO_SOURCE: "sample", INVESTFLOW_REPLAY_STORAGE_ROOT: folder, INVESTFLOW_REPLAY_ENGINE_URL: 'http://127.0.0.1:1' }, `${backend}/api/quant/replay/sessions?market=crypto-perpetual`);
  await start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], join(root,'web'), { INVESTFLOW_REPLAY_BACKEND_PORT: backendPort }, web);
  if (process.argv.includes('--serve')) {
    process.stderr.write(`P5_TEMP_WEB=${web}\nP5_TEMP_STORAGE=${folder}\n`);
    await new Promise((done) => { process.once('SIGTERM', done); process.once('SIGINT', done); });
  } else {
    browser = await chromium.launch({ headless: true });
    async function pageFor() {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message)); await page.goto(`${web}/decision/crypto-replay`); await idle(page); return page;
    }
    async function idle(page, allowError = false) {
      await expect(page.locator('.crypto-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
      if (!allowError) await expect(page.getByRole('alert')).toHaveCount(0);
    }
    async function click(page, name) { await page.getByRole('button', { name, exact: true }).click(); await idle(page); }
    async function state(page) { const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1'))); return (await (await page.request.get(`${backend}/api/quant/replay/sessions/${saved.sessionId}`)).json()).session; }
    async function audit(page, id, kind) { let after = kind === 'ledger' ? -1 : 0; const items = []; for (;;) { const r = await (await page.request.get(`${backend}/api/quant/replay/sessions/${id}/${kind}?after=${after}&limit=200`)).json(); items.push(...r.items); if (r.items.length < 200) return items; after = kind === 'ledger' ? r.items.at(-1).revision : r.items.at(-1).sequence; } }
    async function snapshot(page, name) { const file = `2026-10-21-p5-${name}.png`; await page.screenshot({ path: join(evidenceFolder, file), fullPage: false }); screenshots.push(file); }
    async function create(page, instrument, leverage = '5') { await page.getByLabel('合约', { exact: true }).selectOption(instrument); await page.getByLabel('杠杆倍数').fill(leverage); await click(page, '开始合约盲测'); assert.equal((await state(page)).config.leverage, leverage); await page.getByLabel('委托张数').fill('10'); }
    async function finishReview(page, retrain = false) {
      await click(page, '结束并退出'); let s = await state(page); if (s.status === 'active') { await click(page, '推进 1 分钟'); s = await state(page); } assert.equal(s.status, 'completed');
      await page.getByLabel('盲评判断').fill('冻结样本工程操作验证，不评价盈利能力'); await page.getByLabel('盲评交易计划').fill('按计划退出，保留原判断'); await click(page,'保存首次盲评');
      await click(page,'揭晓完整行情'); await page.getByLabel('复盘观察').fill('核对原判断与真实路径'); await page.getByLabel('执行偏差').fill('核对已记录的操作理由与费用'); await page.getByLabel('下次行动').fill('下一次先写清退出条件'); await click(page,'保存事后复盘');
      const first = await state(page); await page.reload(); await idle(page); assert.deepEqual((await state(page)).trainingJournal, first.trainingJournal);
      if (retrain) { await click(page,'按原版本复练'); const child = await state(page); assert.equal(child.elapsedMinutes,0); assert.deepEqual(child.config,first.config); assert.equal(child.executionModelVersion,first.executionModelVersion); assert.equal(child.trainingJournal.postReview,null);
        await click(page,'结束并退出'); await page.getByLabel('盲评判断').fill('复练仍然等待'); await page.getByLabel('盲评交易计划').fill('不交易'); await click(page,'保存首次盲评'); await click(page,'揭晓完整行情'); await expect(page.getByTestId('crypto-first-comparison')).toBeVisible();
        assert.deepEqual((await (await page.request.get(`${backend}/api/quant/replay/sessions/${first.id}`)).json()).session, first);
      }
      return first;
    }
    for (const instrument of ['BTC-USDT-SWAP','ETH-USDT-SWAP']) for (const side of ['long','short']) {
      const page = await pageFor(); const extensive = side === 'long';
      if (instrument.startsWith('BTC') && extensive) await snapshot(page,'setup');
      await create(page,instrument); let s = await state(page);
      await expect(page.locator('[data-risk-mode="none"]')).toBeVisible();
      const price = Number(s.currentPrices.last), tick = s.contract.tickSz;
      const quantize = (n) => new Decimal(n).toNearest(tick).toFixed();
      await page.getByLabel('计划方式').selectOption('manual'); await page.getByLabel('手动退出价').fill(quantize(price*(side === 'long' ? .9 : 1.1))); await page.getByLabel('计划原因').fill('先留退出计划，手动执行'); await click(page,'保存退出计划');
      await expect(page.locator('[data-risk-mode="manual"]')).toBeVisible();
      await page.getByLabel('合约操作').selectOption(side); await page.getByLabel('操作理由').fill('验证同向持仓与退出'); await click(page,'提交委托'); await click(page,'推进 1 分钟'); s = await state(page); assert.equal(s.account.position.side,side); assert.equal(s.account.position.contracts,'10');
      if (extensive) {
        const prior = s;
        if (instrument.startsWith('BTC')) {
          let lost = false;
          await page.route('**/sessions/*/actions', async (route) => { if (!lost && route.request().postDataJSON()?.command?.type === 'add-margin') { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
          await page.getByRole('button', { name:'追加保证金', exact:true }).click(); await idle(page,true); await expect(page.getByRole('button', { name:'重试原动作', exact:true })).toBeVisible();
          await page.reload(); await idle(page,true); await click(page,'重试原动作'); await page.unroute('**/sessions/*/actions');
        } else await click(page,'追加保证金');
        s = await state(page); assert.equal(new Decimal(s.account.availableBalance).minus(prior.account.availableBalance).toFixed(8),'-500.00000000'); assert.equal(new Decimal(s.account.position.marginBalance).minus(prior.account.position.marginBalance).toFixed(8),'500.00000000');
        await page.getByLabel('自动止损价').fill(quantize(price*.5)); await page.getByLabel('自动止盈价').fill(quantize(price*1.5)); await click(page,'更新持仓保护'); await expect(page.locator('[data-risk-mode="automatic"]')).toBeVisible();
        await page.reload(); await idle(page); await expect(page.locator('[data-risk-mode="automatic"]')).toBeVisible();
        await click(page,'仅取消止损'); await expect(page.locator('[data-risk-mode="manual"]')).toBeVisible(); await click(page,'取消全部保护');
        await page.getByLabel('自动止损价').fill(''); await page.getByLabel('自动止盈价').fill('');
        await page.getByLabel('委托类型').selectOption('limit'); await page.getByLabel('委托限价').fill(quantize(price*.5)); await click(page,'提交委托'); await click(page,'推进 1 分钟'); assert.ok((await state(page)).orders.length); await click(page,'撤单'); assert.equal((await state(page)).reservedBalance,'0.00000000');
        await page.getByLabel('委托类型').selectOption('market'); await page.getByLabel('委托张数').fill('5'); await click(page,'提交委托'); await click(page,'推进 1 分钟'); assert.equal((await state(page)).account.position.contracts,'15');
        await page.getByLabel('合约操作').selectOption('reduce'); await page.getByLabel('委托张数').fill('4'); await click(page,'提交委托'); await click(page,'推进 1 分钟'); assert.equal((await state(page)).account.position.contracts,'11');
        if (instrument.startsWith('BTC')) await snapshot(page,'trading');
      }
      for (const period of ['1','1440']) { await page.getByLabel('K线周期').selectOption(period); await idle(page); assert.equal(await page.locator('[data-testid="replay-klinecharts-host"] canvas').count() > 0,true); }
      const current = await state(page); const forbidden = await page.request.get(`${backend}/api/quant/replay/sessions/${current.id}/market?elapsedMinutes=${current.elapsedMinutes+1}&limit=1`); assert.equal(forbidden.status(),409);
      if (extensive) {
        while ((await state(page)).elapsedMinutes < 482) await click(page,'推进 15 分钟');
        const funded = await state(page); assert.notEqual(funded.totals.fundingPayments,'0.00000000');
        const traces = await audit(page,funded.id,'traces'); assert.ok(traces.some((e)=>e.type==='funding-settled'));
      }
      await click(page,'市价平全部'); await click(page,'推进 1 分钟'); assert.equal((await state(page)).account.position,null);
      const first = await finishReview(page,extensive); const rows = await audit(page,first.id,'ledger');
      const sum = (key) => rows.reduce((n,r) => n.plus(r[key]),new Decimal(0)).toFixed(8);
      assert.equal(sum('availableDelta'), first.account.availableBalance); assert.equal(sum('feesDelta'), first.totals.tradingFees); assert.equal(sum('fundingDelta'), first.totals.fundingPayments);
      results.push({ instrument, side, flow:'open-plan-add-margin-protect-cancel-limit-add-reduce-close-review-restore-retrain', extensive, finalAvailable:first.account.availableBalance, fees:first.totals.tradingFees, funding:first.totals.fundingPayments,journalDecisions:first.trainingJournal.decisions.length, ledgerRows:rows.length, responseLossRetry:instrument.startsWith('BTC')&&extensive });
      if (instrument.startsWith('BTC') && extensive) { await page.getByRole('heading',{name:'这次练习，留下什么？'}).scrollIntoViewIfNeeded(); await snapshot(page,'review'); await page.setViewportSize({width:390,height:844}); await page.evaluate(()=>scrollTo(0,0)); await snapshot(page,'mobile'); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true); }
      await page.context().close(); process.stderr.write(`${instrument} ${side} full UI flow verified\n`);
    }
    for (const instrument of ['BTC-USDT-SWAP','ETH-USDT-SWAP']) {
      const page = await pageFor(); await create(page,instrument,'100'); await page.getByLabel('操作理由').fill('风险阈值工程验证，产品默认仍为5倍'); await click(page,'提交委托'); await click(page,'推进 1 分钟'); const before = await state(page);
      for (let n=0;n<300;n++) { const s = await state(page); if (!s.account.position) break; await click(page,'推进 15 分钟'); }
      const s = await state(page), traces = await audit(page,s.id,'traces'); assert.equal(s.account.position,null);
      const liquidations = traces.filter((e)=>e.type==='teaching-liquidation'); assert.equal(liquidations.length,1); assert.equal(s.account.availableBalance,before.account.availableBalance);
      await expect(page.getByTestId('crypto-settlement')).toBeVisible(); for(const location of ['setup','risk','settlement','review']) await expect(page.locator(`[data-model-notice="${location}"]`)).toBeVisible();
      await page.reload(); await idle(page); assert.equal((await state(page)).totals.liquidationAggregatePnl,s.totals.liquidationAggregatePnl);
      await page.getByTestId('crypto-settlement').scrollIntoViewIfNeeded(); await snapshot(page,`${instrument.startsWith('BTC')?'btc':'eth'}-settlement`);
      const finished = await finishReview(page); results.push({instrument,flow:'teaching-takeover-restore-review',observedAtMinute:liquidations[0].observedAtMinute,aggregate:finished.totals.liquidationAggregatePnl,available:finished.account.availableBalance});
      await page.context().close(); process.stderr.write(`${instrument} teaching takeover UI verified\n`);
    }
    for (const [instrument, side] of [['BTC-USDT-SWAP','long'],['ETH-USDT-SWAP','short']]) {
      const page = await pageFor(); await create(page,instrument); await page.getByLabel('合约操作').selectOption(side); await click(page,'提交委托'); await click(page,'推进 1 分钟'); const s = await state(page);
      const price = new Decimal(s.currentPrices.last), tick = s.contract.tickSz;
      await page.getByLabel('自动止损价').fill(price.times(side==='long'?'1.1':'.9').toNearest(tick).toFixed());
      await page.getByLabel('自动止盈价').fill(price.times(side==='long'?'1.2':'.8').toNearest(tick).toFixed());
      await click(page,'更新持仓保护'); await expect(page.locator('[data-risk-mode="automatic"]')).toBeVisible();
      await click(page,'推进 1 分钟'); const after = await state(page), traces = await audit(page,after.id,'traces');
      assert.equal(after.account.position,null); assert.equal(after.protection,null);
      const trigger = traces.find((e)=>e.type==='protection-triggered'); assert.equal(trigger.leg,'stopLoss'); assert.equal(trigger.siblingCancelled,true); assert.ok(traces.some((e)=>e.type==='protection-filled')); assert.ok(!traces.some((e)=>e.type==='teaching-liquidation'));
      await finishReview(page); results.push({instrument,side,flow:'stop-trigger-and-OCO-exit',remainingPosition:after.account.position}); await page.context().close(); process.stderr.write(`${instrument} protective stop / OCO UI verified\n`);
    }
    // Frozen two-currency no-trade path and old A-share entry remain operable.
    for (const instrument of ['BTC-USDT-SWAP','ETH-USDT-SWAP']) { const page = await pageFor(); await create(page,instrument); const s = await finishReview(page); assert.equal(s.summary.netPnl,'0.00000000'); results.push({instrument,flow:'no-trade-review',netPnl:s.summary.netPnl}); await page.context().close(); }
    const page = await pageFor(); await page.getByRole('link',{name:'行情演练',exact:true}).click(); await expect(page.getByRole('heading',{name:'用未知行情验证一条交易规则'})).toBeVisible(); await page.getByRole('link',{name:'合约盲测',exact:true}).click(); await expect(page.getByRole('heading',{name:'合约练习',exact:true})).toBeVisible(); await page.context().close();
    assert.deepEqual(pageErrors,[]); output.browserRuntimeErrors = pageErrors;
    const files = ['backend/src/db.js','backend/src/replay-crypto-session.test.js','web/tests/unit/cryptoReplay.test.js','backend/src/replay-crypto-session.js','backend/src/replay-crypto-persistence.js','backend/src/replay-interaction.js','backend/src/replay-lifecycle-store.js','web/src/views/CryptoReplayView.vue','web/src/utils/cryptoReplayController.js','web/src/utils/cryptoReplayPresentation.js','web/src/services/api.js','web/src/router/index.js','web/src/App.vue',...['CryptoSetupPanel','CryptoTradingPanel','CryptoReviewPanel','CryptoModelNotice'].map((name)=>`web/src/components/crypto/${name}.vue`),'backend/scripts/verify-crypto-interface.mjs'];
    output.codeSHA256 = Object.fromEntries(files.map((file)=>[file,hash(readFileSync(join(root,file)))]));
    writeFileSync(join(evidenceFolder,'2026-10-21-p5-interface-validation.json'),JSON.stringify(output,null,2)+'\n');
    process.stdout.write(JSON.stringify({status:output.status,flows:results.length,screenshots:screenshots.length,productionLedgerTouched:false})+'\n');
  }
} finally {
  await browser?.close(); for (const child of servers) child.kill('SIGTERM');
  await Promise.all(servers.map((child)=>child.exitCode!=null?Promise.resolve():new Promise((done)=>child.once('exit',done))));
  rmSync(folder,{recursive:true,force:true});
}
