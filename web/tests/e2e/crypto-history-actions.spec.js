import { expect, test } from '@playwright/test';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const sessions = '/api/quant/replay/sessions';
const storageKey = 'investflow-crypto-attempt-v1';
let fixture;
test.beforeAll(async () => { fixture = await startCryptoTestServer(); });
test.afterAll(async () => { await fixture?.close(); });

async function create(request, { revealed = false } = {}) {
  const response = await request.post(`${fixture.url}${sessions}`, { data: { market: 'crypto-perpetual', actionId: crypto.randomUUID(), instrumentId: 'BTC-USDT-SWAP' } });
  expect(response.status()).toBe(201);
  let { session } = await response.json();
  if (revealed) {
    for (const [suffix, body] of [['finish', {}], ['reviews/blind', { review: { thesis: '保留本次观察', tradePlan: '等待条件后再下单' } }], ['reveal', {}]]) {
      const result = await request.post(`${fixture.url}${sessions}/${session.id}/${suffix}`, { data: { actionId: crypto.randomUUID(), expectedRevision: session.revision, ...body } });
      expect(result.ok()).toBe(true); session = (await result.json()).session;
    }
  }
  return session;
}
async function openHistory(page, session, saved) {
  if (saved) await page.addInitScript(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: storageKey, saved });
  const calls = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    calls.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    if (!url.pathname.startsWith(sessions) && !url.pathname.endsWith('/crypto-pool')) return route.fulfill({ json: {} });
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
  await page.goto(`${base}/decision/trade-records?tab=replay&market=crypto-perpetual&session=${session.id}`);
  await expect(page.locator('.crypto-history-detail > header h2')).toHaveText(session.instrumentId);
  return calls;
}
const actions = page => page.getByRole('button', { name: '演练记录操作', exact: true });
const menuItem = (page, name) => page.getByRole('button', { name, exact: true });

test('the existing delete HTTP endpoint accepts a crypto record', async ({ request }) => {
  const session = await create(request);
  const result = await request.delete(`${fixture.url}${sessions}/${session.id}`);
  expect(result.status()).toBe(200);
  expect((await request.get(`${fixture.url}${sessions}/${session.id}`)).status()).toBe(404);
});

test('crypto history offers the A-share action menu and confirms deletion once', async ({ page, request }) => {
  const session = await create(request);
  const calls = await openHistory(page, session, { sessionId: session.id, pending: null });
  await expect(actions(page)).toBeVisible({ timeout: 1500 });
  await actions(page).click();
  await expect(menuItem(page, '打开演练')).toBeVisible();
  await expect(menuItem(page, '复练此行情')).toHaveCount(0);
  await menuItem(page, '删除记录').click();
  const dialog = page.getByRole('dialog', { name: '删除演练记录', exact: true });
  await expect(dialog).toContainText(session.instrumentId);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
  expect((await request.get(`${fixture.url}${sessions}/${session.id}`)).status()).toBe(200);
  await actions(page).click(); await menuItem(page, '删除记录').click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click({ clickCount: 2 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('.crypto-history-detail')).toHaveCount(0);
  expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
  expect((await request.get(`${fixture.url}${sessions}/${session.id}`)).status()).toBe(404);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await page.reload(); await expect(page.locator('.crypto-history-detail')).toHaveCount(0);
});

test('a failed deletion stays visible and can be retried without changing another pending action', async ({ page, request }) => {
  const session = await create(request);
  const saved = { sessionId: 'another-practice', pending: { kind: 'advance', id: 'another-practice', body: { actionId: 'keep-me', expectedRevision: 7, minutes: 1 } } };
  await openHistory(page, session, saved);
  let attempts = 0;
  await page.route(`**${sessions}/${session.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: { message: '临时删除失败' } } });
    return route.fallback();
  });
  await actions(page).click(); await menuItem(page, '删除记录').click();
  const dialog = page.getByRole('dialog', { name: '删除演练记录', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toContainText('临时删除失败');
  expect((await request.get(`${fixture.url}${sessions}/${session.id}`)).status()).toBe(200);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toBeHidden(); expect(attempts).toBe(2);
  expect((await request.get(`${fixture.url}${sessions}/${session.id}`)).status()).toBe(404);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey)).toEqual(saved);
});

test('crypto history opens its own market and the menu fits desktop and narrow screens', async ({ page, request }) => {
  const session = await create(request);
  const calls = await openHistory(page, session);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await actions(page).click();
    const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    const trigger = await actions(page).boundingBox(), header = await page.locator('.crypto-history-detail > header').boundingBox();
    expect(trigger.y - header.y).toBeLessThan(20); expect(trigger.x + trigger.width).toBeGreaterThan(header.x + header.width - 24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`menu-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(actions(page)).toBeFocused();
  }
  await actions(page).click(); await menuItem(page, '打开演练').click();
  await expect(page).toHaveURL(`${base}/decision/crypto-replay?session=${session.id}`);
  await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
});

test('revealed crypto history retrains once with a durable action and opens the child in crypto', async ({ page, request }) => {
  const session = await create(request, { revealed: true });
  const calls = await openHistory(page, session);
  await actions(page).click(); await menuItem(page, '复练此行情').click({ clickCount: 2 });
  await expect(page).toHaveURL(/\/decision\/crypto-replay\?session=/);
  await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
  const posts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/retrain'));
  expect(posts).toHaveLength(1); expect(posts[0].body.actionId).toBeTruthy(); expect(posts[0].body.expectedRevision).toBe(session.revision);
  const childId = new URL(page.url()).searchParams.get('session'); expect(childId).not.toBe(session.id);
  const child = (await (await request.get(`${fixture.url}${sessions}/${childId}`)).json()).session;
  expect(child.attemptInfo.kind).toBe('retrain'); expect(child.attemptInfo.sourceSessionId).toBe(session.id);
  expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey))).toEqual({ sessionId: childId, pending: null });
});

test('history refuses a new retrain while preserving the exact outstanding crypto action', async ({ page, request }) => {
  const session = await create(request, { revealed: true });
  const saved = { sessionId: 'another-practice', pending: { kind: 'advance', id: 'another-practice', body: { actionId: 'original-action', expectedRevision: 9, minutes: 5 } } };
  const calls = await openHistory(page, session, saved);
  await actions(page).click(); await menuItem(page, '复练此行情').click();
  await expect(page.locator('.crypto-history-detail [role="alert"]')).toContainText('结果待确认');
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey)).toEqual(saved);
});

test('a lost retrain response can be recovered through the practice using the same action', async ({ page, request }) => {
  const session = await create(request, { revealed: true });
  const calls = await openHistory(page, session);
  // Return through SPA navigation so the practice controller stays cached.
  await actions(page).click(); await menuItem(page, '打开演练').click();
  await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '交易追踪', exact: true }).click();
  await page.getByLabel('交易追踪分类', { exact: true }).getByRole('button', { name: '演练记录', exact: true }).click();
  await expect(page.locator('.crypto-history-detail > header h2')).toHaveText(session.instrumentId);
  let committedChild;
  await page.route(`**${sessions}/${session.id}/retrain`, async route => {
    calls.push({ method: 'POST', path: `${sessions}/${session.id}/retrain`, body: route.request().postDataJSON() });
    const response = await route.fetch({ url: `${fixture.url}${sessions}/${session.id}/retrain` });
    committedChild = (await response.json()).session.id;
    await route.abort('failed');
  }, { times: 1 });
  await actions(page).click(); await menuItem(page, '复练此行情').click();
  await expect(page.locator('.crypto-history-detail [role="alert"]')).toContainText('复练结果待确认');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  expect(saved.pending.kind).toBe('retrain'); expect(saved.pending.id).toBe(session.id);
  expect(saved.pending.body).toEqual(calls.find(c => c.method === 'POST' && c.path.endsWith('/retrain')).body);
  await page.keyboard.press('Escape');
  await actions(page).click(); await menuItem(page, '打开演练').click();
  await expect(page.getByRole('button', { name: '重试原动作', exact: true })).toBeVisible({ timeout: 2000 });
  await page.getByRole('button', { name: '重试原动作', exact: true }).click();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key))?.pending, storageKey)).toBeNull();
  const restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  expect(restored).toEqual({ sessionId: committedChild, pending: null });
  await expect(page).toHaveURL(`${base}/decision/crypto-replay?session=${committedChild}`);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  const retrains = calls.filter(c => c.method === 'POST' && c.path.endsWith('/retrain'));
  expect(retrains).toHaveLength(2); expect(retrains[1].body).toEqual(retrains[0].body);
});

test('a committed retrain with a failed first read opens that child instead of creating another attempt', async ({ page, request }) => {
  const session = await create(request, { revealed: true });
  const calls = await openHistory(page, session);
  let childId, failedRead = false;
  await page.route(`**${sessions}/${session.id}/retrain`, async route => {
    calls.push({ method: 'POST', path: `${sessions}/${session.id}/retrain`, body: route.request().postDataJSON() });
    const response = await route.fetch({ url: `${fixture.url}${sessions}/${session.id}/retrain` });
    childId = (await response.json()).session.id;
    await route.fulfill({ response });
  });
  await page.route('**/market?**', async route => {
    if (childId && route.request().url().includes(childId) && !failedRead) {
      failedRead = true; return route.abort('failed');
    }
    return route.fallback();
  });
  await actions(page).click(); await menuItem(page, '复练此行情').click();
  await expect(page).toHaveURL(/\/decision\/crypto-replay\?session=/);
  expect(new URL(page.url()).searchParams.get('session')).toBe(childId);
  await expect(page.getByRole('button', { name: '推进 1 分钟', exact: true })).toBeEnabled();
  expect(failedRead).toBe(true);
  expect(calls.filter(c => c.method === 'POST' && c.path.endsWith('/retrain'))).toHaveLength(1);
});
