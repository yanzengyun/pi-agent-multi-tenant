import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MockEngine } from '../src/engine.mjs';
import { makeServer } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-invite-test-')), store = new Store(directory);
  const app = await makeServer({ store, engine: new MockEngine(), adminPassword: 'admin-fixture-password', ...options });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function api(path, token, method = 'GET', value) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: r.status, data: await r.json() };
  }
  const admin = (await api('/api/login', null, 'POST', { username: 'admin', password: 'admin-fixture-password' })).data.token;
  const invite = async value => (await api('/api/admin/invites', admin, 'POST', value || {})).data;
  const register = async (invitation, username) => api('/api/register', null, 'POST', { invite: invitation.token, username, password: 'user-fixture-password', role: 'admin' });
  return { directory, store, app, api, admin, invite, register };
}

test('registration requires a valid single-use invitation and cannot grant admin', async t => {
  const { api, admin, invite, register, store } = await fixture(t);
  assert.equal((await api('/api/register', null, 'POST', { username: 'alice', password: 'user-fixture-password' })).status, 400);
  const invitation = await invite(); assert.ok(invitation.token);
  const results = await Promise.all([register(invitation, 'alice'), register(invitation, 'bob')]);
  assert.equal(results.filter(r => r.status === 201).length, 1);
  const registered = results.find(r => r.status === 201).data;
  assert.equal(registered.user.role, 'user');
  assert.equal((await api('/api/admin/invites', registered.token)).status, 403);
  assert.ok(!JSON.stringify((await api('/api/admin/invites', admin)).data).includes(invitation.token));
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM invitations').all()).includes(invitation.token));
  assert.equal((await api('/api/admin/users', registered.token)).status, 403);
});

test('revoked and expired invitations cannot register', async t => {
  const { api, admin, invite, register, store } = await fixture(t);
  const revoked = await invite(); assert.equal((await api('/api/admin/invites/' + revoked.id, admin, 'DELETE', {})).status, 200);
  assert.equal((await register(revoked, 'alice')).status, 400);
  const expired = await invite(); store.db.prepare('UPDATE invitations SET expires_at=0 WHERE id=?').run(expired.id);
  assert.equal((await register(expired, 'bob')).status, 400);
});

test('existing-user invitation changes login credentials while preserving identity and memory', async t => {
  const { api, admin, invite, register, store } = await fixture(t);
  const original = (await api('/api/admin/users', admin, 'POST', { username: 'lucy', password: 'old-fixture-password' })).data;
  const old = (await api('/api/login', null, 'POST', { username: 'lucy', password: 'old-fixture-password' })).data.token;
  store.writeMemory(original.id, 'FAKE_EXISTING_MEMORY');
  const link = await invite({ userId: original.id });
  assert.equal((await register(link, 'someone_else')).status, 400);
  const accepted = await register(link, 'lucy'); assert.equal(accepted.status, 201);
  assert.equal(accepted.data.user.id, original.id); assert.equal(store.memory(original.id), 'FAKE_EXISTING_MEMORY');
  assert.equal((await api('/api/me', old)).status, 401);
  assert.equal((await api('/api/me', accepted.data.token)).status, 200);
  assert.equal((await invite({ userId: store.user('admin').id })).error, 'invalid_invite_target');
});

test('own AGENTS preferences are mirrored and injected without granting cross-user tools', async t => {
  const { api, invite, register, directory, store, app } = await fixture(t);
  const alice = (await register(await invite(), 'alice')).data, bob = (await register(await invite(), 'bob')).data;
  const content = 'FAKE_ALICE_STYLE: 请简短回复。';
  assert.equal((await api('/api/account/agents', alice.token, 'PUT', { content, userId: bob.user.id, path: '/etc/passwd' })).status, 200);
  assert.equal((await api('/api/account/agents', bob.token)).data.content, '');
  assert.equal(readFileSync(join(directory, 'tenants', alice.user.id, 'workspace', 'AGENTS.md'), 'utf8'), content);
  assert.equal((await api('/api/admin/users', alice.token)).status, 403);
  assert.equal((await api('/api/account/agents', alice.token, 'PUT', { content: 'x'.repeat(8001) })).status, 400);
  const c = store.createConversation(alice.user.id, 'fake'), run = store.createRun(alice.user.id, c.id, 'hello');
  app.queue.kick(); await app.queue.work;
  assert.ok(store.traces(alice.user.id, run.id).some(e => e.kind === 'prompt' && e.payload.system.includes(content)));
  assert.equal((await api('/api/account/wechat', alice.token)).status, 503);
  assert.equal((await api('/api/account/reminders', alice.token)).status, 200);
});


test('shared password sync requires current password and preserves app login on note sync failure', async t => {
  const calls = []; let fail = false;
  const silverbullet = { view: () => ({status: 'ready'}), tools: () => ({}), close: async () => {},
    async setUnifiedLogin(user, password, username) { if (fail) throw new Error('offline'); calls.push({ id: user.id, password, username }); return {status: 'ready'}; } };
  const { api, invite, register } = await fixture(t, {silverbullet});
  const alice = (await register(await invite(), 'alice')).data;
  assert.equal(calls[0].password, 'user-fixture-password');
  assert.equal((await api('/api/account/silverbullet/login', alice.token, 'POST', {username:'alice_notes', password:'different-note-password'})).status,403);
  assert.equal(calls.length,1);
  assert.equal((await api('/api/account/silverbullet/login', alice.token, 'POST', {username:'alice_notes', password:'user-fixture-password'})).status,200);
  assert.equal(calls[1].id,alice.user.id);
  fail = true;
  assert.equal((await api('/api/account/password', alice.token, 'POST', {oldPassword:'user-fixture-password', password:'new-fixture-password'})).status,502);
  assert.equal((await api('/api/login', null, 'POST', {username:'alice', password:'user-fixture-password'})).status,200);
  fail = false;
  assert.equal((await api('/api/account/password', alice.token, 'POST', {oldPassword:'user-fixture-password', password:'new-fixture-password'})).status,200);
  assert.equal(calls.at(-1).password,'new-fixture-password');
  assert.equal((await api('/api/me', alice.token)).status,401);
});

test('persona drafts are read-only, scoped to their owner and persist their mode', async t => {
  let observed;
  const engine = { async run(ctx) {
    observed = ctx;
    assert.equal(ctx.personaDraft,true); assert.equal(ctx.memory(),'');
    assert.equal(ctx.notes,undefined); assert.equal(ctx.reminders,undefined);
    assert.throws(() => ctx.writeMemory('bad')); assert.throws(() => ctx.writeAgentProfile('bad'));
    return 'FAKE_DRAFT';
  } };
  const {api,invite,register,store,app} = await fixture(t,{engine});
  const a=(await register(await invite(),'alice')).data,b=(await register(await invite(),'bob')).data;
  store.setAgentProfile(a.user.id,'FAKE_EXISTING'); store.writeMemory(a.user.id,'FAKE_PRIVATE');
  const draft=await api('/api/account/persona-assist',a.token,'POST',{requirements:'回答简洁',userId:b.user.id});
  assert.equal(draft.status,202); await app.queue.work;
  assert.equal(observed.agentProfile(),'FAKE_EXISTING');
  assert.equal(store.runMode(draft.data.id),'persona_draft');
  assert.equal((await api('/api/account/persona-assist/'+draft.data.id,b.token)).status,404);
  assert.equal((await api('/api/account/persona-assist/'+draft.data.id,a.token)).data.content,'FAKE_DRAFT');
  assert.equal(store.agentProfile(a.user.id),'FAKE_EXISTING'); assert.equal(store.memory(a.user.id),'FAKE_PRIVATE');
});
