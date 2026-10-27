import { test, expect } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';

for (const [code,label,validQuantity,invalidQuantity] of [['600000.SH','主板',100,150],['300001.SZ','创业板',100,150],['688001.SH','科创板',201,199]]) {
  test(`${label} ticket validates declared quantity and persists its exact fill`, async ({page,request}) => {
    const fixture=await startOrderTestServer(0,{tsCode:code});
    try {
      const response=await request.post(`${fixture.url}/api/quant/replay/sessions`,{data:{gameLength:20,interval:'hybrid'}});
      expect(response.status()).toBe(201);
      const {session}=await response.json();
      await page.route('**/api/**',async route=>{
        const original=new URL(route.request().url());
        await route.fulfill({response:await route.fetch({url:`${fixture.url}${original.pathname}${original.search}`})});
      });
      await page.addInitScript(id=>localStorage.setItem('investflow.replay.active-session-id',id),session.id);
      await page.goto(`${process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:5180'}/decision/market-replay?session=${session.id}`);
      await expect(page.getByText(`${label} · ${label==='科创板'?'200股起，可逐股递增':'买入100股整数倍'} · T+1`)).toBeVisible();
      await page.getByRole('button',{name:'买入',exact:true}).click();
      const form=page.getByRole('dialog',{name:'买入决策记录'});
      await form.getByText('回踩',{exact:true}).click();
      await form.getByLabel('核心判断').fill('验证板块申报数量规则和股数完整保存');
      await form.getByLabel('开仓与持有计划').fill('按有效数量买入并检查下一开盘成交');
      await form.getByLabel('风险计划').fill('低于防守价时持续退出已有持仓');
      await form.getByLabel('止损价',{exact:true}).fill('9.8');
      await form.getByRole('spinbutton',{name:'委托股数'}).fill(String(invalidQuantity));
      await expect(form.getByRole('button',{name:'提交买入委托',exact:true})).toBeDisabled();
      await form.getByRole('spinbutton',{name:'委托股数'}).fill(String(validQuantity));
      await expect(form.getByRole('button',{name:'提交买入委托',exact:true})).toBeEnabled();
      await form.getByRole('button',{name:'提交买入委托',exact:true}).click();
      await page.getByRole('button',{name:'推进 5 分钟',exact:true}).click();
      await expect(page.getByText(`${validQuantity} 股 · ¥10.11`)).toBeVisible();
      await expect(page.getByText(/已处理委托并推进|已推进5分钟/)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(`${validQuantity} 股 · ¥10.11`)).toBeVisible();
      const actual=await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json();
      expect(actual.session.account.positionQuantity).toBe(validQuantity);
      expect(actual.session.executionModelVersion).toBe('bar-orders-v2');
      expect(JSON.stringify(actual.session)).not.toContain(code);
    } finally { await fixture.close(); }
  });
}
