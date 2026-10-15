// Real SilverBullet UI; disposable local container and synthetic users/notes only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';

const { chromium } = await import(process.env.PI_BROWSER_MODULE || '/tmp/pi-backend-browser/node_modules/playwright-core/index.mjs');
const output = resolve(process.env.PI_SCREENSHOT_DIR || 'docs/images');
const directory = mkdtempSync(join(tmpdir(), 'pi-notes-readme-'));
const container = 'pi-notes-readme-' + randomBytes(5).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const store = new Store(directory), password = randomBytes(24).toString('base64url');
let sb, browser, created = false;

const collections = [
  { username: 'demo_alice', name: 'Alice · 我的生活笔记（演示）', intro: '把聊天里值得留下的事，整理成自己的生活笔记。', groups: [
    ['旅行计划', ['杭州周末两日游', '云南旅行愿望清单', '出门前的打包清单', '旅行预算与订房记录']],
    ['学习成长/Python', ['学习路线与每周计划', '基础语法速查', '我的第一个自动化脚本', '错题与踩坑记录']],
    ['健康运动', ['游泳训练计划', '每周运动记录', '睡眠与作息观察', '日常习惯清单']],
    ['阅读观影', ['待读书单', '读书摘录与想法', '电影收藏夹', '播客与灵感']],
    ['生活整理', ['每周回顾', '购物与待办清单', '常做的家常菜', '想尝试的十件小事']],
    ['与助手的记录', ['聊天整理与灵感', '本月目标', '需要继续聊的话题', '我的回答偏好']],
  ] },
  { username: 'demo_bob', name: 'Bob · 我的项目笔记（演示）', intro: '工作、学习与生活，各自有条理；和自己的助手一起持续整理。', groups: [
    ['项目/个人网站', ['项目概览与里程碑', '页面设计与参考', '开发待办清单', '上线检查清单']],
    ['学习/AI 助手', ['Pi Harness 学习地图', '提示词与人物设定', '长期记忆学习笔记', '工具调用与实践']],
    ['工作记录', ['本周工作安排', '会议纪要模板', '需求与问题清单', '周五复盘']],
    ['兴趣生活', ['城市骑行路线', '咖啡店探索清单', '摄影练习计划', '周末灵感']],
    ['资料收藏', ['常用工具箱', '值得再读的文章', '开源项目清单', '稍后阅读']],
    ['与助手的记录', ['对话中整理的想法', '今年想完成的事', '下次继续聊', '我的回答偏好']],
  ] },
];

function indexContent(person) {
  return `${person.name}\n\n${person.intro}\n\n> README 演示空间 · 所有标题、计划和记录均为虚构示例。\n\n# 我的笔记目录\n${person.groups.map(([folder, titles]) => `\n## ${folder}\n${titles.map(title => `[[${folder}/${title}|${title}]]`).join(' · ')}\n`).join('')}\n# 和助手一起使用\n* 微信里说「帮我把刚才的讨论整理成笔记」。\n* 浏览器中继续阅读、编辑同一份内容。\n* 每位用户拥有独立的空间和访问权限。\n`;
}

try {
  docker('create', '--name', container, '--memory', '192m', '--memory-swap', '192m', '--cpus', '0.5',
    '-p', '127.0.0.1::3000', '-e', 'SB_HOSTNAME=0.0.0.0', '-e', 'SB_RUNTIME_API=0', '-e', 'SB_SHELL_BACKEND=none',
    'ghcr.io/silverbulletmd/silverbullet:2.12.0-slim');
  created = true; docker('start', container);
  const baseUrl = 'http://127.0.0.1:' + docker('port', container, '3000/tcp').split(':').at(-1);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(baseUrl + '/.instance', { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Demo SilverBullet must start');
  const setup = await fetch(baseUrl + '/.setup/api/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primaryUrl: baseUrl, adminUsername: 'readme_admin', adminPassword: password,
      space: { name: 'README bootstrap', prefix: '/bootstrap', folder: 'spaces/bootstrap', revisions: 'disabled' } }) });
  assert.equal(setup.status, 200);
  sb = new SilverBullet(store, { baseUrl, username: 'readme_admin', password });
  const people = [];
  for (const person of collections) {
    const user = store.createUser(person.username, 'demo-only');
    await sb.setUnifiedLogin(user, password);
    const state = store.integration(user.id, 'silverbullet').state;
    await sb.admin('spaces/' + state.spaceId, 'PATCH', { name: person.name });
    const tools = sb.tools(user.id);
    for (const [folder, titles] of person.groups) {
      for (const title of titles) await tools.write(folder + '/' + title, `> README 演示笔记 · 虚构示例\n\n# ${title}\n\n待整理。\n`);
    }
    const home = await tools.read('index');
    await tools.write('index', indexContent(person), home.etag);
    people.push({ user, state, tools });
  }
  // The same agent tools used by production write the demo content; access remains scoped.
  const firstPage = collections[1].groups[0][0] + '/' + collections[1].groups[0][1][0] + '.md';
  const cross = await fetch(baseUrl + people[1].state.prefix + '/.fs/' + firstPage.split('/').map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + people[0].state.token, 'X-Sync-Mode': 'true' } });
  assert.ok([401, 403].includes(cross.status), 'Another user must not read the demo space');
  const trip = '旅行计划/杭州周末两日游';
  const previous = await people[0].tools.read(trip);
  await people[0].tools.write(trip, `> README 演示笔记 · 虚构旅行计划\n\n# 周末去杭州，慢慢逛两天\n\n想给自己留一个不用赶路的周末：走走西湖、喝杯茶，再留一点时间随意探索。\n\n## 行程安排\n\n| 时间 | 安排 | 备注 |\n| --- | --- | --- |\n| 周六上午 | 到达后先放行李，沿西湖散步 | 不排太满 |\n| 周六下午 | 找一家茶馆，看看书 | 下雨也有备选 |\n| 周日上午 | 去植物园或附近公园走走 | 看当天体力 |\n| 周日下午 | 买点伴手礼，提前出发返程 | 留出路上时间 |\n\n## 出发前准备\n* [x] 和助手整理两天的行程框架\n* [ ] 确认交通与住宿\n* [ ] 看出发前的天气预报\n* [ ] 带上充电器、雨伞和舒服的鞋\n\n## 相关笔记\n* [[旅行计划/旅行预算与订房记录|预算与订房记录]]\n* [[旅行计划/出门前的打包清单|出门前的打包清单]]\n* [[index|返回我的笔记目录]]\n\n## 下次和助手继续聊\n还想找一条人少一点的散步路线，顺便补充雨天安排。\n`, previous.etag);

  mkdirSync(output, { recursive: true });
  browser = process.env.PI_BROWSER_WS ? await chromium.connect(process.env.PI_BROWSER_WS) :
    await chromium.launch({ executablePath: process.env.PI_BROWSER_BINARY || '/home/vibe/.cache/ms-playwright/chromium_headless_shell-1161/chrome-linux/headless_shell', args: ['--no-sandbox'] });
  for (const [i, person] of people.entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 1.5, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    await page.goto(baseUrl + person.state.prefix + '/');
    await page.locator('input[name=username]').fill(person.user.username);
    await page.locator('input[type=password]').fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('.cm-editor').waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('我的笔记目录'));
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForFunction(name => document.body.innerText.includes(name) && document.body.innerText.includes('我的笔记目录'), collections[i].name);
    await page.screenshot({ path: join(output, i ? 'notes-bob.png' : 'notes-alice.png'), fullPage: false });
    if (!i) {
      await page.goto(baseUrl + person.state.prefix + '/' + trip.split('/').map(encodeURIComponent).join('/'));
      await page.waitForFunction(() => document.body.innerText.includes('行程安排'));
      await page.screenshot({ path: join(output, 'notes-trip.png'), fullPage: false });
    }
    await context.close();
  }
  console.log(JSON.stringify({ screenshots: 3, users: 2, notesPerUser: 25, realSilverBulletUi: true,
    crossUserAccessDenied: true, productionTouched: false, wechatMessagesSent: 0 }));
} finally {
  await browser?.close(); await sb?.close(); store.close();
  if (created) docker('rm', '-f', container);
  rmSync(directory, { recursive: true, force: true });
}
