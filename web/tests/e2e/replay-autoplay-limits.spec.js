import { test, expect } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';

for (const [status, price, limitType] of [['limit_up', 11, 'U'], ['limit_down', 9, 'D']]) {
  test(`hybrid autoplay continues and restarts at ${status} without changing order execution`, async ({ page, request }) => {
    const fixture = await startOrderTestServer(0, { futureBarOverrides: Array.from({ length: 4 }, () => ({ open: price, high: price, low: price, close: price, preClose: 10, limitType, pctChange: (price - 10) * 10 })) });
    const advances = [];
    try {
      const path = '/api/quant/replay/sessions';
      const created = await request.post(`${fixture.url}${path}`, { data: { gameLength: 20, interval: 'hybrid' } });
      expect(created.status()).toBe(201); const { session } = await created.json();
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` });
        if (url.pathname.endsWith('/advance')) advances.push({ body: route.request().postDataJSON(), response: await response.json() });
        await route.fulfill({ response });
      });
      await page.goto(`${process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180'}/decision/market-replay?session=${session.id}`);
      const panel = page.getByRole('region', { name: '回放控制', exact: true });
      const play = panel.getByRole('button', { name: '自动播放', exact: true }), pause = panel.getByRole('button', { name: '暂停', exact: true });
      await expect(play).toBeEnabled(); await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
      await panel.getByRole('combobox', { name: '自动播放速度' }).selectOption('2'); await play.click();
      for (const count of [1, 2]) {
        await page.clock.runFor(550); await expect.poll(() => advances.length).toBe(count);
        expect(advances.at(-1).response.session.marketEvent.status).toBe(status);
        await expect(pause).toBeVisible(); await expect(panel.getByRole('status')).toHaveText('自动播放中 · 2×');
      }
      await pause.click(); await expect(play).toBeVisible(); await play.click(); await expect(pause).toBeVisible();
      await page.clock.runFor(550); await expect.poll(() => advances.length).toBe(3); await pause.click();
      await page.clock.runFor(2000); expect(advances).toHaveLength(3);
      expect(advances.map(item => item.body.mode)).toEqual(['minute', 'minute', 'minute']);
      expect(advances.map(item => item.body.expectedRevision)).toEqual([session.revision, session.revision + 1, session.revision + 2]);
      const latest = (await (await request.get(`${fixture.url}${path}/${session.id}`)).json()).session;
      expect(latest.revision).toBe(session.revision + 3); expect(latest.executions).toHaveLength(0); expect(latest.account).toEqual(session.account);
      await panel.screenshot({ path: test.info().outputPath(`${status}-paused-after-three-steps.png`) });
    } finally { await page.unrouteAll({ behavior: 'wait' }); await fixture.close(); }
  });
}
