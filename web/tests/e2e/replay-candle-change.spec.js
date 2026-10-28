import { test, expect } from '@playwright/test';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
for (const period of ['day', 'minute']) for (const theme of ['light', 'dark']) {
  test(`${period} ${theme} native candle tooltip draws bold red gains and green losses`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript(theme => {
      localStorage.setItem('investflow-replay-theme', theme);
      const fill = CanvasRenderingContext2D.prototype.fillText;
      window.tooltipDraws = [];
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (/^[+-]?\d+\.\d+%$/.test(String(text)) || text === '--') window.tooltipDraws.push({ text, color: this.fillStyle, font: this.font });
        return fill.call(this, text, ...args);
      };
    }, theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${base}/decision/crypto-replay`);
    await expect(page.getByRole('heading', { name: '这次怎么练？', exact: true })).toBeVisible();
    await page.evaluate(async ({ period, theme }) => {
      const vueUrl = performance.getEntriesByType('resource').find(entry => /\/vue\.js\?v=/.test(entry.name)).name;
      const { createApp, h } = await import(vueUrl), { default: Chart } = await import('/src/components/CandlestickChart.vue');
      const root = document.createElement('div'); root.id = 'candle-change-proof';
      root.style.cssText = `position:fixed;z-index:10000;top:60px;left:20px;width:950px;padding:16px;background:${theme === 'light' ? '#fff' : '#111827'}`;
      document.body.append(root);
      const bars = Array.from({ length: 80 }, (_, index) => {
        const close = [100, 110, 99, 99][index % 4];
        return { period, datetime: `第${index + 1}根`, startSequence: index, endSequence: index, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
      });
      window.candleChangeApp = createApp({ render: () => h(Chart, { bars, height: 500, compact: period === 'minute' }) });
      window.candleChangeApp.mount(root);
    }, { period, theme });
    await expect(page.locator('#candle-change-proof [k-line-chart-id]')).toBeVisible();
    for (const [index, text, color] of [[77, '+10.00%', '#df7180'], [78, '-10.00%', '#38ae86'], [79, '0.00%', null], [0, '--', null]]) {
      const point = await page.evaluate(async index => {
        const url = performance.getEntriesByType('resource').find(entry => /\/klinecharts\.js\?v=/.test(entry.name)).name;
        const { init } = await import(url), chart = init({ id: document.querySelector('#candle-change-proof [k-line-chart-id]').getAttribute('k-line-chart-id') });
        if (index === 0) { chart.setBarSpace(6); chart.scrollToRealTime(0); }
        const box = chart.getDom('candle_pane', 'main').getBoundingClientRect();
        const pixel = chart.convertToPixel({ dataIndex: index, value: chart.getDataList()[index].close }, { paneId: 'candle_pane' });
        window.tooltipDraws = [];
        return { x: box.x + pixel.x, y: box.y + pixel.y };
      }, index);
      await page.mouse.move(point.x, point.y);
      await expect.poll(() => page.evaluate(text => window.tooltipDraws.some(row => row.text === text), text)).toBe(true);
      const rendered = await page.evaluate(text => window.tooltipDraws.find(row => row.text === text), text);
      expect(rendered.font).toMatch(/bold|700/);
      if (color) expect(rendered.color).toBe(color);
      else expect(['#df7180', '#38ae86']).not.toContain(rendered.color);
      if (index === 78 && process.env.CANDLE_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.CANDLE_EVIDENCE_DIR}/${period}-${theme}.png` });
    }
    await page.evaluate(() => { window.candleChangeApp.unmount(); document.getElementById('candle-change-proof').remove(); });
    await page.unrouteAll({ behavior: 'wait' });
  });
}
