import {test,expect} from '@playwright/test';
const base=process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:5180';
for(const period of ['day','minute']) test(`${period} candle and volume axes wheel vertically without changing time or source data`,async({page})=>{
  await page.route('**/api/**',route=>route.fulfill({json:{}}));await page.goto(`${base}/decision/crypto-replay`);
  await expect(page.getByRole('heading',{name:'这次怎么练？',exact:true})).toBeVisible();
  await page.evaluate(async period=>{
    const vueUrl=performance.getEntriesByType('resource').find(e=>/\/vue\.js\?v=/.test(e.name))?.name??'/node_modules/.vite/deps/vue.js';
    const {createApp,h}=await import(vueUrl),{default:Chart}=await import('/src/components/CandlestickChart.vue');
    const root=document.createElement('div');root.id='axis-test';root.style.cssText='position:fixed;z-index:10000;top:60px;left:20px;width:900px;background:white';document.body.prepend(root);
    const bars=Array.from({length:80},(_,i)=>({period,datetime:`第${i}根`,startSequence:i,endSequence:i,open:100+i,close:101+i,high:102+i,low:99+i,volume:1000+i*50}));
    window.axisApp=createApp({render:()=>h(Chart,{bars,height:450})});window.axisApp.mount(root);
  },period);
  await expect(page.locator('#axis-test [k-line-chart-id]')).toBeVisible();
  for(const paneId of ['candle_pane','replay-volume']) {
    const snapshot=()=>page.evaluate(async paneId=>{
      const url=performance.getEntriesByType('resource').find(e=>/\/klinecharts\.js\?v=/.test(e.name)).name,{init}=await import(url);
      const chart=init({id:document.querySelector('#axis-test [k-line-chart-id]').getAttribute('k-line-chart-id')}),axis=chart.getDrawPaneById(paneId).getAxisComponent(),box=chart.getDom(paneId,'yAxis').getBoundingClientRect();
      return {range:axis.getRange().range,x:box.x+box.width/2,y:box.y+box.height/2,time:chart.getVisibleRange(),bars:chart.getDataList(),auto:axis.getAutoCalcTickFlag()};
    },paneId);
    const before=await snapshot();await page.mouse.move(before.x,before.y);await page.mouse.wheel(0,-160);
    await expect.poll(async()=> (await snapshot()).range).toBeLessThan(before.range);
    const zoomed=await snapshot();expect(zoomed.bars).toEqual(before.bars);expect(zoomed.time).toEqual(before.time);expect(zoomed.auto).toBe(false);
    await page.mouse.wheel(0,160);await expect.poll(async()=>Math.abs((await snapshot()).range-before.range)).toBeLessThan(0.00001);
    await page.mouse.dblclick(before.x,before.y);await expect.poll(async()=> (await snapshot()).auto).toBe(true);
  }
  await page.screenshot({path:test.info().outputPath(`axis-${period}.png`)});
  await page.evaluate(()=>{window.axisApp.unmount();document.getElementById('axis-test').remove();});
});
