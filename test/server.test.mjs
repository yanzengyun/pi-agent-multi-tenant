import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MockEngine } from '../src/engine.mjs';
import { makeServer } from '../src/server.mjs';
import { hashPassword, tokenHash } from '../src/auth.mjs';
import { RunQueue } from '../src/queue.mjs';

async function fixture(t, engine = new MockEngine(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tenant-test-'));
  const store = new Store(directory);
  const app = await makeServer({ store, engine, adminPassword: 'admin-fixture-password', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}${options.basePath || ''}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = async (path, { token, method = 'GET', data, headers = {} } = {}) => {
    const response = await fetch(url + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async username => {
    const result = await api('/api/login', { method: 'POST', data: { username, password: `${username}-fixture-password` } });
    assert.equal(result.status, 200); return result.data.token;
  };
  const admin = await login('admin');
  const create = async username => {
    const result = await api('/api/admin/users', { token: admin, method: 'POST',
      data: { username, password: `${username}-fixture-password`, role: 'admin' } });
    assert.equal(result.status, 201); assert.equal(result.data.role, 'user'); return { user: result.data, token: await login(username) };
  };
  return { api, admin, create, store, directory, app };
}
async function completed(api, token, id) {
  for (let i = 0; i < 100; i++) {
    const result = await api(`/api/runs/${id}`, { token });
    if (!['running', 'queued'].includes(result.data.status)) return result.data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Run did not finish');
}

test('account links are assigned from authenticated identity and configured public origin', async t => {
  const engine = { run: async ctx => JSON.stringify(ctx.accountInfo('bob')) };
  const silverbullet = { view: userId => ({ status: 'ready', url: 'https://notes.example/users/' + userId + '/', username: 'notes_' + userId, passwordUnified: true }), tools: () => null, close: async () => {} };
  const { api, create } = await fixture(t, engine, { silverbullet, origin: 'https://assistant.example', basePath: '/assistant' });
  const a = await create('alice'), b = await create('bob');
  const conversation = (await api('/api/conversations', { token: a.token, method: 'POST', data: {} })).data;
  const run = (await api('/api/conversations/' + conversation.id + '/runs', { token: a.token, method: 'POST', data: { prompt: b.user.id } })).data;
  const result = await completed(api, a.token, run.id); assert.equal(result.status, 'completed');
  const info = JSON.parse(result.response);
  assert.equal(info.username, 'alice');
  assert.equal(info.personalPageUrl, 'https://assistant.example/assistant/account');
  assert.equal(info.notes.url, 'https://notes.example/users/' + a.user.id + '/');
  assert.ok(!result.response.includes(b.user.id));
  assert.ok(!/password|token/i.test(JSON.stringify(Object.keys(info))));
});

test('account info does not invent URLs or note availability when unconfigured', async t => {
  const { api, create } = await fixture(t, { run: async ctx => JSON.stringify(ctx.accountInfo()) });
  const user = await create('alice');
  const c = (await api('/api/conversations', { token: user.token, method: 'POST', data: {} })).data;
  const run = (await api('/api/conversations/' + c.id + '/runs', { token: user.token, method: 'POST', data: { prompt: '我的笔记在哪' } })).data;
  const result = await completed(api, user.token, run.id); assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.response), { username: 'alice', personalPageUrl: null, notes: { status: 'disabled' } });
});

test('administrator traces show the selected user memory and reject foreign run IDs', async t => {
  const { api, admin, create } = await fixture(t);
  const alice = await create('alice'), bob = await create('bob');
  await api('/api/memory', { token: alice.token, method: 'PUT', data: { content: 'TRACE_ALICE_PRIVATE' } });
  const conversation = (await api('/api/conversations', { token: alice.token, method: 'POST', data: {} })).data;
  const run = (await api(`/api/conversations/${conversation.id}/runs`, { token: alice.token,
    method: 'POST', data: { prompt: 'recall' } })).data;
  await completed(api, alice.token, run.id);
  const route = `/api/admin/users/${alice.user.id}/runs`;
  assert.equal((await api(route)).status, 401);
  assert.equal((await api(route, { token: alice.token })).status, 403);
  assert.equal((await api(`${route}/${run.id}/trace`, { token: bob.token })).status, 403);
  assert.equal((await api(`/api/admin/users/${bob.user.id}/runs/${run.id}/trace`, { token: admin })).status, 404);
  assert.equal((await api('/api/admin/users/unknown/runs', { token: admin })).status, 404);
  const listing = await api(route, { token: admin });
  assert.equal(listing.status, 200); assert.equal(listing.data.runs.length, 1);
  assert.equal(listing.data.runs[0].preview, 'recall');
  const detail = await api(`${route}/${run.id}/trace`, { token: admin });
  assert.equal(detail.data.run.response, 'TRACE_ALICE_PRIVATE');
  assert.ok(detail.data.events.some(event => event.kind === 'prompt' && event.payload.system.includes('TRACE_ALICE_PRIVATE')));
  assert.ok(detail.data.events.some(event => event.kind === 'tool' && event.payload.name === 'memory_read'));
  assert.deepEqual((await api(`/api/admin/users/${bob.user.id}/runs`, { token: admin })).data.runs, []);
});

test('subpath publishing scopes cookies and reminders cannot be managed by another user', async t => {
  const { api, admin, create } = await fixture(t, new MockEngine(), { basePath: '/assistant', secureCookies: true, origin: 'https://example.test' });
  const alice = await create('alice'), bob = await create('bob');
  const login = await api('/api/login', { method: 'POST', data: { username: 'admin', password: 'admin-fixture-password' } });
  assert.match(login.headers.get('set-cookie'), /Path=\/assistant\//); assert.match(login.headers.get('set-cookie'), /; Secure/);
  const route = `/api/admin/users/${alice.user.id}/reminders`;
  assert.equal((await api(route, { token: alice.token })).status, 403);
  const created = await api(route, { token: admin, method: 'POST', data: { text: 'FAKE_ALICE', at: new Date(Date.now() + 60000).toISOString() } });
  assert.equal(created.status, 201);
  assert.equal((await api(`/api/admin/users/${bob.user.id}/reminders/${created.data.id}`, { token: admin, method: 'DELETE', data: {} })).status, 404);
  assert.deepEqual((await api(`/api/admin/users/${bob.user.id}/reminders`, { token: admin })).data.reminders, []);
  assert.equal((await api(`${route}/${created.data.id}`, { token: admin, method: 'DELETE', data: {} })).status, 200);
});

test('administrator run lists are bounded, ordered and contain only the selected user', async t => {
  const { api, admin, create, store } = await fixture(t);
  const alice = await create('alice'), bob = await create('bob');
  const a = store.createConversation(alice.user.id, 'fake'), b = store.createConversation(bob.user.id, 'fake');
  for (let i = 0; i < 55; i++) store.createRun(alice.user.id, a.id, String(i).padStart(3, '0') + 'x'.repeat(200));
  store.createRun(bob.user.id, b.id, 'BOB_PRIVATE');
  const listing = (await api(`/api/admin/users/${alice.user.id}/runs`, { token: admin })).data.runs;
  assert.equal(listing.length, 50); assert.ok(listing.every(run => run.preview.length === 120));
  assert.match(listing[0].preview, /^054/); assert.match(listing.at(-1).preview, /^005/);
  assert.ok(!JSON.stringify(listing).includes('BOB_PRIVATE'));
});

test('ordinary users cannot manage users; auth sessions are hashed and revocable', async t => {
  const { api, admin, create, store } = await fixture(t);
  const alice = await create('alice');
  assert.equal((await api('/api/admin/users', { token: alice.token })).status, 403);
  assert.equal((await api('/api/admin/users')).status, 401);
  assert.equal((await api('/api/me', { token: 'invented-token' })).status, 401);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE hash=?').get(admin).n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE hash=?').get(tokenHash(admin)).n, 1);
  assert.equal((await api('/api/logout', { token: alice.token, method: 'POST', data: {} })).status, 200);
  assert.equal((await api('/api/me', { token: alice.token })).status, 401);
});

test('memory, conversations, messages, runs and trace cannot cross user boundaries', async t => {
  const { api, create } = await fixture(t);
  const alice = await create('alice'), bob = await create('bob');
  await api('/api/memory', { token: alice.token, method: 'PUT', data: { content: 'ALICE_PRIVATE', userId: bob.user.id } });
  assert.equal((await api('/api/memory', { token: bob.token })).data.content, '');
  const conversation = (await api('/api/conversations', { token: alice.token, method: 'POST', data: {} })).data;
  assert.deepEqual((await api('/api/conversations', { token: bob.token })).data.conversations, []);
  assert.equal((await api(`/api/conversations/${conversation.id}/messages`, { token: bob.token })).status, 404);
  assert.equal((await api(`/api/conversations/${conversation.id}/runs`, { token: bob.token, method: 'POST', data: { prompt: 'recall' } })).status, 404);
  const run = (await api(`/api/conversations/${conversation.id}/runs`, { token: alice.token, method: 'POST', data: { prompt: 'recall', userId: bob.user.id } })).data;
  const result = await completed(api, alice.token, run.id);
  assert.equal(result.response, 'ALICE_PRIVATE');
  assert.equal((await api(`/api/runs/${run.id}`, { token: bob.token })).status, 404);
  assert.equal((await api(`/api/runs/${run.id}/trace`, { token: bob.token })).status, 404);
  const trace = (await api(`/api/runs/${run.id}/trace`, { token: alice.token })).data.events;
  assert.ok(trace.some(e => e.kind === 'prompt' && e.payload.system.includes('ALICE_PRIVATE')));
  assert.equal((await api(`/api/conversations/${conversation.id}/messages`, { token: alice.token })).data.messages.length, 2);
});

test('cookie protections, bad input and foreign origins are rejected', async t => {
  const { api, admin } = await fixture(t);
  const login = await api('/api/login', { method: 'POST', data: { username: 'admin', password: 'admin-fixture-password' } });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await api('/api/memory', { token: admin, method: 'PUT', data: { content: 'x' }, headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await api('/api/conversations', { token: admin, method: 'POST', data: { title: 'x'.repeat(101) } })).status, 400);
  assert.equal((await api('/api/memory', { token: admin, method: 'PUT', data: { content: 'x'.repeat(40000) } })).status, 413);
  assert.equal((await api('/api/admin/users', { token: admin, method: 'POST', data: { username: '../../escape' } })).status, 400);
});

test('global queue serializes users and one failed run does not block another', async t => {
  let active = 0, peak = 0;
  const engine = { async run(_ctx, prompt) {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 30)); if (prompt === 'fail') throw new Error('fake-secret'); return prompt; }
    finally { active--; }
  } };
  const { api, create } = await fixture(t, engine);
  const alice = await create('alice'), bob = await create('bob');
  const users = [alice, bob];
  const runs = await Promise.all(users.map(async (user, i) => {
    const c = (await api('/api/conversations', { token: user.token, method: 'POST', data: {} })).data;
    return (await api(`/api/conversations/${c.id}/runs`, { token: user.token, method: 'POST', data: { prompt: i ? 'success' : 'fail' } })).data;
  }));
  const results = await Promise.all(runs.map((run, i) => completed(api, users[i].token, run.id)));
  assert.equal(peak, 1); assert.equal(results[0].status, 'failed'); assert.equal(results[0].error, 'engine_failed');
  assert.equal(results[1].response, 'success');
});

test('restart retains user state, executes queued runs and does not replay interrupted runs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-recovery-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(directory);
  const user = store.createUser('alice', await hashPassword('alice-fixture-password'));
  store.writeMemory(user.id, 'PERSISTENT_PRIVATE');
  const c = store.createConversation(user.id, '恢复');
  store.message(user.id, c.id, 'user', 'OLD_PRIVATE');
  const interrupted = store.createRun(user.id, c.id, 'do not replay'); store.runStatus(interrupted.id, 'running');
  const queued = store.createRun(user.id, c.id, 'history');
  store.close(); store = new Store(directory);
  const queue = new RunQueue(store, new MockEngine()); await queue.work;
  assert.equal(store.memory(user.id), 'PERSISTENT_PRIVATE');
  assert.equal(store.run(user.id, interrupted.id).status, 'interrupted');
  assert.equal(store.run(user.id, queued.id).status, 'completed');
  assert.match(store.run(user.id, queued.id).response, /OLD_PRIVATE/);
  await queue.close(); store.close();
});

test('run timeout aborts the active engine before the next user is started', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-timeout-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const user = store.createUser('alice', await hashPassword('alice-fixture-password'));
  const c = store.createConversation(user.id, '超时');
  const first = store.createRun(user.id, c.id, 'hang'), second = store.createRun(user.id, c.id, 'next');
  let aborted = false;
  const engine = { async run(ctx, prompt) {
    if (prompt === 'hang') await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    assert.equal(aborted, true); return 'next';
  } };
  const queue = new RunQueue(store, engine, { timeoutMs: 30 }); await queue.work;
  assert.equal(store.run(user.id, first.id).error, 'run_aborted');
  assert.equal(store.run(user.id, second.id).response, 'next');
  await queue.close(); store.close();
});

test('expired sessions cannot authenticate and administrator page has no chat UI or static QR', async t => {
  const { api, admin, store } = await fixture(t);
  store.db.prepare('UPDATE auth_sessions SET expires_at=0 WHERE hash=?').run(tokenHash(admin));
  assert.equal((await api('/api/me', { token: admin })).status, 401);
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /管理员登录/); assert.match(html, /未连接其他助手的微信/);
  assert.doesNotMatch(html, /<textarea|qr-code/);
});
