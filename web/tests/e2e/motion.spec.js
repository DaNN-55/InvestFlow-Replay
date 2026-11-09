import { expect, test } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
let fixture;
test.beforeAll(async () => { fixture = await startOrderTestServer(); });
test.afterAll(async () => { await fixture?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function connect(page, source = fixture) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${source.url}${url.pathname}${url.search}` }) });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function recordMotion(page) {
  await page.evaluate(() => {
    window.motionEvents = [];
    for (const type of ['transitionrun', 'animationstart']) {
      document.addEventListener(type, event => window.motionEvents.push({
        type, className: String(event.target.className), property: event.propertyName ?? event.animationName,
      }));
    }
  });
}

async function createPractice(request) {
  const response = await request.post(`${fixture.url}/api/quant/replay/sessions`, { data: { gameLength: 20, interval: '1d' } });
  expect(response.status()).toBe(201);
  return (await response.json()).session;
}

async function mutate(request, session, path, data = {}) {
  const response = await request.post(`${fixture.url}/api/quant/replay/sessions/${session.id}/${path}`, {
    data: { actionId: crypto.randomUUID(), expectedRevision: session.revision, ...data },
  });
  expect(response.status()).toBe(path === 'orders' ? 201 : 200);
  return (await response.json()).session;
}

async function fillBlind(review) {
  await review.getByRole('checkbox', { name: '回踩', exact: true }).check();
  await review.getByPlaceholder('你看到了什么，为什么做出这个判断？').fill('回踩支撑后等待确认');
  await review.getByPlaceholder('计划如何开仓、持有、减仓或空仓？').fill('按计划小仓观察行情');
  await review.getByPlaceholder('什么情况说明判断错误，如何控制损失？').fill('跌破支撑立即控制风险');
}

test('motion 1: dialogs and drawers animate, close inert, and support immediate reopening', async ({ page }) => {
  await connect(page);
  await page.goto(`${base}/decision/market-replay`);
  await recordMotion(page);
  const trigger = page.getByRole('button', { name: '调整资金与成本', exact: true });
  await trigger.click();
  const modal = page.getByRole('dialog', { name: '资金与成本', exact: true });
  await expect(modal.getByLabel('初始资金')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.motionEvents.some(e => e.className.includes('ql-motion-dialog') && e.property === 'transform'))).toBe(true);
  await modal.getByLabel('初始资金').fill('30000');
  await modal.getByRole('button', { name: '关闭弹窗' }).evaluate(el => el.click());
  const closing = page.locator('.ql-motion-dialog[data-state="closed"]');
  await expect(closing).toHaveAttribute('inert', '');
  await expect(closing).toHaveCSS('pointer-events', 'none');
  await expect(modal).toHaveCount(0);
  await trigger.click();
  await expect(modal.getByLabel('初始资金')).toHaveValue('30000');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.goto(`${base}/decision/trade-records`);
  await recordMotion(page);
  const create = page.getByRole('button', { name: '新建交易', exact: true });
  await create.click();
  const drawer = page.locator('.trade-record-create-drawer');
  await expect(drawer.getByLabel('股票代码或名称')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.motionEvents.some(e => e.className.includes('ql-motion-drawer') && e.property === 'transform'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await create.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');
});

test('motion 1: reduced motion keeps overlay controls immediate at narrow width', async ({ page }) => {
  await connect(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/decision/market-replay`);
  await page.getByRole('button', { name: '调整资金与成本', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '资金与成本' });
  await expect(modal).toHaveCSS('transition-duration', '0s');
  await expect(modal).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '日内模拟', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始日内模拟', exact: true })).toBeVisible();
});

test('motion 2: only a new execution highlights; restoring the same ledger does not', async ({ page, request }) => {
  await connect(page);
  let session = await createPractice(request);
  session = await mutate(request, session, 'orders', { side: 'buy', quantity: 100 });
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  const rows = page.locator('.replay-trading__execution');
  await expect(rows).toHaveCount(0);
  await page.locator('.replay-playback__steps button').first().click();
  await expect(rows.first()).toContainText('100 股');
  expect(await rows.first().evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-feedback'))).toBe(true);
  const current = (await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json()).session;
  expect(current.account.positionQuantity).toBe(100);
  await page.reload();
  await expect(rows.first()).toContainText('100 股');
  expect(await rows.first().evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-feedback'))).toBe(false);
});

test('motion 2: saving a real review draft acknowledges once without moving the input cursor', async ({ page, request }) => {
  await connect(page);
  const session = await mutate(request, await createPractice(request), 'finish');
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  await page.getByRole('button', { name: '填写揭晓前盲评', exact: true }).click();
  const review = page.getByRole('dialog', { name: '本次复盘', exact: true });
  await fillBlind(review);
  const input = review.getByPlaceholder('什么情况说明判断错误，如何控制损失？');
  await input.evaluate(el => el.setSelectionRange(3, 3));
  const status = review.locator('.replay-review__draft-status').first();
  await expect(status).toHaveText('已自动保存');
  expect(await status.evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-feedback'))).toBe(true);
  expect(await input.evaluate(el => [document.activeElement === el, el.selectionStart])).toEqual([true, 3]);
  const saved = (await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json()).session;
  expect(saved.reviewDrafts.blind.data.thesis).toBe('回踩支撑后等待确认');
});

test('motion 3: freezing and scoring a review preserves the first judgment through reload', async ({ page, request }) => {
  await connect(page);
  const session = await mutate(request, await createPractice(request), 'finish');
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  await page.getByRole('button', { name: '填写揭晓前盲评', exact: true }).click();
  const review = page.getByRole('dialog', { name: '本次复盘', exact: true });
  await fillBlind(review);
  await review.getByRole('button', { name: '保存并冻结整局盲评', exact: true }).click();
  await expect(review.getByRole('heading', { name: '原始盲评已锁定', exact: true })).toBeVisible();
  expect(await review.locator('.replay-review').evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-phase'))).toBe(true);
  await review.getByRole('button', { name: '揭晓行情', exact: true }).click();
  await review.getByPlaceholder('实际执行和原计划有哪些一致或偏离？').fill('按原计划观察没有盲目操作');
  await review.getByPlaceholder('没有明显错误时可填写“无”').fill('无');
  await review.getByPlaceholder('下一次遇到类似行情，你会保留或改变什么？').fill('继续等待确认再考虑开仓');
  await review.getByRole('button', { name: '提交复盘并评分', exact: true }).click();
  await expect(review.getByRole('heading', { name: '原始事后复盘已锁定', exact: true })).toBeVisible();
  const saved = (await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json()).session;
  expect(saved.review.blindReview.thesis).toBe('回踩支撑后等待确认');
  expect(saved.scoreCard.total).toBeGreaterThanOrEqual(0);
  await page.reload();
  await page.getByRole('button', { name: '查看复盘', exact: true }).click();
  await expect(review).toContainText('回踩支撑后等待确认');
  expect((await (await request.get(`${fixture.url}/api/quant/replay/sessions/${session.id}`)).json()).session.scoreCard).toEqual(saved.scoreCard);
});

test('motion 3: crypto review advances through blind, reveal and post without animating live amounts', async ({ page, request }) => {
  const cryptoFixture = await startCryptoTestServer();
  try {
    await connect(page, cryptoFixture);
    const created = await request.post(`${cryptoFixture.url}/api/quant/replay/sessions`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
    let session = (await created.json()).session;
    const finished = await request.post(`${cryptoFixture.url}/api/quant/replay/sessions/${session.id}/finish`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision } });
    expect(finished.status()).toBe(200);
    session = (await finished.json()).session;
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    const review = page.getByRole('region', { name: '合约复盘', exact: true });
    await review.evaluate(element => {
      const animate = element.animate;
      element.phaseAnimations = [];
      element.animate = function (...args) {
        const animation = animate.apply(this, args);
        this.phaseAnimations.push(animation);
        return animation;
      };
    });
    await review.getByLabel('盲评判断', { exact: true }).fill('等待价格回踩支撑位置');
    await review.getByLabel('盲评交易计划', { exact: true }).fill('控制风险暂时保持空仓');
    await review.getByRole('button', { name: '保存盲评', exact: true }).click();
    await expect(review.getByRole('button', { name: '揭晓完整行情', exact: true })).toBeVisible();
    expect(await review.evaluate(el => el.phaseAnimations.some(a => a.id === 'ql-motion-phase'))).toBe(true);
    await review.getByRole('button', { name: '揭晓完整行情', exact: true }).click();
    await review.getByLabel('复盘观察', { exact: true }).fill('行情尚未符合预定条件');
    await review.getByLabel('执行偏差', { exact: true }).fill('空仓观察符合原定计划');
    await review.getByLabel('下次行动', { exact: true }).fill('继续坚持等待条件满足');
    await review.getByRole('button', { name: '保存事后复盘', exact: true }).click();
    await expect(review.getByRole('button', { name: '按原版本复练', exact: true })).toBeVisible();
    expect(await page.getByTestId('crypto-net-pnl').evaluate(el => el.getAnimations().length)).toBe(0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await cryptoFixture.close(); }
});

test('motion 4: action menus and indicator menus keep their anchor and disable closing contents', async ({ page, request }) => {
  await connect(page);
  const session = await createPractice(request);
  await page.goto(`${base}/decision/trade-records?tab=replay&session=${session.id}`);
  const trigger = page.getByRole('button', { name: '演练记录操作', exact: true });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const rect = await menu.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  const summary = page.getByLabel('选择主图指标', { exact: true });
  await summary.click();
  const indicators = page.getByRole('group', { name: '主图指标', exact: true });
  await expect(indicators.getByText('MA', { exact: true })).toBeVisible();
  expect(await indicators.evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-disclosure-popover'))).toBe(true);
  await summary.click();
  await expect(indicators).toHaveAttribute('inert', '');
  await expect(indicators).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(indicators).toBeVisible();
});

test('motion 4: crypto data and layout popovers, plus tooltip, remain usable on narrow screens', async ({ page, request }) => {
  const source = await startCryptoTestServer();
  try {
    await connect(page, source);
    const response = await request.post(`${source.url}/api/quant/replay/sessions`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
    const { session } = await response.json();
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    await recordMotion(page);
    const dataTrigger = page.getByRole('button', { name: '合约行情数据', exact: true });
    await dataTrigger.click();
    await expect(page.getByRole('region', { name: '行情数据', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.motionEvents.some(e => e.className.includes('crypto-data-panel') && e.property === 'transform'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#crypto-data-panel')).toHaveCount(0);
    await page.getByRole('button', { name: '图表布局与联动', exact: true }).click();
    await expect(page.getByRole('button', { name: '四图', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '收起布局设置', exact: true }).click();
    await expect(page.locator('.crypto-layout-menu')).toHaveCount(0);
    await page.getByRole('button', { name: '回放操作说明', exact: true }).click();
    await expect(page.locator('.ui-tooltip__content')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ui-tooltip__content')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await dataTrigger.click();
    expect(await page.locator('#crypto-data-panel').evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

test('motion 5: short details animate their actual height and reverse without leaving a fixed height', async ({ page, request }) => {
  await connect(page);
  const created = await request.post(`${fixture.url}/api/quant/replay/playbooks`, { data: { name: '折叠动效验证', content: '等待支撑确认再开仓，跌破支撑控制风险。', changeSummary: '首次规则' } });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/decision/trade-records?tab=playbooks`);
  await page.getByRole('button').filter({ hasText: '折叠动效验证' }).first().click();
  const details = page.locator('.replay-playbook-detail__version details').first();
  const summary = details.locator('summary');
  await summary.click();
  expect(await details.evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-disclosure-short'))).toBe(true);
  await expect(details.locator('pre')).toBeVisible();
  await summary.evaluate(async el => {
    el.click(); await new Promise(resolve => setTimeout(resolve, 35));
    el.click(); await new Promise(resolve => setTimeout(resolve, 35));
    el.click();
  });
  await expect(details).not.toHaveAttribute('open');
  expect(await details.evaluate(el => [el.style.height, el.style.overflow])).toEqual(['', '']);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details.locator('pre')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('motion 5: long crypto ledgers appear without height interpolation and reduced motion stays immediate', async ({ page, request }) => {
  const source = await startCryptoTestServer();
  try {
    await connect(page, source);
    const created = await request.post(`${source.url}/api/quant/replay/sessions`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
    const { session } = await created.json();
    await request.post(`${source.url}/api/quant/replay/sessions/${session.id}/finish`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision } });
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    const ledger = page.locator('.crypto-review details').filter({ has: page.locator('summary').filter({ hasText: '资金账本' }) });
    await ledger.locator('summary').click();
    await expect(ledger.locator('table')).toBeVisible();
    const animations = await ledger.evaluate(el => el.getAnimations({ subtree: true }).map(a => ({ id: a.id, frames: a.effect.getKeyframes() })));
    expect(animations.some(a => a.id === 'ql-motion-disclosure-long')).toBe(true);
    expect(animations.some(a => a.frames.some(frame => 'height' in frame))).toBe(false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ledger.locator('summary').click();
    await expect(ledger).not.toHaveAttribute('open');
    await ledger.locator('summary').click();
    await expect(ledger.locator('table')).toBeVisible();
    expect(await ledger.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

test('motion 6: tab marker follows rapid selections and native content changes immediately', async ({ page, request }) => {
  await connect(page);
  await createPractice(request);
  await createPractice(request);
  await page.goto(`${base}/decision/trade-records`);
  const tabs = page.getByRole('navigation', { name: '交易追踪分类' });
  const marker = tabs.locator('.ql-motion-tab-indicator');
  await expect(marker).toHaveCount(1);
  await tabs.getByRole('button', { name: '演练记录', exact: true }).click();
  await expect(tabs.getByRole('button', { name: '演练记录', exact: true })).toHaveAttribute('data-motion-active', 'true');
  await expect(page.locator('.replay-history-list__items')).toBeVisible();
  const items = page.locator('.replay-history-list__item');
  await items.nth(1).click();
  await expect(items.nth(1)).toHaveClass(/--selected/);
  const detail = page.locator('.replay-history-detail');
  await expect(detail).toBeVisible();
  expect(await detail.evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-detail'))).toBe(true);
  await tabs.evaluate(async el => {
    const buttons = el.querySelectorAll('button');
    buttons[2].click(); await new Promise(resolve => setTimeout(resolve, 35));
    buttons[0].click(); await new Promise(resolve => setTimeout(resolve, 35));
    buttons[1].click();
  });
  await expect(tabs.getByRole('button', { name: '演练记录', exact: true })).toHaveAttribute('data-motion-active', 'true');
  await expect.poll(() => marker.evaluate(el => {
    const active = el.parentElement.querySelector('[data-motion-active="true"]');
    return Math.abs(el.getBoundingClientRect().left - active.getBoundingClientRect().left) < 1;
  })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => marker.evaluate(el => {
    const active = el.parentElement.querySelector('[data-motion-active="true"]');
    return Math.abs(el.getBoundingClientRect().width - active.getBoundingClientRect().width) < 1;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('motion 6: crypto position tabs retain selection and immediate empty states with reduced motion', async ({ page, request }) => {
  const source = await startCryptoTestServer();
  try {
    await connect(page, source);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const created = await request.post(`${source.url}/api/quant/replay/sessions`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
    const { session } = await created.json();
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    const tabs = page.getByRole('navigation', { name: '本局交易信息' });
    await tabs.getByRole('button', { name: /^当前委托/ }).click();
    await expect(page.getByText('暂无待成交委托。', { exact: true })).toBeVisible();
    await tabs.getByRole('button', { name: '成交', exact: true }).click();
    await expect(page.getByText('暂无成交。', { exact: true })).toBeVisible();
    await expect(tabs.locator('.ql-motion-tab-indicator')).toHaveCSS('transition-duration', '0s');
    await expect(tabs.getByRole('button', { name: '成交', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

test('motion 7: real indicator panes fade without interpolating canvas height or moving order panels', async ({ page, request }) => {
  await connect(page);
  const session = await createPractice(request);
  await page.goto(`${base}/decision/market-replay?session=${session.id}`);
  const host = page.getByTestId('replay-klinecharts-host').first();
  await expect(host.locator('canvas').first()).toBeVisible();
  const height = (await host.boundingBox()).height;
  await page.getByLabel('选择副图指标', { exact: true }).click();
  await page.getByRole('group', { name: '副图指标', exact: true }).getByLabel('KDJ', { exact: true }).check();
  await expect(host).toHaveCSS('transition-duration', '0s');
  expect((await host.boundingBox()).height).toBeGreaterThan(height);
  const pane = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => /\/klinecharts\.js\?v=/.test(entry.name)).name;
    const { init } = await import(url);
    const chart = init({ id: document.querySelector('[k-line-chart-id]').getAttribute('k-line-chart-id') });
    const pane = chart.getDom('replay-builtin-kdj');
    return { exists: Boolean(pane), animations: pane?.getAnimations().map(a => ({ id: a.id, frames: a.effect.getKeyframes() })), count: chart.getDataList().length };
  });
  expect(pane.exists).toBe(true);
  expect(pane.animations.some(a => a.id === 'ql-motion-surface')).toBe(true);
  expect(pane.count).toBe(session.bars.length);
  await page.getByLabel('选择副图指标', { exact: true }).click();
  await page.getByRole('button', { name: '买入', exact: true }).click();
  const order = page.getByRole('dialog', { name: '买入决策记录' });
  await expect(order).toHaveCSS('transform', 'none');
  await order.getByLabel('核心判断').fill('等待支撑位置确认');
  await order.getByRole('button', { name: '关闭决策面板', exact: true }).click();
  await expect(order).toHaveCount(0);
  await page.getByRole('button', { name: '买入', exact: true }).click();
  await expect(order.getByLabel('核心判断')).toHaveValue('等待支撑位置确认');
  await page.setViewportSize({ width: 390, height: 844 });
  await order.evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await order.screenshot({ path: test.info().outputPath('motion-ashare-order-mobile.png') });
});

test('motion 7: multi-chart layout resizes immediately and preserves the original native chart', async ({ page, request }) => {
  const source = await startCryptoTestServer();
  try {
    await connect(page, source);
    const created = await request.post(`${source.url}/api/quant/replay/sessions`, { data: { market: 'crypto-perpetual', instrumentId: 'BTC-USDT-SWAP', actionId: crypto.randomUUID() } });
    const { session } = await created.json();
    await page.goto(`${base}/decision/crypto-replay?session=${session.id}`);
    await page.getByRole('button', { name: '图表布局与联动', exact: true }).click();
    await page.getByRole('button', { name: '单图', exact: true }).click();
    const native = page.locator('.crypto-chart-tile [k-line-chart-id]').first();
    await expect(native).toBeVisible();
    const originalId = await native.getAttribute('k-line-chart-id');
    await page.getByRole('button', { name: '四图', exact: true }).click();
    await expect(page.locator('.crypto-chart-tile')).toHaveCount(4);
    expect(await native.getAttribute('k-line-chart-id')).toBe(originalId);
    expect(await page.locator('.crypto-chart-tile').nth(1).evaluate(el => el.getAnimations().some(a => a.id === 'ql-motion-surface'))).toBe(true);
    await expect(page.getByTestId('replay-klinecharts-host').first()).toHaveCSS('transition-duration', '0s');
    await page.getByRole('button', { name: '收起布局设置', exact: true }).click();
    await expect(page.locator('.crypto-layout-menu')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('motion-crypto-four-pane-mobile.png'), fullPage: true });
  } finally { await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});
