import { expect, test } from '@playwright/test';
import { startOrderTestServer } from '../../../backend/src/test-support/order-server.js';
import { startCryptoTestServer } from '../../../backend/src/test-support/crypto-server.js';

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5180';
const sessionsPath = '/api/quant/replay/sessions';
let ashare, cryptoFixture;
test.beforeAll(async () => {
  ashare = await startOrderTestServer();
  cryptoFixture = await startCryptoTestServer();
});
test.afterAll(async () => { await ashare?.close(); await cryptoFixture?.close(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function connect(page, fixture) {
  const requests = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    await route.fulfill({ response: await route.fetch({ url: `${fixture.url}${url.pathname}${url.search}` }) });
  });
  return requests;
}

for (const market of ['ashare', 'crypto-perpetual']) {
  test(`${market} opens home with a saved session and resumes only on request`, async ({ page, request }) => {
    const fixture = market === 'ashare' ? ashare : cryptoFixture;
    const response = await request.post(`${fixture.url}${sessionsPath}`, { data: market === 'ashare'
      ? { gameLength: 20, interval: 'hybrid' }
      : { market, actionId: globalThis.crypto.randomUUID(), instrumentId: 'BTC-USDT-SWAP' } });
    expect(response.status()).toBe(201);
    const { session } = await response.json();
    const key = market === 'ashare' ? 'investflow.replay.active-session-id' : 'investflow-crypto-attempt-v1';
    const stored = market === 'ashare' ? session.id : JSON.stringify({ sessionId: session.id });
    await page.addInitScript(({ key, stored }) => localStorage.setItem(key, stored), { key, stored });
    const requests = await connect(page, fixture);
    const url = `${base}/decision/${market === 'ashare' ? 'market-replay' : 'crypto-replay'}`;
    await page.goto(url);
    await expect(page.getByRole('heading', { name: '这次怎么练？', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续上次练习', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '这次怎么练？', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续上次练习', exact: true })).toBeVisible();
    expect(requests.filter(r => r.path === `${sessionsPath}/${session.id}`)).toEqual([]);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(stored);
    await page.getByRole('button', { name: '继续上次练习', exact: true }).click();
    await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
    expect(requests.some(r => r.path === `${sessionsPath}/${session.id}`)).toBe(true);
    await page.goto(`${url}?session=${session.id}`);
    await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
  });
}

test('crypto home preserves a pending action and retries its exact body only after a click', async ({ page, request }) => {
  const response = await request.post(`${cryptoFixture.url}${sessionsPath}`, {
    data: { market: 'crypto-perpetual', actionId: globalThis.crypto.randomUUID(), instrumentId: 'BTC-USDT-SWAP' },
  });
  const { session } = await response.json();
  const pending = { kind: 'advance', id: session.id, body: { actionId: globalThis.crypto.randomUUID(), expectedRevision: session.revision, minutes: 1 } };
  await page.addInitScript(saved => localStorage.setItem('investflow-crypto-attempt-v1', JSON.stringify(saved)), { sessionId: session.id, pending });
  const requests = await connect(page, cryptoFixture);
  await page.goto(`${base}/decision/crypto-replay`);
  await expect(page.getByRole('heading', { name: '这次怎么练？', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试原动作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始合约盲测', exact: true })).toBeDisabled();
  expect(requests.filter(r => r.method === 'POST')).toEqual([]);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')))).pending).toEqual(pending);
  await page.getByRole('button', { name: '重试原动作', exact: true }).click();
  await expect(page.getByRole('region', { name: '回放控制', exact: true })).toBeVisible();
  expect(requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([pending.body]);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('investflow-crypto-attempt-v1')))).pending).toBeNull();
});
