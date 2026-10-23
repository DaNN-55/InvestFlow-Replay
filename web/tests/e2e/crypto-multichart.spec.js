import { expect, test } from '@playwright/test';
import { startCryptoTestServer, cryptoTestDocument } from '../../../backend/src/test-support/crypto-server.js';
import { createCryptoScenarioView } from '../../../backend/src/replay-crypto-scenario.js';
import { cryptoChartBars, CRYPTO_PERIODS } from '../../src/utils/cryptoReplayPresentation.js';

const base=process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:5180';
const path='/api/quant/replay/sessions';
let fixture;
test.setTimeout(60000);
test.beforeAll(async()=>{fixture=await startCryptoTestServer();});
test.afterAll(async()=>{await fixture?.close();});
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'wait'});});

async function openPractice(page,request,preferences={}) {
  const created=await request.post(`${fixture.url}${path}`,{data:{market:'crypto-perpetual',actionId:crypto.randomUUID(),instrumentId:'BTC-USDT-SWAP'}});
  expect(created.status()).toBe(201);
  const {session}=await created.json();
  const reads=[],advances=[],commands=[];
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(!url.pathname.startsWith(path)&&!url.pathname.endsWith('/crypto-pool')) return route.fulfill({json:{}});
    if(url.pathname.endsWith('/actions')&&req.method()==='POST') commands.push(req.postDataJSON());
    const response=await route.fetch({url:`${fixture.url}${url.pathname}${url.search}`});
    if(url.pathname.endsWith('/market')) reads.push({params:Object.fromEntries(url.searchParams),body:await response.json(),status:response.status()});
    if(url.pathname.endsWith('/advance')) advances.push({body:req.postDataJSON(),status:response.status()});
    await route.fulfill({response});
  });
  await page.addInitScript(({id,preferences})=>{
    if(!localStorage.getItem('investflow-crypto-attempt-v1')) localStorage.setItem('investflow-crypto-attempt-v1',JSON.stringify({sessionId:id}));
    if(!localStorage.getItem('investflow-crypto-workspace-v1')) localStorage.setItem('investflow-crypto-workspace-v1',JSON.stringify({layout:'quad',periods:[60,5,15,240],...preferences}));
  },{id:session.id,preferences});
  await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
  await expect(page.locator('.crypto-chart-tile')).toHaveCount(preferences.layout==='dual'?2:4,{timeout:15000});
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  return {id:session.id,reads,advances,commands};
}

async function nativeCharts(page) {
  return page.evaluate(async()=>{
    const moduleUrl=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name))?.name;
    if(!moduleUrl) throw new Error('Native chart module not loaded');
    const {init}=await import(moduleUrl);
    return [...document.querySelectorAll('.crypto-chart-tile')].map(tile=>{
      const host=tile.querySelector('[k-line-chart-id]');
      if(!host) return null;
      // Pinned v9 looks up the registry by DOM id. Lookup-only object returns
      // the existing instance before any DOM work; never init(host) a second time.
      const chart=init({id:host.getAttribute('k-line-chart-id')});
      const crosshair=chart.getChartStore().getTooltipStore().getCrosshair();
      const volumeFigure=chart.getIndicatorByPaneId('replay-volume','VOL')?.figures?.find(f=>f.key==='volume');
      return {index:Number(tile.dataset.chartIndex),header:tile.querySelector('header').textContent,periodLabel:tile.querySelector('header b').textContent,
        data:chart.getDataList().map(b=>({startSequence:b.startSequence,endSequence:b.endSequence,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume})),
        crosshair:{paneId:crosshair.paneId,index:crosshair.realDataIndex,minute:crosshair.kLineData?.startSequence,y:crosshair.y},
        volume:chart.getIndicatorByPaneId('replay-volume','VOL')?.result?.map(b=>b.volume)??[],
        colors:{rise:chart.getStyles().candle.bar.upColor,fall:chart.getStyles().candle.bar.downColor,volumeRise:volumeFigure?.styles({current:{kLineData:{open:1,close:2}}})?.color,volumeFall:volumeFigure?.styles({current:{kLineData:{open:2,close:1}}})?.color},
        lines:[...tile.querySelectorAll('[data-price-line-id]')].map(node=>{
          const overlay=chart.getOverlayById(node.dataset.priceLineId);
          return {id:node.dataset.priceLineId,exists:!!overlay,price:overlay?.points?.[0]?.value,label:overlay?.extendData?.label,contracts:overlay?.extendData?.contracts,dashed:overlay?.extendData?.dashed,background:overlay?.extendData?.background,estimate:overlay?.extendData?.estimate,estimateText:overlay?.extendData?.estimateText,draggable:overlay?!overlay.lock:false,preview:!!overlay?.extendData?.preview};
        })};
    });
  });
}


function assertProtectionEstimate(line,session) {
  const p=session.account.position,base=Number(p.contracts)*Number(session.contract.ctVal)*Number(session.contract.ctMult),sign=p.side==='long'?1:-1;
  const expected=(Number(line.price)-Number(p.entryPrice))*base*sign;
  const percent=(Number(line.price)/Number(p.entryPrice)-1)*sign*Number(session.config.leverage)*100;
  expect(line.estimate.pnl).toBeCloseTo(expected,6);expect(line.estimate.returnPercent).toBeCloseTo(percent,6);
  expect(line.estimateText).toContain('USDT');expect(line.estimateText).toContain('%');
}


async function assertRewardRisk(page,session,preview=null) {
  const p=session.account.position,sl=preview?.leg==='stopLoss'?preview.price:session.protection.stopLoss.price,tp=preview?.leg==='takeProfit'?preview.price:session.protection.takeProfit.price;
  const expected=Math.abs((Number(tp)-Number(p.entryPrice))/(Number(sl)-Number(p.entryPrice)));
  const summary=page.getByTestId('crypto-reward-risk');
  await expect(summary).toHaveAttribute('data-preview',String(Boolean(preview)));
  const ratio=Number(await summary.getAttribute('data-ratio'));expect(ratio).toBeCloseTo(expected,5);
  await expect(summary).toContainText(`${ratio.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} : 1`);
}

function assertPrefixes(reads) {
  const supply=createCryptoScenarioView(cryptoTestDocument().scenario);
  for(const {params,body,status} of reads) {
    expect(status).toBe(200);
    const cursor=Number(params.elapsedMinutes),period=Number(params.timeframeMinutes);
    expect(body.elapsedMinutes).toBe(cursor);
    const expected=supply.visibleAt({elapsedMinutes:cursor,timeframeMinutes:period});
    for(const kind of ['last','mark']) {
      expect(body.candles[kind]).toEqual(expected.candles[kind].slice(-600));
      expect(body.candles[kind].filter(bar=>bar.knownThroughMinute>cursor)).toEqual([]);
    }
    expect(JSON.stringify(body)).not.toMatch(/test-multichart-private|backgroundStartMs|sourceUrl|2024-01-01/);
  }
}

async function assertRendered(page,reads,cursor) {
  await expect.poll(async()=>{
    const charts=await nativeCharts(page);
    return charts.every(c=>c?.data.length&&c.data.at(-1).endSequence===cursor-1);
  }).toBe(true);
  const charts=await nativeCharts(page);
  const expectedVolumes=[];
  for(const chart of charts) {
    const period=CRYPTO_PERIODS.find(([,label])=>chart.periodLabel===label)?.[0];
    expect(period).toBeTruthy();
    const view=reads.findLast(r=>Number(r.params.timeframeMinutes)===period&&Number(r.params.elapsedMinutes)===cursor)?.body;
    expect(view).toBeTruthy();
    const expected=cryptoChartBars(view,chart.header.includes('标记价格')?'mark':'last').map(b=>({startSequence:b.startSequence,endSequence:b.endSequence,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume)}));
    expect(chart.data).toEqual(expected);
    expectedVolumes.push(expected.map(b=>b.volume));
  }
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.volume)).toEqual(expectedVolumes);
  expect(await page.locator('.replay-kline-chart__error').count()).toBe(0);
}

async function advance(page,n) {
  await page.getByRole('button',{name:`推进 ${n} 分钟`,exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
}

test('four native charts keep independent periods and one causal prefix through switches, advances and reload',async({page,request})=>{
  test.setTimeout(120000);
  const {id,reads}=await openPractice(page,request);
  await assertRendered(page,reads,0);
  // Every supported period, including forming 1h/1d bars, uses the same cursor.
  for(const [period] of CRYPTO_PERIODS) {
    await page.getByRole('combobox',{name:'选中图周期',exact:true}).selectOption(String(period));
    await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
    await assertRendered(page,reads,0);
  }
  await page.getByRole('combobox',{name:'选中图价格类型'}).selectOption('mark');
  for(const n of [1,5,15]) await advance(page,n);
  await assertRendered(page,reads,21);
  const charts=await nativeCharts(page);
  expect(charts.map(c=>c.header)).toEqual([expect.stringContaining('1day'),expect.stringContaining('5min'),expect.stringContaining('15min'),expect.stringContaining('4h')]);
  expect(charts.flatMap(c=>c.data).every(b=>b.high<1000000)).toBe(true);
  assertPrefixes(reads);
  const forbidden=await request.get(`${fixture.url}${path}/${id}/market?elapsedMinutes=22&timeframeMinutes=1440`);
  expect(forbidden.status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await assertRendered(page,reads,21);
  await page.getByRole('button',{name:'图表布局与联动'}).click();
  await page.getByRole('checkbox',{name:'周期（默认独立）',exact:true}).check();
  await page.getByRole('button',{name:'收起布局设置'}).click();
  await page.getByRole('combobox',{name:'选中图周期',exact:true}).selectOption('3');
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await assertRendered(page,reads,21);
  expect((await nativeCharts(page)).every(c=>c.header.includes('3min'))).toBe(true);
  assertPrefixes(reads);
});

async function moveToMinute(page,index,minute) {
  const point=await page.evaluate(async({index,minute})=>{
    const moduleUrl=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name))?.name;
    if(!moduleUrl) throw new Error('Native chart module not loaded');
    const {init}=await import(moduleUrl);
    const host=document.querySelector(`[data-chart-index="${index}"] [k-line-chart-id]`),chart=init({id:host.getAttribute('k-line-chart-id')});
    const i=chart.getDataList().findIndex(b=>b.startSequence===minute);
    const pixel=chart.convertToPixel({dataIndex:i,value:50000},{paneId:'candle_pane'}),box=host.getBoundingClientRect();
    return {x:box.x+pixel.x,y:box.y+80};
  },{index,minute});
  await page.mouse.move(point.x,point.y);
}

test('crosshair maps replay minutes both ways, clears unavailable history, respects price type and switch',async({page,request})=>{
  await openPractice(page,request,{layout:'dual'});
  await advance(page,15);
  // 5m minute 10 belongs to the forming hourly candle starting at 0.
  await moveToMinute(page,1,10);
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.crosshair.minute)).toEqual([0,10]);
  await moveToMinute(page,0,0);
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.crosshair.minute)).toEqual([0,0]);
  // Fine chart only loads 600 bars; out-of-range history must clear, not clamp.
  await page.locator('[data-chart-index="0"]>header button').click();
  await page.getByRole('combobox',{name:'选中图周期',exact:true}).selectOption('240');
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await page.locator('[data-chart-index="1"]>header button').click();
  await page.getByRole('combobox',{name:'选中图周期',exact:true}).selectOption('1');
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await moveToMinute(page,0,-960);
  await expect.poll(async()=> (await nativeCharts(page))[1].crosshair.paneId).toBe(false);
  await page.getByRole('combobox',{name:'选中图价格类型'}).selectOption('mark');
  await moveToMinute(page,1,10);
  await expect.poll(async()=> (await nativeCharts(page))[0].crosshair.y??null).toBe(null);
  await page.getByRole('button',{name:'图表布局与联动'}).click();
  await page.getByRole('checkbox',{name:'十字线时间',exact:true}).uncheck();
  await page.getByRole('button',{name:'收起布局设置'}).click();
  await page.mouse.move(0,0);
  await moveToMinute(page,1,11);
  await expect.poll(async()=> (await nativeCharts(page))[0].crosshair.paneId).toBe(false);
});

test('playback speed stays sequential, stops on fills and preserves visible prefixes',async({page,request})=>{
  const {id,reads,advances}=await openPractice(page,request,{layout:'dual'});
  const speed=page.getByRole('combobox',{name:'自动回放倍率'});
  await expect(speed).toHaveValue('1');
  for(const n of [2,4,8]) await speed.selectOption(String(n));
  await page.getByRole('button',{name:'自动回放',exact:true}).click();
  await expect.poll(()=>advances.length).toBeGreaterThanOrEqual(2);
  await page.getByRole('button',{name:'暂停回放',exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const paused=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  await page.waitForTimeout(450);
  expect((await (await request.get(`${fixture.url}${path}/${id}`)).json()).session.elapsedMinutes).toBe(paused.elapsedMinutes);
  expect(advances.every(a=>a.body.minutes===1&&a.status===200)).toBe(true);
  expect(new Set(advances.map(a=>a.body.expectedRevision)).size).toBe(advances.length);
  await page.getByRole('textbox',{name:'委托张数',exact:true}).fill('1');
  await expect(page.getByRole('button',{name:'买入 / 做多',exact:true}).last()).toBeEnabled();
  await page.getByRole('button',{name:'买入 / 做多',exact:true}).last().click();
  await expect(page.getByRole('button',{name:'自动回放',exact:true})).toBeEnabled();
  const before=advances.length;
  await page.getByRole('button',{name:'自动回放',exact:true}).click();
  await expect.poll(()=>advances.length).toBe(before+1);
  await expect(page.getByRole('button',{name:'自动回放',exact:true})).toBeVisible();
  const filled=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(filled.account.position.contracts).toBe('1');
  await assertRendered(page,reads,filled.elapsedMinutes);
  assertPrefixes(reads);
  await page.reload();
  await expect(speed).toHaveValue('8');
  await expect(page.getByRole('button',{name:'自动回放',exact:true})).toBeVisible();
});

test('speed changes the interval, never the minute step, and pause cannot restart an in-flight loop',async({page,request})=>{
  const {id,advances}=await openPractice(page,request,{layout:'dual'});
  await page.clock.install({time:new Date('2030-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2030-01-01T00:00:10Z'));
  await page.getByRole('button',{name:'自动回放',exact:true}).click();
  await page.clock.runFor(899);
  expect(advances.length).toBe(0);
  await page.clock.runFor(1);
  await expect.poll(()=>advances.length).toBe(1);
  await expect(page.locator('.crypto-playback strong')).toHaveText('第1天 00:01');
  await page.getByRole('combobox',{name:'自动回放倍率'}).selectOption('8');
  let release,entered=false;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/quant/replay/sessions/*/advance',async route=>{entered=true;await gate;await route.fallback();});
  await page.clock.runFor(111);
  expect(entered).toBe(false);
  await page.clock.runFor(2);
  await expect.poll(()=>entered).toBe(true);
  await expect(page.getByRole('button',{name:'暂停回放',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'暂停回放',exact:true}).click();
  release();
  await expect.poll(()=>advances.length).toBe(2);
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await page.clock.runFor(5000);
  expect(advances.length).toBe(2);
  const current=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(current.elapsedMinutes).toBe(2);
  expect(advances.map(a=>a.body.minutes)).toEqual([1,1]);
});

test('compact order form keeps advanced inputs and makes explanations available on demand',async({page,request})=>{
  const {id}=await openPractice(page,request,{layout:'dual'});
  const order=page.locator('.crypto-trading'),advanced=order.locator('.order-advanced'),summary=advanced.locator('summary');
  await expect(order.getByRole('combobox',{name:'仓位输入方式',exact:true})).not.toBeVisible();
  await expect(order.getByRole('textbox',{name:'自动止损价',exact:true})).not.toBeVisible();
  await expect(order.getByRole('textbox',{name:'操作理由',exact:true})).not.toBeVisible();
  expect(await order.evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(430);
  await expect(page.locator('.crypto-header-actions button')).toHaveCount(1);
  await expect(page.locator('.crypto-playback-actions').getByRole('button',{name:'新开一局',exact:true})).toBeVisible();
  await order.getByRole('button',{name:'数量与单位说明'}).click();
  await expect(page.locator('.ui-tooltip__content')).toContainText('不是保证金');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ui-tooltip__content')).not.toBeVisible();
  await summary.click();
  await order.getByRole('combobox',{name:'仓位输入方式',exact:true}).selectOption('risk');
  await order.getByRole('textbox',{name:'风险预算',exact:true}).fill('5');
  await expect(order.locator('.preview-error')).toContainText('止损价');
  await order.getByRole('textbox',{name:'自动止损价',exact:true}).fill('49950');
  await order.getByRole('textbox',{name:'自动止盈价',exact:true}).fill('50050');
  await order.getByRole('textbox',{name:'操作理由',exact:true}).fill('等价格确认后再执行');
  await expect(order.getByRole('button',{name:'买入 / 做多',exact:true}).last()).toBeEnabled();
  await summary.click();
  await expect(summary).toContainText('风险估仓 · 止损 · 止盈 · 理由');
  await expect(order.locator('.order-estimated-quantity')).toContainText('张');
  await expect(page.locator('[data-price-line-id]')).toHaveCount(0);
  await summary.click();
  await expect(order.getByRole('textbox',{name:'自动止损价',exact:true})).toHaveValue('49950');
  await expect(order.getByRole('textbox',{name:'操作理由',exact:true})).toHaveValue('等价格确认后再执行');
  await summary.click();
  await page.setViewportSize({width:390,height:844});
  await order.getByRole('button',{name:'下单与合约规格说明'}).click();
  await expect(page.locator('.ui-tooltip__content')).toContainText('下一分钟');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'新开一局',exact:true}).click();
  await expect(page.getByRole('button',{name:'继续上次练习',exact:true})).toBeVisible();
  const preserved=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(preserved.revision).toBe(0);
  expect(preserved.status).toBe('active');
});

for(const side of ['long','short']) test(`${side} position and protective lines follow submit, fill, resize, price basis, cancellation and close`,async({page,request})=>{
  const {id}=await openPractice(page,request,{layout:'dual'});
  const order=page.locator('.crypto-trading');
  const action=side==='long'?'买入 / 做多':'卖出 / 做空';
  await order.getByRole('button',{name:action,exact:true}).first().click();
  await order.getByRole('textbox',{name:'委托张数',exact:true}).fill('1');
  await order.locator('.order-advanced>summary').click();
  await order.getByRole('textbox',{name:'自动止损价',exact:true}).fill(side==='long'?'49950':'50050');
  await order.getByRole('textbox',{name:'自动止盈价',exact:true}).fill(side==='long'?'50050':'49950');
  await order.locator('.order-advanced>summary').click();
  await expect(order.getByRole('button',{name:action,exact:true}).last()).toBeEnabled();
  await order.getByRole('button',{name:action,exact:true}).last().click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([2,2]);
  for(const chart of await nativeCharts(page)) expect(chart.lines.every(l=>l.exists&&l.dashed&&l.label.includes('待成交后'))).toBe(true);
  await advance(page,1);
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([3,3]);
  for(const chart of await nativeCharts(page)) {
    expect(chart.lines.every(l=>l.exists&&!l.dashed&&l.contracts==='1')).toBe(true);
    expect(chart.lines[0].label).toContain(side==='long'?'多仓均价':'空仓均价');
    expect(chart.lines[0].label).toContain('mark浮盈');
    expect(chart.colors).toEqual({rise:'#df7180',fall:'#38ae86',volumeRise:'#df7180',volumeFall:'#38ae86'});
  }
  await expect(order.getByRole('button',{name:action,exact:true}).last()).toBeEnabled();
  await page.screenshot({path:test.info().outputPath('position-before-theme.png')});
  const previousBackground=(await nativeCharts(page))[0].lines[0].background;
  await page.getByRole('button',{name:'切换主题',exact:true}).click();
  await expect.poll(async()=> (await nativeCharts(page)).every(c=>c.lines.every(l=>l.background&&l.background!==previousBackground))).toBe(true);
  await page.screenshot({path:test.info().outputPath('position-after-theme.png')});
  await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([3,3]);
  await order.getByRole('button',{name:'平仓',exact:true}).click();
  await order.getByRole('textbox',{name:'委托张数',exact:true}).fill('0.4');
  await expect(order.getByRole('button',{name:'提交平仓委托',exact:true})).toBeEnabled();
  await order.getByRole('button',{name:'提交平仓委托',exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await advance(page,1);
  await expect.poll(async()=> (await nativeCharts(page)).every(c=>c.lines.every(l=>l.contracts==='0.6'))).toBe(true);
  await page.locator('[data-chart-index="1"]>header button').click();
  await page.getByRole('combobox',{name:'选中图价格类型'}).selectOption('mark');
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([3,1]);
  const current=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  const cancelled=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:current.revision,command:{type:'cancel-protection',leg:'stopLoss'}}});
  expect(cancelled.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([2,1]);
  await order.getByRole('button',{name:'平仓',exact:true}).click();
  await order.getByRole('textbox',{name:'委托张数',exact:true}).fill('0.6');
  await expect(order.getByRole('button',{name:'提交平仓委托',exact:true})).toBeEnabled();
  await order.getByRole('button',{name:'提交平仓委托',exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await advance(page,1);
  await expect.poll(async()=> (await nativeCharts(page)).every(c=>c.lines.length===0)).toBe(true);
  await expect(order.getByRole('button',{name:'平仓',exact:true})).toHaveCount(0);
  await expect(order.getByRole('button',{name:'买入 / 做多',exact:true}).first()).toHaveAttribute('aria-pressed','true');
});

async function protectedPractice(page,request,side='long') {
  const practice=await openPractice(page,request,{layout:'dual',periods:[5,5,15,240],kinds:['last','mark','last','last']});
  const protection={stopLoss:{price:side==='long'?'49950':'50050',reference:'last'},takeProfit:{price:side==='long'?'50050':'49950',reference:'mark'}};
  const placed=await request.post(`${fixture.url}${path}/${practice.id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:0,command:{type:'market-open',side,contracts:'1',protection}}});
  expect(placed.status()).toBe(200);
  const advanced=await request.post(`${fixture.url}${path}/${practice.id}/advance`,{data:{actionId:crypto.randomUUID(),expectedRevision:1,minutes:1}});
  expect(advanced.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await nativeCharts(page)).map(c=>c.lines.length)).toEqual([2,2]);
  return {...practice,session:(await advanced.json()).session};
}

async function dragProtection(page,index,id,targetPrice,{release=true}={}) {
  await page.locator(`[data-chart-index="${index}"]`).scrollIntoViewIfNeeded();
  const points=await page.evaluate(async({index,id,targetPrice})=>{
    const moduleUrl=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name)).name;
    const {init}=await import(moduleUrl);
    const host=document.querySelector(`[data-chart-index="${index}"] [k-line-chart-id]`),chart=init({id:host.getAttribute('k-line-chart-id')});
    const overlay=chart.getOverlayById(id),bounding=chart.getSize('candle_pane','main');
    const yAxis={convertToPixel:value=>chart.convertToPixel({value},{paneId:'candle_pane'}).y};
    const originalY=yAxis.convertToPixel(overlay.points[0].value);
    const figures=overlay.createPointFigures({overlay,coordinates:[{x:0,y:originalY}],bounding,yAxis});
    const tag=figures.find(f=>f.key==='price-tag'),box=host.getBoundingClientRect();
    return {x:box.x+tag.attrs.x+35,y:box.y+tag.attrs.y,toY:box.y+tag.attrs.y+yAxis.convertToPixel(targetPrice)-originalY};
  },{index,id,targetPrice});
  await page.mouse.move(points.x,points.y);
  await page.mouse.down();
  await page.mouse.move(points.x,points.toY,{steps:8});
  if(release) await page.mouse.up();
}

for(const side of ['long','short']) test(`${side} protective drag previews only, cancels safely and confirms each leg once without changing its sibling`,async({page,request})=>{
  const {id,session,commands}=await protectedPractice(page,request,side);
  const stopId=`${id}:stopLoss`,confirm=page.getByRole('region',{name:'确认止盈止损调整'});
  const getSession=async()=> (await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  const stopTarget=side==='long'?49920:50020;
  await assertRewardRisk(page,session);
  await dragProtection(page,0,stopId,stopTarget,{release:false});
  const held=(await nativeCharts(page))[0].lines.find(l=>l.id===stopId);
  assertProtectionEstimate(held,session);expect(held.preview).toBe(true);
  await assertRewardRisk(page,session,{leg:'stopLoss',price:held.price});
  expect((await getSession()).protection).toEqual(session.protection);
  expect(commands.length).toBe(0);
  await page.keyboard.press('Escape');await page.mouse.up();
  await expect(confirm).toHaveCount(0);
  await assertRewardRisk(page,session);
  await dragProtection(page,0,stopId,stopTarget);
  await expect(confirm).toBeVisible();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'自动回放',exact:true})).toBeDisabled();
  expect((await getSession()).revision).toBe(session.revision);
  expect(commands.length).toBe(0);
  const ghost=(await nativeCharts(page))[0].lines.find(l=>l.id===`${stopId}:draft`);
  expect(ghost.preview&&ghost.dashed).toBe(true);
  assertProtectionEstimate(ghost,session);
  await assertRewardRisk(page,session,{leg:'stopLoss',price:ghost.price});
  await expect(page.getByTestId('crypto-protection-draft-estimate')).toHaveText(ghost.estimateText);
  expect((await nativeCharts(page))[0].lines.find(l=>l.id===stopId).price).toBe(Number(session.protection.stopLoss.price));
  if(side==='short') {await page.getByRole('button',{name:'取消调整',exact:true}).focus();await page.keyboard.press('Escape');}
  else await page.getByRole('button',{name:'取消调整',exact:true}).click();
  await expect(confirm).toHaveCount(0);
  expect(commands.length).toBe(0);
  for(const [index,leg,target] of [[0,'stopLoss',stopTarget],[1,'takeProfit',side==='long'?50020:49920]]) {
    const before=await getSession(),sibling=leg==='stopLoss'?'takeProfit':'stopLoss';
    await dragProtection(page,index,`${id}:${leg}`,target,{release:false});
    const heldLeg=(await nativeCharts(page))[index].lines.find(l=>l.id===`${id}:${leg}`);
    await assertRewardRisk(page,before,{leg,price:heldLeg.price});
    await page.mouse.up();
    await expect(confirm).toBeVisible();
    const previewLine=(await nativeCharts(page))[index].lines.find(l=>l.id===`${id}:${leg}:draft`),price=previewLine.price;
    assertProtectionEstimate(previewLine,before);
    await assertRewardRisk(page,before,{leg,price});
    expect(price).not.toBe(Number(before.protection[leg].price));
    await expect(confirm).toContainText(String(price));
    await page.screenshot({path:test.info().outputPath(`${leg}-draft.png`)});
    const count=commands.length;
    await page.getByRole('button',{name:'确认生效',exact:true}).evaluate(button=>{button.click();button.click();});
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
    const after=await getSession();
    expect(commands.length).toBe(count+1);
    expect(commands.at(-1).expectedRevision).toBe(before.revision);
    expect(after.protection[sibling]).toEqual(before.protection[sibling]);
    expect(Number(after.protection[leg].price)).toBe(price);
    expect(after.protection[leg].reference).toBe(before.protection[leg].reference);
    expect(after.elapsedMinutes).toBe(before.elapsedMinutes);
    const applied=(await nativeCharts(page))[index].lines.find(l=>l.id===`${id}:${leg}`);
    expect(applied.estimate).toEqual(previewLine.estimate);
    await assertRewardRisk(page,after);
  }
  const saved=await getSession();
  await dragProtection(page,0,stopId,side==='long'?49880:50040);
  await expect(confirm).toBeVisible();
  const count=commands.length;
  await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect(confirm).toHaveCount(0);
  expect(commands.length).toBe(count);
  expect((await getSession()).protection).toEqual(saved.protection);
});

test('stale protection drag is rejected instead of overwriting a newer session revision',async({page,request})=>{
  const {id,session,commands}=await protectedPractice(page,request);
  await dragProtection(page,0,`${id}:stopLoss`,49920);
  await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toBeVisible();
  const changed=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,command:{type:'set-plan',mode:'manual',manualExitPrice:'49000',reason:'另一窗口已更新'}}});
  expect(changed.status()).toBe(200);
  await page.getByRole('button',{name:'确认生效',exact:true}).click();
  await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toHaveCount(0);
  await expect(page.getByText('已重新同步操作结果，请核对当前委托或保护后重新操作。',{exact:true})).toBeVisible();
  expect(commands.length).toBe(1);expect(commands[0].expectedRevision).toBe(session.revision);
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest.protection).toEqual(session.protection);
  expect(latest.revision).toBe(session.revision+1);
});

test('lost response after confirming a drag retains the original action and retries it once after reload',async({page,request})=>{
  const {id,session}=await protectedPractice(page,request);
  await dragProtection(page,0,`${id}:stopLoss`,49920);
  await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toBeVisible();
  let original;
  await page.route('**/api/quant/replay/sessions/*/actions',async route=>{
    original=route.request().postDataJSON();
    const response=await route.fetch({url:`${fixture.url}${path}/${id}/actions`});
    expect(response.status()).toBe(200);
    await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'确认生效',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toHaveCount(0);
  const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')).pending);
  expect(pending.body).toEqual(original);
  await page.reload();
  await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重试原动作',exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toHaveCount(0);
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest.revision).toBe(session.revision+1);
  expect(latest.protection.stopLoss.price).toBe(original.command.stopLoss.price);
  expect(latest.protection.takeProfit).toEqual(session.protection.takeProfit);
});

async function limitPractice(page,request,side='long',intent='increase') {
  const practice=await openPractice(page,request,{layout:'dual',periods:[60,5,15,240],kinds:['last','last','last','last']});
  let session=(await (await request.get(`${fixture.url}${path}/${practice.id}`)).json()).session;
  const act=async command=>{
    const response=await request.post(`${fixture.url}${path}/${practice.id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,command}});
    expect(response.status()).toBe(200);session=(await response.json()).session;
  };
  if(intent==='reduce') {
    await act({type:'market-open',side,contracts:'3'});
    const response=await request.post(`${fixture.url}${path}/${practice.id}/advance`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,minutes:1}});
    expect(response.status()).toBe(200);session=(await response.json()).session;
  }
  const buy=(side==='long')!==(intent==='reduce'),limitPrice=buy?'49950':'50050';
  await act({type:intent==='reduce'?'limit-close':'limit-open',...(intent==='increase'?{side,protection:{stopLoss:{price:side==='long'?'49900':'50100',reference:'mark'}}}:{}),contracts:'1',limitPrice});
  const order=session.orders.at(-1);
  await act({type:intent==='reduce'?'limit-close':'limit-open',...(intent==='increase'?{side}:{}),contracts:'1',limitPrice:buy?'49910':'50090'});
  await page.reload();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect.poll(async()=> (await nativeCharts(page)).every(c=>c.lines.some(l=>l.id===`${practice.id}:order-${order.id}`&&l.draggable))).toBe(true);
  return {...practice,session,order,buy};
}

for(const side of ['long','short']) for(const intent of ['increase','reduce']) test(`${side} ${intent} limit drag previews across periods, cancels and confirms only its own remaining order`,async({page,request})=>{
  const {id,session,order,buy,commands,reads}=await limitPractice(page,request,side,intent);
  const lineId=`${id}:order-${order.id}`,confirm=page.getByRole('region',{name:'确认限价委托调整'}),target=buy?49930:50030;
  const current=async()=> (await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  await dragProtection(page,1,lineId,target,{release:false});
  expect(commands.length).toBe(0);expect((await current()).orders).toEqual(session.orders);
  await page.keyboard.press('Escape');await page.mouse.up();await expect(confirm).toHaveCount(0);
  await dragProtection(page,1,lineId,target);await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`未成交 ${order.remainingContracts} 张`);
  const price=(await nativeCharts(page))[1].lines.find(l=>l.id===`${lineId}:draft`).price;
  expect((await nativeCharts(page)).every(c=>c.lines.some(l=>l.id===`${lineId}:draft`&&l.price===price&&l.preview))).toBe(true);
  expect((await nativeCharts(page)).every(c=>c.lines.some(l=>l.id===lineId&&l.price===Number(order.limitPrice)))).toBe(true);
  await expect(page.getByRole('button',{name:'自动回放',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeDisabled();
  await page.getByRole('combobox',{name:'选中图周期',exact:true}).selectOption('15');
  await expect(page.getByRole('button',{name:'确认生效',exact:true})).toBeEnabled();
  await expect(confirm).toContainText(String(price));expect(commands.length).toBe(0);
  await page.getByRole('button',{name:'取消调整',exact:true}).click();await expect(confirm).toHaveCount(0);
  expect((await current()).orders).toEqual(session.orders);
  await dragProtection(page,0,lineId,buy?49800:49900);await expect(confirm).toBeVisible();
  const proposed=(await nativeCharts(page))[0].lines.find(l=>l.id===`${lineId}:draft`).price;
  await page.screenshot({path:test.info().outputPath('limit-draft.png')});
  await page.getByRole('button',{name:'确认生效',exact:true}).evaluate(button=>{button.click();button.click();});
  await expect(confirm).toHaveCount(0);await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const saved=await current(),changed=saved.orders.find(o=>o.id===order.id);
  expect(commands).toHaveLength(1);expect(commands[0].command).toEqual({type:'amend-limit',orderId:order.id,limitPrice:String(proposed)});
  expect(commands[0].expectedRevision).toBe(session.revision);expect(saved.revision).toBe(session.revision+1);
  expect(saved.elapsedMinutes).toBe(session.elapsedMinutes);expect(saved.account.position).toEqual(session.account.position);expect(saved.protection).toEqual(session.protection);
  for(const key of ['contracts','remainingContracts','filledContracts','attachedProtection','protectionApplied','intent','side']) expect(changed[key]).toEqual(order[key]);
  expect(Number(changed.limitPrice)).toBe(proposed);expect(saved.orders.filter(o=>o.id!==order.id)).toEqual(session.orders.filter(o=>o.id!==order.id));
  await dragProtection(page,0,lineId,49600);await expect(confirm).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await expect(confirm).toHaveCount(0);expect(commands).toHaveLength(1);expect((await current()).orders).toEqual(saved.orders);
  // Limit execution uses trade price; mark panes never offer editable limit lines.
  await page.getByRole('combobox',{name:'选中图价格类型'}).selectOption('mark');
  await expect.poll(async()=> (await nativeCharts(page))[0].lines.some(l=>l.id===lineId)).toBe(false);
  assertPrefixes(reads);
});

test('stale limit preview cannot restore an order cancelled by another writer',async({page,request})=>{
  const {id,session,order,commands}=await limitPractice(page,request);
  await dragProtection(page,0,`${id}:order-${order.id}`,49800);
  await expect(page.getByRole('region',{name:'确认限价委托调整'})).toBeVisible();
  const cancelled=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,command:{type:'cancel-order',orderId:order.id}}});
  expect(cancelled.status()).toBe(200);
  await page.getByRole('button',{name:'确认生效',exact:true}).click();
  await expect(page.getByRole('region',{name:'确认限价委托调整'})).toHaveCount(0);
  await expect(page.getByText('已重新同步操作结果，请核对当前委托或保护后重新操作。',{exact:true})).toBeVisible();
  expect(commands).toHaveLength(1);
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest.revision).toBe(session.revision+1);expect(latest.orders.some(o=>o.id===order.id)).toBe(false);
});

test('lost limit amendment response retries the original action without charging a second reserve',async({page,request})=>{
  const {id,session,order}=await limitPractice(page,request);
  await dragProtection(page,0,`${id}:order-${order.id}`,49800);
  await expect(page.getByRole('region',{name:'确认限价委托调整'})).toBeVisible();
  let original;
  await page.route('**/api/quant/replay/sessions/*/actions',async route=>{
    original=route.request().postDataJSON();
    const response=await route.fetch({url:`${fixture.url}${path}/${id}/actions`});expect(response.status()).toBe(200);await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'确认生效',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  const committed=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  await page.reload();await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')).pending);expect(pending.body).toEqual(original);
  await page.getByRole('button',{name:'重试原动作',exact:true}).click();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest).toEqual(committed);expect(latest.revision).toBe(session.revision+1);
  expect(latest.orders.find(o=>o.id===order.id).limitPrice).toBe(original.command.limitPrice);
});

async function clickNativePriceCancel(page,index,id,{drag=false}={}) {
  await page.locator(`[data-chart-index="${index}"]`).scrollIntoViewIfNeeded();
  const point=await page.evaluate(async({index,id})=>{
    const url=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name)).name;
    const {init}=await import(url),host=document.querySelector(`[data-chart-index="${index}"] [k-line-chart-id]`),chart=init({id:host.getAttribute('k-line-chart-id')});
    const overlay=chart.getOverlayById(id),bounding=chart.getSize('candle_pane','main'),yAxis={convertToPixel:value=>chart.convertToPixel({value},{paneId:'candle_pane'}).y};
    const figures=overlay.createPointFigures({overlay,coordinates:[{x:0,y:yAxis.convertToPixel(overlay.points[0].value)}],bounding,yAxis});
    const button=figures.find(f=>f.key==='price-cancel');if(!button) throw new Error('No cancellation button on this line');
    const box=host.getBoundingClientRect();return {x:box.x+button.attrs.x+5,y:box.y+button.attrs.y};
  },{index,id});
  if(drag) {await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y+30,{steps:5});await page.mouse.up();}
  else await page.mouse.click(point.x,point.y);
}

for(const side of ['long','short']) test(`${side} chart protection cancel confirms each leg without dragging or cancelling its sibling`,async({page,request})=>{
  const {id,session,commands}=await protectedPractice(page,request,side);
  const current=async()=> (await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  await page.screenshot({path:test.info().outputPath('chart-cancel-labels.png')});
  await clickNativePriceCancel(page,0,`${id}:stopLoss`,{drag:true});
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toHaveCount(0);expect(commands).toHaveLength(0);
  for(const [index,leg,label] of [[0,'stopLoss','自动止损'],[1,'takeProfit','自动止盈']]) {
    const before=await current();
    await clickNativePriceCancel(page,index,`${id}:${leg}`);
    let dialog=page.getByRole('dialog',{name:`撤销${label}？`});await expect(dialog).toBeVisible();
    expect((await current()).protection).toEqual(before.protection);expect(commands).toHaveLength(leg==='stopLoss'?0:1);
    await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true,includeHidden:true})).toBeDisabled();
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
    await clickNativePriceCancel(page,index,`${id}:${leg}`);await expect(dialog).toBeVisible();
    await page.screenshot({path:test.info().outputPath(`${leg}-cancel.png`)});
    const count=commands.length;await dialog.getByRole('button',{name:'确认撤销',exact:true}).evaluate(button=>{button.click();button.click();});
    await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
    const after=await current();expect(commands).toHaveLength(count+1);expect(commands.at(-1).command).toEqual({type:'cancel-protection',leg});
    expect(commands.at(-1).expectedRevision).toBe(before.revision);expect(after.elapsedMinutes).toBe(session.elapsedMinutes);expect(after.account.position).toEqual(session.account.position);
    expect(after.protection?.[leg]??null).toBe(null);
    if(leg==='stopLoss') expect(after.protection.takeProfit).toEqual(before.protection.takeProfit);
    await expect(page.getByTestId('crypto-reward-risk')).toHaveCount(0);
    await expect.poll(async()=> (await nativeCharts(page)).every(c=>!c.lines.some(l=>l.id===`${id}:${leg}`))).toBe(true);
  }
});

for(const intent of ['increase','reduce']) test(`${intent} chart limit cancel preserves fills and sibling, Escape and refresh discard confirmation, keyboard can confirm`,async({page,request})=>{
  const {id,session,order,commands}=await limitPractice(page,request,'long',intent);
  const lineId=`${id}:order-${order.id}`,dialog=page.getByRole('dialog',{name:'撤销限价委托？'});
  await clickNativePriceCancel(page,0,lineId);await expect(dialog).toBeVisible();expect(commands).toHaveLength(0);
  await dialog.getByRole('button',{name:'保留',exact:true}).click();await expect(dialog).toHaveCount(0);
  await clickNativePriceCancel(page,1,lineId);await expect(dialog).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();await expect(dialog).toHaveCount(0);expect(commands).toHaveLength(0);
  // The native canvas icon also has a focusable, named keyboard equivalent.
  const keyboard=page.locator('[data-chart-index="0"]').getByRole('button',{name:`撤销限价委托 #${order.id}，${order.limitPrice}`,exact:true});
  await keyboard.focus();await page.keyboard.press('Enter');await expect(dialog).toBeVisible();await expect(dialog).toContainText(`未成交 ${order.remainingContracts} 张`);
  await dialog.getByRole('button',{name:'确认撤销',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const saved=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(commands).toHaveLength(1);expect(commands[0].command).toEqual({type:'cancel-order',orderId:order.id});expect(commands[0].expectedRevision).toBe(session.revision);
  expect(saved.orders).toEqual(session.orders.filter(o=>o.id!==order.id));expect(saved.account.position).toEqual(session.account.position);expect(saved.protection).toEqual(session.protection);
  if(intent==='increase') expect(Number(saved.reservedBalance)).toBeLessThan(Number(session.reservedBalance));else expect(saved.reservedBalance).toBe(session.reservedBalance);expect(saved.elapsedMinutes).toBe(session.elapsedMinutes);
  await expect.poll(async()=> (await nativeCharts(page)).every(c=>!c.lines.some(l=>l.id===lineId))).toBe(true);
});

test('stale chart cancellation cannot delete a limit order repriced by another writer',async({page,request})=>{
  const {id,session,order,commands}=await limitPractice(page,request);
  await clickNativePriceCancel(page,0,`${id}:order-${order.id}`);const dialog=page.getByRole('dialog',{name:'撤销限价委托？'});await expect(dialog).toBeVisible();
  const response=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,command:{type:'amend-limit',orderId:order.id,limitPrice:'49800'}}});expect(response.status()).toBe(200);
  await dialog.getByRole('button',{name:'确认撤销',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已重新同步操作结果，请核对当前委托或保护后重新操作。',{exact:true})).toBeVisible();
  expect(commands).toHaveLength(1);const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest.orders.find(o=>o.id===order.id).limitPrice).toBe('49800');expect(latest.revision).toBe(session.revision+1);
});

test('lost chart cancellation response retries the same single-leg action after reload',async({page,request})=>{
  const {id,session}=await protectedPractice(page,request);
  await clickNativePriceCancel(page,0,`${id}:stopLoss`);await expect(page.getByRole('dialog',{name:'撤销自动止损？'})).toBeVisible();
  let original;await page.route('**/api/quant/replay/sessions/*/actions',async route=>{
    original=route.request().postDataJSON();const response=await route.fetch({url:`${fixture.url}${path}/${id}/actions`});expect(response.status()).toBe(200);await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'确认撤销',exact:true}).click();await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  const committed=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  await page.reload();await expect(page.getByRole('button',{name:'重试原动作',exact:true})).toBeVisible();
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')).pending)).body).toEqual(original);
  await page.getByRole('button',{name:'重试原动作',exact:true}).click();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;expect(latest).toEqual(committed);expect(latest.revision).toBe(session.revision+1);
  expect(latest.protection.stopLoss).toBe(null);expect(latest.protection.takeProfit).toEqual(session.protection.takeProfit);
});

test('protection estimates follow remaining position and weighted entry without counting topups as opening margin',async({page,request})=>{
  const {id,session,reads}=await protectedPractice(page,request);
  const initial=(await nativeCharts(page))[0].lines.find(l=>l.id===`${id}:stopLoss`);assertProtectionEstimate(initial,session);
  let current=session;
  const act=async command=>{const response=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:current.revision,command}});expect(response.status()).toBe(200);current=(await response.json()).session;};
  const sync=async()=>{await page.reload();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();return (await nativeCharts(page))[0].lines.find(l=>l.id===`${id}:stopLoss`);};
  await act({type:'add-margin',amount:'500'});
  const topped=await sync();expect(topped.estimate).toEqual(initial.estimate);await assertRewardRisk(page,current);
  for(const command of [{type:'market-close',contracts:'0.5'},{type:'market-open',side:'long',contracts:'0.5'}]) {
    await act(command);const response=await request.post(`${fixture.url}${path}/${id}/advance`,{data:{actionId:crypto.randomUUID(),expectedRevision:current.revision,minutes:1}});
    expect(response.status()).toBe(200);current=(await response.json()).session;
    const line=await sync();assertProtectionEstimate(line,current);await assertRewardRisk(page,current);
    if(command.type==='market-close') {expect(line.estimate.pnl).toBeCloseTo(initial.estimate.pnl/2,6);expect(line.estimate.returnPercent).toBeCloseTo(initial.estimate.returnPercent,6);}
  }
  await page.getByRole('button',{name:'止盈止损估算说明',exact:true}).click();
  await expect(page.locator('.ui-tooltip__content')).toContainText('不含手续费、滑点和资金费');
  await expect(page.locator('.ui-tooltip__content')).toContainText('追加保证金不改变分母');
  await page.keyboard.press('Escape');
  await page.screenshot({path:test.info().outputPath('protection-estimate.png'),fullPage:true});
  assertPrefixes(reads);
});

for(const side of ['long','short']) test(`${side} reward/risk preview explains locked-profit stops and wrong-side take-profits instead of inventing a ratio`,async({page,request})=>{
  const {id,session,commands}=await protectedPractice(page,request,side),summary=page.getByTestId('crypto-reward-risk');
  for(const [index,leg,target,reason] of [[0,'stopLoss',side==='long'?50030:49950,'止损不在亏损区'],[1,'takeProfit',side==='long'?49980:50020,'止盈不在盈利区']]) {
    await dragProtection(page,index,`${id}:${leg}`,target);
    await expect(page.getByRole('region',{name:'确认止盈止损调整'})).toBeVisible();
    await expect(summary).toContainText('—');await expect(summary).toContainText(reason);
    await expect(summary).toHaveAttribute('data-preview','true');expect(await summary.getAttribute('data-ratio')).toBe(null);
    await page.getByRole('button',{name:'取消调整',exact:true}).click();await assertRewardRisk(page,session);
  }
  expect(commands).toHaveLength(0);
  await page.getByRole('button',{name:'预计盈亏比说明',exact:true}).click();
  await expect(page.locator('.ui-tooltip__content')).toContainText('止盈预计盈利÷止损预计亏损');await page.keyboard.press('Escape');
  await page.screenshot({path:test.info().outputPath('reward-risk.png')});
});


test('inline position controls open editors without submitting and retain close confirmation',async({page,request})=>{
  const {commands}=await protectedPractice(page,request);
  const panel=page.getByTestId('crypto-risk'),row=panel.locator('.crypto-position-table');
  for(const [name,title] of [['调整保证金','调整逐仓保证金'],['止盈止损','持仓止盈止损']]) {
    const button=row.getByRole('button',{name,exact:true});
    await button.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:title,exact:true});
    await expect(dialog).toBeVisible();
    if(name==='止盈止损') await expect(dialog.getByRole('textbox',{name:'持仓自动止损价',exact:true})).not.toHaveValue('');
    expect(commands).toHaveLength(0);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  }
  for(const name of ['手动退出计划','持仓详情与完整精度']) {
    await panel.getByRole('button',{name,exact:true}).click();
    const dialog=page.getByRole('dialog',{name,exact:true});
    await expect(dialog).toBeVisible();await page.keyboard.press('Escape');
  }
  await expect(panel.locator('.crypto-position-actions')).toHaveCount(0);
  await row.getByRole('button',{name:'市价平全部',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'市价平全部',exact:true});
  await expect(dialog.getByRole('button',{name:'确认市价平全部',exact:true})).toBeEnabled();
  expect(commands).toHaveLength(0);await page.keyboard.press('Escape');
  await row.getByRole('button',{name:'市价平全部',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:test.info().outputPath('inline-position.png'),fullPage:true});
});


test('empty position disables inline margin protection and close controls',async({page,request})=>{
  const {commands}=await openPractice(page,request,{layout:'dual'});
  const panel=page.getByTestId('crypto-risk');
  for(const name of ['调整保证金','止盈止损','市价平全部']) await expect(panel.getByRole('button',{name,exact:true})).toBeDisabled();
  await expect(panel.getByRole('button',{name:'持仓详情与完整精度',exact:true})).toBeEnabled();
  expect(commands).toHaveLength(0);
});


test('position data and actions fit desktop and narrow panels without horizontal scrolling',async({page,request})=>{
  await protectedPractice(page,request);
  const panel=page.getByTestId('crypto-risk');
  for(const width of [1543,1280,900,768,390,320]) {
    await page.setViewportSize({width,height:953});
    await panel.scrollIntoViewIfNeeded();
    await expect.poll(()=>panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    const row=panel.locator('.crypto-position-table');
    expect(await row.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    const bounds=await panel.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);
    for(const name of ['调整保证金','止盈止损','市价平全部']) {
      const button=row.getByRole('button',{name,exact:true}),box=await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);expect(box.x+box.width).toBeLessThanOrEqual(bounds.x+bounds.width);
      await button.click();
      await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
    }
    if(width===1543) {
      const tops=await row.locator(':scope>div>strong').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));
      expect(Math.max(...tops)-Math.min(...tops)).toBeLessThanOrEqual(1);
    }
    if(width===1543||width===390) await panel.screenshot({path:test.info().outputPath(`position-${width}.png`)});
  }
  await panel.getByRole('button',{name:'持仓详情与完整精度',exact:true}).click();
  const details=page.getByRole('dialog',{name:'持仓详情与完整精度',exact:true});
  for(const label of ['标记价格','对应币数','风险率（≤100%触发）']) await expect(details.getByText(label,{exact:true})).toBeVisible();
});


test('compact order and fill rows keep prices quantities and cancellation usable on narrow screens',async({page,request})=>{
  const {id,session,order,commands}=await limitPractice(page,request,'long','reduce');
  const panel=page.getByTestId('crypto-risk');
  await panel.getByRole('button',{name:'当前委托',exact:false}).click();
  await expect(panel.locator('.crypto-activity-row')).toHaveCount(2);
  const first=panel.locator('.crypto-activity-row').first();
  await expect(first).toContainText('平多');await expect(first).toContainText('50,050.0000');
  await first.getByRole('button',{name:'委托详情',exact:true}).focus();await page.keyboard.press('Enter');
  let dialog=page.getByRole('dialog',{name:'委托详情',exact:true});
  await expect(dialog).toContainText(String(order.id));await expect(dialog).toContainText('冻结资金');
  expect(commands).toHaveLength(0);await page.keyboard.press('Escape');
  const amended=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:session.revision,command:{type:'amend-limit',orderId:order.id,limitPrice:'50060'}}});
  expect(amended.status()).toBe(200);await page.reload();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  await panel.getByRole('button',{name:'历史委托',exact:true}).click();
  const history=panel.locator('.crypto-activity-row');
  await expect(history.nth(2)).toContainText('50,050.0000');
  await expect(history.last()).toContainText('50,060.0000');
  await history.last().getByRole('button',{name:'委托详情',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'委托详情',exact:true})).toContainText('原委托价');
  await page.keyboard.press('Escape');
  for(const width of [1543,1280,900,768,390,320]) {
    await page.setViewportSize({width,height:953});
    for(const tab of ['当前委托','历史委托','成交']) {
      await panel.getByRole('button',{name:tab,exact:false}).click();
      await expect(panel.locator('.crypto-activity-row').first()).toBeVisible();
      await expect.poll(()=>panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      const boxes=await panel.locator('.crypto-activity-row').first().evaluate(el=>[...el.querySelectorAll('.crypto-activity-value,.crypto-activity-actions')].map(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};}));
      expect(Math.max(...boxes.map(b=>b.top))).toBeLessThan(Math.min(...boxes.map(b=>b.bottom)));
      expect(boxes[0].left).toBeGreaterThanOrEqual(0);expect(boxes.at(-1).right).toBeLessThanOrEqual(width);
      if(width===390||width===1543) await panel.screenshot({path:test.info().outputPath(`${tab}-${width}.png`)});
    }
  }
  await panel.getByRole('button',{name:'成交',exact:true}).click();
  const fill=panel.locator('.crypto-activity-row').first();
  await expect(fill).toContainText('开多');await expect(fill).toContainText('成交量');
  await expect(fill).not.toContainText('手续费');
  await fill.getByRole('button',{name:'成交详情',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'成交详情',exact:true});
  await expect(dialog).toContainText('手续费');await expect(dialog).toContainText('时间');await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'当前委托',exact:false}).click();
  await panel.locator('.crypto-activity-row').filter({hasText:'50,060.0000'}).getByRole('button',{name:'撤单',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'撤销限价委托？',exact:true});
  await expect(confirmation).toBeVisible();await expect(confirmation).toContainText('平多');await expect(confirmation).toContainText('委托价 50060');await expect(confirmation).toContainText('剩余未成交 1 张');
  expect(commands).toHaveLength(0);
  await confirmation.getByRole('button',{name:'保留',exact:true}).click();
  await expect(panel.locator('.crypto-activity-row')).toHaveCount(2);expect(commands).toHaveLength(0);
  await panel.locator('.crypto-activity-row').filter({hasText:'50,060.0000'}).getByRole('button',{name:'撤单',exact:true}).click();
  await expect(confirmation).toBeVisible();await page.keyboard.press('Escape');
  expect(commands).toHaveLength(0);
  await panel.locator('.crypto-activity-row').filter({hasText:'50,060.0000'}).getByRole('button',{name:'撤单',exact:true}).click();
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true,includeHidden:true})).toBeDisabled();
  await page.screenshot({path:test.info().outputPath('order-cancel-confirmation.png')});
  await confirmation.getByRole('button',{name:'确认撤销',exact:true}).evaluate(button=>{button.click();button.click();});
  await expect(confirmation).toHaveCount(0);
  await expect(panel.locator('.crypto-activity-row')).toHaveCount(1);
  expect(commands).toHaveLength(1);expect(commands[0].command).toEqual({type:'cancel-order',orderId:order.id});
  const latest=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(latest.orders.map(o=>o.id)).toEqual(session.orders.filter(o=>o.id!==order.id).map(o=>o.id));
  await panel.getByRole('button',{name:'历史委托',exact:true}).click();
  const cancelled=panel.locator('.crypto-activity-row').last();
  await expect(cancelled).toContainText('委托已撤');await expect(cancelled).toContainText('50,060.0000');
  await cancelled.getByRole('button',{name:'委托详情',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'委托详情',exact:true})).toContainText('手动撤单');
});


test('pending market order cancellation shows its direction and market price before confirmation',async({page,request})=>{
  const {id,commands}=await openPractice(page,request,{layout:'dual'});
  const placed=await request.post(`${fixture.url}${path}/${id}/actions`,{data:{actionId:crypto.randomUUID(),expectedRevision:0,command:{type:'market-open',side:'short',contracts:'1'}}});
  expect(placed.status()).toBe(200);const {session}=await placed.json();
  await page.reload();await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  const panel=page.getByTestId('crypto-risk');await panel.getByRole('button',{name:'当前委托',exact:false}).click();
  await panel.getByRole('button',{name:'撤单',exact:true}).focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'撤销市价委托？',exact:true});
  await expect(dialog).toContainText('开空');await expect(dialog).toContainText('委托价 市价');await expect(dialog).toContainText('剩余未成交 1 张');
  expect(commands).toHaveLength(0);
  await dialog.getByRole('button',{name:'确认撤销',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(panel.getByText('暂无待成交委托。',{exact:true})).toBeVisible();
  expect(commands).toHaveLength(1);expect(commands[0].command).toEqual({type:'cancel-order',orderId:session.orders[0].id});
  expect(commands[0].expectedRevision).toBe(session.revision);
  const saved=(await (await request.get(`${fixture.url}${path}/${id}`)).json()).session;
  expect(saved.elapsedMinutes).toBe(0);expect(saved.account.position).toBeNull();expect(saved.orders).toHaveLength(0);expect(saved.reservedBalance).toBe('0.00000000');
});
