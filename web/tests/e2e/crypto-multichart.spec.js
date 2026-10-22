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
  const reads=[],advances=[];
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(!url.pathname.startsWith(path)&&!url.pathname.endsWith('/crypto-pool')) return route.fulfill({json:{}});
    const response=await route.fetch({url:`${fixture.url}${url.pathname}${url.search}`});
    if(url.pathname.endsWith('/market')) reads.push({params:Object.fromEntries(url.searchParams),body:await response.json(),status:response.status()});
    if(url.pathname.endsWith('/advance')) advances.push({body:req.postDataJSON(),status:response.status()});
    await route.fulfill({response});
  });
  await page.addInitScript(({id,preferences})=>{
    localStorage.setItem('investflow-crypto-attempt-v1',JSON.stringify({sessionId:id}));
    if(!localStorage.getItem('investflow-crypto-workspace-v1')) localStorage.setItem('investflow-crypto-workspace-v1',JSON.stringify({layout:'quad',periods:[60,5,15,240],...preferences}));
  },{id:session.id,preferences});
  await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
  await expect(page.locator('.crypto-chart-tile')).toHaveCount(preferences.layout==='dual'?2:4,{timeout:15000});
  await expect(page.getByRole('button',{name:'推进 1 分钟',exact:true})).toBeEnabled();
  return {id:session.id,reads,advances};
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
          return {id:node.dataset.priceLineId,exists:!!overlay,price:overlay?.points?.[0]?.value,label:overlay?.extendData?.label,contracts:overlay?.extendData?.contracts,dashed:overlay?.extendData?.dashed,background:overlay?.extendData?.background};
        })};
    });
  });
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
