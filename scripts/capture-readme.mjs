// Capture the real UI with isolated demo data and an unusable example QR.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MockEngine } from '../src/engine.mjs';
import { makeServer } from '../src/server.mjs';

const { chromium } = await import(process.env.PI_BROWSER_MODULE || '/tmp/pi-backend-browser/node_modules/playwright-core/index.mjs');
const directory = mkdtempSync(join(tmpdir(), 'pi-readme-demo-'));
const store = new Store(directory), spaces = new Map();
const password = 'Documentation-demo-password-only';
let origin, app, browser;
const silverbullet = {
  view: id => spaces.get(id) || { status: 'not_provisioned' }, tools: () => undefined,
  async setUnifiedLogin(user) {
    spaces.set(user.id, { status: 'ready', username: user.username, passwordUnified: true, url: origin + '/users/' + user.id + '/' });
    return this.view(user.id);
  },
  async close() {},
};
try {
  app = await makeServer({ store, engine: new MockEngine(), adminPassword: password, basePath: '/assistant', silverbullet,
    wechatClient: { qr: async () => ({ qrcode: 'documentation-demo-only', qrcode_img_content: 'https://example.org/pi-assistant-demo' }), status: async () => ({ status: 'wait' }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + app.server.address().port;
  const base = origin + '/assistant/';
  browser = await chromium.launch({ executablePath: process.env.PI_BROWSER_BINARY, args: ['--no-sandbox'] });
  const output = process.env.PI_SCREENSHOT_DIR || '/tmp/pi-readme-images'; mkdirSync(output, { recursive: true });
  const admin = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await admin.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-form button').click(); await page.locator('#console').waitFor({ state: 'visible' });
  const inviteResponse = await admin.request.post(base + 'api/admin/invites', { data: {} }); assert.equal(inviteResponse.status(), 201);
  const invite = await inviteResponse.json();
  const member = await browser.newContext({ viewport: { width: 1100, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const personal = await member.newPage(); personal.on('pageerror', error => errors.push(error.message));
  await personal.goto(base + 'join#invite=' + invite.token);
  await personal.locator('#register').waitFor({ state: 'visible' });
  await personal.screenshot({ path: join(output, 'invitation.png'), fullPage: true });
  await personal.locator('#register-form input[name=username]').fill('demo_alice');
  await personal.locator('#register-form input[name=password]').fill(password);
  await personal.locator('#register-form input[name=passwordConfirm]').fill(password);
  await personal.locator('#register-form button').click(); await personal.locator('#account').waitFor({ state: 'visible' });
  await personal.locator('#notes-link').waitFor({ state: 'visible' });
  await personal.screenshot({ path: join(output, 'account.png'), fullPage: true });
  await personal.locator('[data-panel=persona]').click();
  assert.match(await personal.locator('#agents-content').inputValue(), /自然朋友/);
  await personal.screenshot({ path: join(output, 'persona.png'), fullPage: true });
  await personal.locator('[data-panel=connections]').click(); await personal.setViewportSize({ width: 420, height: 960 });
  await personal.locator('#wechat-bind').click();
  await personal.waitForFunction(() => document.querySelector('#qr-image').naturalWidth > 0);
  assert.equal(await personal.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await personal.screenshot({ path: join(output, 'wechat-connect.png'), fullPage: true });
  await personal.locator('#qr-cancel').click();
  assert.equal((await admin.request.post(base + 'api/admin/users', { data: { username: 'demo_bob', password } })).status(), 201);
  await page.locator('#refresh-users').click();
  await page.getByText('demo_bob', { exact: true }).waitFor();
  assert.equal(await page.locator('#invite-result').isVisible(), false);
  await page.screenshot({ path: join(output, 'admin.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ demoScreenshots: 5, realUi: true, productionDataUsed: false, usableWechatQr: false, javascriptErrors: 0 }));
} finally {
  await browser?.close();
  if (app) await app.close(); else store.close();
  rmSync(directory, { recursive: true, force: true });
}
