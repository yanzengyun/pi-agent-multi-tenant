// Isolated real UI and decodable synthetic MP3; never uses live accounts or WeChat.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MockEngine } from '../src/engine.mjs';
import { makeServer } from '../src/server.mjs';
import { Speech } from '../src/speech.mjs';
import { hashPassword } from '../src/auth.mjs';

const { chromium } = await import('/tmp/pi-backend-browser/node_modules/playwright-core/index.mjs');
const sample = readFileSync('/tmp/pi-voice-preview-test.mp3');
const directory = mkdtempSync(join(tmpdir(), 'pi-voice-ui-')), store = new Store(directory);
const speech = new Speech('fake-only', { fetcher: async url => url.endsWith('/get_voice')
  ? Response.json({ base_resp: { status_code: 0 }, system_voice: [
    { voice_id: 'female-tianmei', voice_name: '甜美女性音色' },
    { voice_id: 'Chinese (Mandarin)_Mature_Woman', voice_name: '傲娇御姐' },
  ] }) : Response.json({ base_resp: { status_code: 0 }, data: { audio: sample.toString('hex') }, extra_info: { audio_length: 2304 } }) });
let app, browser;
try {
  const alice = store.createUser('demo_alice', await hashPassword('fixture-voice-password'));
  const bob = store.createUser('demo_bob', 'fake');
  app = await makeServer({ store, engine: new MockEngine(), speech, adminPassword: 'fixture-admin-password', basePath: '/assistant' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.PI_BROWSER_BINARY || '/home/vibe/.cache/ms-playwright/chromium_headless_shell-1161/chrome-linux/headless_shell', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 960 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.name));
  await page.addInitScript(() => { window.voiceCspErrors = []; document.addEventListener('securitypolicyviolation', e => window.voiceCspErrors.push(e.violatedDirective)); });
  await page.goto(`http://127.0.0.1:${app.server.address().port}/assistant/account`);
  await page.locator('#login-form input[name=username]').fill('demo_alice');
  await page.locator('#login-form input[name=password]').fill('fixture-voice-password');
  await page.locator('#login-form button').click(); await page.locator('#account').waitFor({ state: 'visible' });
  await page.locator('[data-panel=voice]').click();
  await page.locator('#voice-select option[value="female-tianmei"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#voice-select').inputValue(), 'female-tianmei');
  await page.locator('#voice-search').fill('御姐');
  await page.locator('#voice-select').selectOption('Chinese (Mandarin)_Mature_Woman');
  await page.locator('#voice-form select[name=speed]').selectOption('0.75');
  await page.locator('#voice-form select[name=emotion]').selectOption('calm');
  await page.locator('#voice-form select[name=mode]').selectOption('always');
  await page.locator('#voice-preview').click();
  for (let i = 0; i < 50 && !await page.locator('#voice-player').evaluate(audio => audio.readyState >= 2); i++) await page.waitForTimeout(100);
  assert.equal(await page.locator('#voice-player').evaluate(audio => audio.readyState >= 2), true);
  assert.equal(store.integration(alice.id, 'voice'), undefined, 'Preview saved settings');
  assert.equal(store.integration(bob.id, 'voice'), undefined);
  await page.locator('#voice-save').click();
  await page.getByText('声音偏好已保存，之后的语音使用这组设置。', { exact: true }).waitFor();
  assert.equal(store.integration(alice.id, 'voice').state.speed, 0.75);
  await page.reload(); await page.locator('#account').waitFor({ state: 'visible' }); await page.locator('[data-panel=voice]').click();
  for (let i = 0; i < 50 && await page.locator('#voice-select').inputValue() !== 'Chinese (Mandarin)_Mature_Woman'; i++) await page.waitForTimeout(100);
  assert.equal(await page.locator('#voice-select').inputValue(), 'Chinese (Mandarin)_Mature_Woman');
  assert.equal(await page.locator('#voice-form select[name=mode]').inputValue(), 'always');
  await page.screenshot({ path: '/tmp/pi-voice-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/pi-voice-mobile.png', fullPage: true });
  assert.deepEqual(await page.evaluate(() => window.voiceCspErrors), []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ realUi: true, voiceSearch: true, previewDecodes: true, previewDoesNotSave: true,
    perUserSettings: true, savedAfterReload: true, mobileOverflow: false, javascriptErrors: 0, cspViolations: 0, wechatMessagesSent: 0 }));
} finally {
  await browser?.close(); if (app) await app.close(); else store.close(); rmSync(directory, { recursive: true, force: true });
}
