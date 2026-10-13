// Run on the server; all probes use synthetic data and never bind/send WeChat.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';
import { ILinkClient } from '../src/wechat.mjs';

const login = JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/login.json'));
const base = 'http://127.0.0.1:32215/assistant';
async function api(path, token, method = 'GET', value) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(20000) });
  return { status: r.status, data: await r.json() };
}
const report = {};
const auth = await api('/api/login', null, 'POST', login); assert.equal(auth.status, 200);
const token = auth.data.token;
const oldMemory = (await api('/api/memory', token)).data.content;
try {
  await api('/api/memory', token, 'PUT', { content: 'FAKE_LIVE_MODEL_OK' });
  const c = (await api('/api/conversations', token, 'POST', { title: '部署验收（虚构数据）' })).data;
  const run = (await api(`/api/conversations/${c.id}/runs`, token, 'POST', { prompt: '必须调用memory_read工具，然后只回复读到的测试代号。' })).data;
  let result;
  for (let i = 0; i < 130; i++) {
    result = (await api('/api/runs/' + run.id, token)).data;
    if (!['queued', 'running'].includes(result.status)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(result.status, 'completed'); assert.match(result.response, /FAKE_LIVE_MODEL_OK/);
  const events = (await api(`/api/runs/${run.id}/trace`, token)).data.events;
  assert.ok(events.some(e => e.kind === 'sdk_event' && e.payload.type === 'tool_execution_start' && e.payload.toolName === 'memory_read'));
  assert.ok(events.some(e => e.kind === 'context' && e.payload.activeTools.includes('reminder_create')));
  report.real_model_and_memory_tool = true;
} finally { await api('/api/memory', token, 'PUT', { content: oldMemory }); await api('/api/logout', token, 'POST', {}); }

const directory = mkdtempSync(join(tmpdir(), 'pi-live-sb-probe-')), store = new Store(directory);
const sb = new SilverBullet(store, JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/silverbullet.json')));
const users = [store.createUser('probe_alice', 'fake'), store.createUser('probe_bob', 'fake')];
try {
  for (const user of users) await sb.provision(user);
  const a = store.integration(users[0].id, 'silverbullet').state, b = store.integration(users[1].id, 'silverbullet').state;
  await sb.file(users[0].id, '验收', { method: 'PUT', content: 'FAKE_ALICE_ONLY' });
  assert.equal((await sb.file(users[0].id, '验收')).content, 'FAKE_ALICE_ONLY');
  await assert.rejects(sb.file(users[1].id, '验收'), /note_not_found/);
  const cross = await fetch(sb.base + b.prefix + '/.fs/index.md', { headers: { Authorization: 'Bearer ' + a.token, 'X-Sync-Mode': 'true' } });
  assert.ok([401,403,404].includes(cross.status));
  const anon = await fetch(sb.base + a.prefix + '/.fs/index.md', { redirect: 'manual', headers: { 'X-Sync-Mode': 'true' } });
  assert.ok([401,403,404].includes(anon.status)); report.live_sb_isolation = true;
} finally {
  for (const user of users) {
    const state = store.integration(user.id, 'silverbullet')?.state;
    if (state?.spaceId) await sb.admin('spaces/' + state.spaceId, 'DELETE');
    if (state) for (const username of [state.humanUsername,state.agentUsername]) await sb.admin('users/' + username, 'DELETE');
  }
  await sb.close(); store.close(); rmSync(directory, { recursive: true, force: true });
}
try {
  const qr = await new ILinkClient().qr();
  assert.ok(typeof qr.qrcode === 'string' && typeof qr.qrcode_img_content === 'string'); report.real_wechat_qr = true;
} catch { report.real_wechat_qr = false; }
console.log(JSON.stringify(report));
if (!report.real_wechat_qr) process.exitCode = 1;
