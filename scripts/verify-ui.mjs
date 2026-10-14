// Local browser smoke test. Credentials are read privately, never logged.
const { chromium } = await import(process.env.PI_BROWSER_MODULE || '/tmp/pi-backend-browser/node_modules/playwright-core/index.mjs');
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const login = JSON.parse(readFileSync('../alibaba_host/config/multi-tenant-login.json'));
const browser = await chromium.launch({ executablePath: process.env.PI_BROWSER_BINARY || '/home/vibe/.cache/ms-playwright/chromium_headless_shell-1161/chrome-linux/headless_shell', args: ['--no-sandbox'] });
let user;
try {
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.name));
  await page.goto(login.url);
  await page.locator('#login-form input[name=username]').fill(login.username);
  await page.locator('#login-form input[name=password]').fill(login.password);
  await page.locator('#login-form button').click();
  await page.locator('#console').waitFor({ state: 'visible' });
  assert.match(await page.locator('#mode').textContent(), /真实模型/);
  const username = 'verify_ui_' + Date.now();
  await page.locator('#manual-user summary').click();
  await page.locator('#user-form input').fill(username);
  const created = page.waitForResponse(r => r.url().endsWith('/api/admin/users') && r.request().method() === 'POST');
  await page.locator('#user-form button').click();
  const response = await created; assert.equal(response.status(), 201); user = await response.json();
  const row = page.locator('#users article').filter({ has: page.getByText(username, { exact: true }) });
  await row.waitFor();
  await row.getByRole('button', { name: '运行记录' }).click();
  await page.getByText('还没有运行记录', { exact: true }).waitFor();
  await page.locator('#trace-close').click();
  await row.getByRole('button', { name: '定时提醒' }).click();
  await page.locator('#reminder-form input[name=text]').fill('FAKE_UI_REMINDER');
  await page.locator('#reminder-form input[name=at]').fill(new Date(Date.now() + 9*3600000).toISOString().slice(0,16));
  await page.locator('#reminder-form button').click();
  await page.getByText('提醒已保存', { exact: true }).waitFor();
  await page.locator('#reminder-list').getByRole('button', { name: '取消' }).click();
  await page.getByText('暂无提醒', { exact: true }).waitFor(); await page.locator('#reminder-close').click();
  await row.getByRole('button', { name: '准备笔记空间' }).click();
  await row.getByRole('button', { name: '笔记登录信息' }).waitFor({ timeout: 60000 });
  await row.getByRole('button', { name: '笔记登录信息' }).click();
  await page.locator('#sb-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#sb-url').inputValue(), /^https:\/\/123\.56\.157\.198:32651\/users\//);
  assert.equal(await page.locator('#sb-password').getAttribute('type'), 'password');
  const noteUrl = await page.locator('#sb-url').inputValue();
  const humanUsername = await page.locator('#sb-username').inputValue(), humanPassword = await page.locator('#sb-password').inputValue();
  await page.locator('#sb-close').click(); assert.equal(await page.locator('#sb-password').inputValue(), '');
  const notesContext = await browser.newContext(), notesPage = await notesContext.newPage();
  await notesPage.goto(noteUrl);
  await notesPage.locator('input[type=password]').waitFor();
  await notesPage.locator('input[name=username]').fill(humanUsername);
  await notesPage.locator('input[type=password]').fill(humanPassword);
  const authResponses = [];
  notesPage.on('response', r => { const path = new URL(r.url()).pathname; if (path.includes('/.auth')) authResponses.push({ path, status: r.status() }); });
  await notesPage.getByRole('button', { name: 'Log in', exact: true }).click();
  try { await notesPage.waitForURL(url => !url.pathname.includes('/.auth'), { timeout: 10000 }); }
  catch (error) {
    console.log(JSON.stringify({ notes_auth_responses: authResponses, notes_auth_text: (await notesPage.locator('body').innerText()).slice(0,600) }));
    throw error;
  }
  assert.equal((await notesContext.request.get('https://123.56.157.198:32651/api/status')).status(), 401);
  await notesContext.close();
  await row.getByRole('button', { name: '微信扫码' }).click();
  await page.locator('#wechat-dialog').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#qr-image').naturalWidth > 0);
  await page.locator('#qr-close').click();
  assert.equal(errors.length, 0);
  await page.screenshot({ path: '/tmp/pi-admin-ready.png', fullPage: true });
  console.log(JSON.stringify({ browser_login: true, create_user: true, reminders: true, trace_view: true,
    sb_login_dialog: true, human_notes_login: true, personal_trace_denied_to_note_user: true, qr_image: true, javascript_errors: 0, screenshot: '/tmp/pi-admin-ready.png' }));
} finally {
  if (user) writeFileSync('/tmp/pi-admin-check-user.json', JSON.stringify(user), { mode: 0o600 });
  await browser.close();
}
