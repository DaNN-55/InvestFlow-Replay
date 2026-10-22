import { expect, test } from '@playwright/test';

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';

test('compact mark-price chart renders actual traded volume through the native indicator', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json:{} }));
  await page.goto(baseUrl);
  await page.evaluate(async () => {
    const { init } = await import('/node_modules/.vite/deps/klinecharts.js');
    const { createReplayBuiltinIndicatorConfig } = await import('/src/utils/replayKlineIndicators.js');
    const { cryptoChartBars } = await import('/src/utils/cryptoReplayPresentation.js');
    const { adaptReplayBars } = await import('/src/utils/replayKlineAdapter.js');
    const host = document.createElement('div');
    host.style.cssText = 'width:640px;height:400px';
    document.body.appendChild(host);
    const mark = Array.from({length:30}, (_,i) => ({startMinute:i*5,knownThroughMinute:(i+1)*5,complete:true,open:'10',high:'12',low:'9',close:'11'}));
    const last = mark.map((bar,i) => ({...bar,volumeContracts:String(100+i),volumeQuote:String((100+i)*10)}));
    const data = adaptReplayBars(cryptoChartBars({timeframeMinutes:5,candles:{last,mark}}, 'mark')).data;
    const chart = init(host);
    chart.createIndicator(createReplayBuiltinIndicatorConfig('VOL', 'sub', {compact:true,rise:'green',fall:'red'}), false, {id:'volume-proof',height:92});
    chart.applyNewData(data);
    window.volumeProof = { chart,host,expected:data.map(bar=>bar.volume) };
  });
  await expect.poll(() => page.evaluate(() => window.volumeProof.chart.getIndicatorByPaneId('volume-proof','VOL')?.result?.length ?? 0)).toBe(30);
  const result = await page.evaluate(() => {
    const {chart,expected} = window.volumeProof;
    const indicator = chart.getIndicatorByPaneId('volume-proof','VOL');
    return { values:indicator.result.map(item=>item.volume), expected, figures:indicator.figures.map(figure=>figure.key) };
  });
  expect(result.values).toEqual(result.expected);
  expect(result.figures).toEqual(['volume']);
  await page.evaluate(async () => {
    const { dispose } = await import('/node_modules/.vite/deps/klinecharts.js');
    dispose(window.volumeProof.chart);
    window.volumeProof.host.remove();
    delete window.volumeProof;
  });
});
