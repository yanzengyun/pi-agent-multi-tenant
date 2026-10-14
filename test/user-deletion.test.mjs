import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.mjs';
import { UserDeletion } from '../src/user-deletion.mjs';
import { makeServer } from '../src/server.mjs';
import { MockEngine } from '../src/engine.mjs';
import { hashPassword, tokenHash } from '../src/auth.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-delete-')); let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new Store(directory); return store; } };
}
const fakeCredentials = name => ({ botId: name + '-bot', remoteUser: name + '-remote', token: 'FAKE', baseUrl: 'https://ilinkai.weixin.qq.com' });

test('deletion removes only the selected user, revokes old access and permits clean re-registration', async t => {
  const f = fixture(t), { store, directory } = f;
  const alice = store.createUser('alice', 'fake'), bob = store.createUser('bob', 'fake');
  store.createUser('admin', 'fake', 'admin');
  store.writeMemory(alice.id, 'OLD_MEMORY'); store.writeMemory(bob.id, 'BOB_MEMORY');
  store.setAgentProfile(alice.id, 'OLD_PERSONA'); store.setAgentProfile(bob.id, 'BOB_PERSONA');
  const binding = store.bindWechat(alice.id, fakeCredentials('alice'));
  store.acceptWechat(binding, { id: 'old-message', contextToken: 'FAKE_CONTEXT', text: 'old chat' });
  const run = store.pending()[0]; store.trace(run.id, 'fake', { text: 'OLD_TRACE' });
  store.saveVoice(alice.id, run.id, { audio: Buffer.from('FAKE_MP3'), duration: 100, sampleRate: 24000 });
  store.createToken(tokenHash('old-session'), alice.id);
  store.newInvite(tokenHash('old-invite'), alice.id);
  store.db.prepare('INSERT INTO reminders VALUES (?,?,?,?,?,?)').run('old-reminder', alice.id, 'OLD_TASK', Date.now(), 1, 'scheduled');
  const sessions = join(directory, 'tenants', alice.id, 'sessions'); mkdirSync(sessions); writeFileSync(join(sessions, 'old.jsonl'), 'OLD_CHAT');
  const unrelated = join(directory, 'outside.txt'); writeFileSync(unrelated, 'KEEP');
  symlinkSync(unrelated, join(directory, 'tenants', alice.id, 'workspace', 'link'));
  const calls = [];
  const deletion = new UserDeletion(store, { sandbox: { async release(id) { calls.push(['sandbox', id]); } },
    silverbullet: { busy: () => false, async archiveUser(user) { calls.push(['notes', user.id]); return { folder: 'spaces/pi-tenants/' + user.id }; } } });
  const result = await deletion.remove(alice.id, 'alice');
  assert.equal(result.deleted, true); assert.equal(result.notesArchived, true);
  assert.equal(store.userById(alice.id), undefined); assert.equal(store.principal(tokenHash('old-session')), undefined);
  assert.equal(store.invitation(tokenHash('old-invite')), undefined);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  for (const table of ['runs','conversations','messages','traces','wechat_inbox','wechat_voice','wechat_bindings','wechat_identities','reminders']) {
    assert.equal(store.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0, table);
  }
  assert.equal(existsSync(join(directory, 'tenants', alice.id)), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'KEEP'); assert.equal(store.memory(bob.id), 'BOB_MEMORY');
  assert.equal(store.agentProfile(bob.id), 'BOB_PERSONA'); assert.equal(store.user('admin').role, 'admin');
  const report = JSON.parse(readFileSync(join(directory, 'deleted-users', alice.id + '.json')));
  assert.equal(report.username, 'alice'); assert.ok(!JSON.stringify(report).includes('FAKE_CONTEXT'));
  const fresh = store.createUser('alice', 'new-fake'); assert.notEqual(fresh.id, alice.id); assert.equal(store.memory(fresh.id), '');
  assert.equal(store.bindWechat(fresh.id, fakeCredentials('alice')).remote_user, 'alice-remote');
  assert.deepEqual(calls.map(x => x[0]), ['notes','sandbox']);
});

test('cleanup failure durably disables the user and can be retried after reopening the store', async t => {
  const f = fixture(t), user = f.store.createUser('alice', 'fake');
  f.store.createToken(tokenHash('old-session'), user.id); f.store.newInvite(tokenHash('old-invite'), user.id);
  const deletion = new UserDeletion(f.store, { sandbox: { async release() { throw new Error('offline'); } } });
  await assert.rejects(deletion.remove(user.id, 'alice'), /user_cleanup_failed/);
  assert.equal(f.store.principal(tokenHash('old-session')), undefined); assert.equal(f.store.usable(user.id), false);
  assert.throws(() => f.store.createConversation(user.id, 'must not run'), /user_unavailable/);
  assert.throws(() => f.store.newInvite(tokenHash('another-invite'), user.id), /user_unavailable/);
  assert.throws(() => f.store.setAgentProfile(user.id, 'bad'), /user_unavailable/);
  const store = f.reopen(); assert.equal(store.deletion(user.id).state, 'failed');
  await new UserDeletion(store, { sandbox: { async release() {} } }).remove(user.id, 'alice');
  assert.equal(store.userById(user.id), undefined);
});

test('admin accounts, wrong confirmation, active tasks and busy note changes are not deleted', async t => {
  const { store } = fixture(t), admin = store.createUser('admin', 'fake', 'admin'), alice = store.createUser('alice', 'fake');
  const deletion = new UserDeletion(store);
  await assert.rejects(deletion.remove(admin.id, 'admin'), /cannot_delete_admin/);
  await assert.rejects(deletion.remove(alice.id, 'wrong'), /delete_confirmation_mismatch/);
  const c = store.createConversation(alice.id, 'fake'), run = store.createRun(alice.id, c.id, 'fake');
  store.runStatus(run.id, 'running');
  await assert.rejects(deletion.remove(alice.id, 'alice'), /user_has_active_run/);
  assert.equal(store.deletion(alice.id), undefined); assert.equal(store.usable(alice.id), true);
  store.runStatus(run.id, 'completed');
  await assert.rejects(new UserDeletion(store, { silverbullet: { busy: () => true } }).remove(alice.id, 'alice'), /user_busy/);
});

test('in-progress cleanup refuses a second request and prevents unsafe filesystem traversal', async t => {
  const { store, directory } = fixture(t), user = store.createUser('alice', 'fake');
  let complete; const wait = new Promise(resolve => { complete = resolve; });
  const deletion = new UserDeletion(store, { sandbox: { async release() { await wait; } } });
  const first = deletion.remove(user.id, 'alice');
  await assert.rejects(deletion.remove(user.id, 'alice'), /user_busy/); complete(); await first;
  const other = store.createUser('other', 'fake'), outside = join(directory, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'KEEP'); symlinkSync(outside, join(directory, 'tenants'));
  await assert.rejects(deletion.remove(other.id, 'other'), /user_cleanup_failed/);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'KEEP');
});

// Run the real HTTP handler without opening a socket, so auth can be tested in offline environments.
function dispatch(server, path, token, method = 'GET', data) {
  return new Promise(resolve => {
    const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
    Object.assign(req, { url: path, method, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'test.local', 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
    const headers = {}; let status;
    const res = { headersSent: false, setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(code) { status = code; this.headersSent = true; }, end(value) { resolve({ status, data: JSON.parse(value), headers }); } };
    server.emit('request', req, res);
  });
}

test('only admin can delete users; deleted users cannot log back in with their old password', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-delete-http-')), store = new Store(directory);
  let offline = false;
  const app = await makeServer({ store, engine: new MockEngine(), adminPassword: 'fake-admin-password',
    sandbox: { tools: () => null, async release() { if (offline) throw new Error('offline'); } } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const alice = store.createUser('alice', await hashPassword('fake-alice-password'));
  store.createToken(tokenHash('admin-session'), store.user('admin').id); store.createToken(tokenHash('alice-session'), alice.id);
  const path = '/api/admin/users/' + alice.id;
  assert.equal((await dispatch(app.server, path, null, 'DELETE', { confirmUsername: 'alice' })).status, 401);
  assert.equal((await dispatch(app.server, path, 'alice-session', 'DELETE', { confirmUsername: 'alice' })).status, 403);
  assert.equal((await dispatch(app.server, path, 'admin-session', 'DELETE', { confirmUsername: 'wrong' })).status, 400);
  offline = true;
  assert.equal((await dispatch(app.server, path, 'admin-session', 'DELETE', { confirmUsername: 'alice' })).status, 503);
  assert.ok(store.userById(alice.id));
  assert.equal((await dispatch(app.server, '/api/login', null, 'POST', { username: 'alice', password: 'fake-alice-password' })).status, 401);
  assert.equal((await dispatch(app.server, '/api/admin/users', 'admin-session')).data.users.find(u => u.id === alice.id).deletion_status, 'failed');
  offline = false;
  assert.equal((await dispatch(app.server, path, 'admin-session', 'DELETE', { confirmUsername: 'alice' })).status, 200);
  assert.equal((await dispatch(app.server, '/api/me', 'alice-session')).status, 401);
  assert.equal((await dispatch(app.server, '/api/login', null, 'POST', { username: 'alice', password: 'fake-alice-password' })).status, 401);
});

test('note archival preserves files, removes owned logins and is retryable without touching another space', async t => {
  const { SilverBullet } = await import('../src/silverbullet.mjs');
  const { store } = fixture(t), user = store.createUser('alice', 'fake');
  const owned = { folder: 'spaces/pi-tenants/' + user.id, prefix: '/users/' + user.id, humanUsername: 'alice_notes', agentUsername: 'alice_agent', spaceId: 'alice-space' };
  store.setIntegration(user.id, 'silverbullet', 'ready', owned);
  const accounts = { alice_notes: { admin: false, fullName: `Pi tenant ${user.id} human` }, alice_agent: { admin: false, fullName: `Pi tenant ${user.id} agent` }, bob: { admin: false, fullName: 'Bob' } };
  const spaces = { 'alice-space': { folder: owned.folder, binding: { prefix: owned.prefix }, access: 'none', members: { alice_notes: { role: 'write' }, alice_agent: { role: 'write' } }, shell: { enabled: false } },
    'bob-space': { folder: 'bob-folder', members: { bob: { role: 'write' } } } };
  const files = { 'alice-space': 'OLD_NOTES', 'bob-space': 'BOB_NOTES' };
  const sb = new SilverBullet(store, { baseUrl: 'http://127.0.0.1:1', username: 'sb-admin', password: 'fake' });
  let fail = true;
  sb.admin = async (path, method = 'GET', data) => {
    if (path === 'users') return accounts;
    if (path === 'spaces') return spaces;
    if (path.startsWith('spaces/')) {
      const current = spaces[path.slice(7)];
      if (method === 'PATCH') Object.assign(current, data);
      assert.notEqual(method, 'DELETE', 'archive must retain note files'); return current;
    }
    if (path.startsWith('users/') && method === 'DELETE') {
      if (fail) { fail = false; throw new Error('lost-note-delete-response'); }
      delete accounts[path.slice(6)]; return {};
    }
    throw new Error('Unexpected archive call');
  };
  await assert.rejects(sb.archiveUser(user), /lost-note-delete-response/);
  assert.deepEqual(spaces['alice-space'].members, {}); assert.equal(spaces['alice-space'].access, 'none');
  const result = await sb.archiveUser(user); assert.equal(result.folder, owned.folder);
  assert.deepEqual(Object.keys(accounts), ['bob']); assert.equal(files['alice-space'], 'OLD_NOTES');
  assert.equal(files['bob-space'], 'BOB_NOTES'); assert.deepEqual(spaces['bob-space'].members, { bob: { role: 'write' } });
  await sb.archiveUser(user); assert.deepEqual(Object.keys(accounts), ['bob']);
});

test('note archival rejects foreign account ownership before changing any space', async t => {
  const { SilverBullet } = await import('../src/silverbullet.mjs');
  const { store } = fixture(t), user = store.createUser('alice', 'fake');
  store.setIntegration(user.id, 'silverbullet', 'ready', { folder: 'spaces/pi-tenants/' + user.id, prefix: '/users/' + user.id, humanUsername: 'bob', agentUsername: 'agent', spaceId: 'space' });
  const sb = new SilverBullet(store, { baseUrl: 'http://127.0.0.1:1', username: 'sb-admin', password: 'fake' });
  const calls = [];
  sb.admin = async (path, method = 'GET') => { calls.push(method); return path === 'users' ? { bob: { admin: false, fullName: 'Bob' } } : {}; };
  await assert.rejects(sb.archiveUser(user), /sb_account_ownership_conflict/); assert.deepEqual(calls, ['GET','GET']);
});

test('deletion waits for an outstanding QR status call and rejects its late confirmation', async t => {
  const { WechatManager } = await import('../src/wechat.mjs');
  const { store } = fixture(t), user = store.createUser('alice', 'fake');
  let resolveStatus; const delayed = new Promise(resolve => { resolveStatus = resolve; });
  const client = { async qr() { return { qrcode: 'FAKE_QR', qrcode_img_content: 'https://example.invalid/fake-qr' }; }, async status() { return delayed; } };
  const wechat = new WechatManager(store, client);
  const qr = await wechat.login(user.id), check = wechat.status(user.id, qr.id);
  const deleted = new UserDeletion(store, { wechat }).remove(user.id, 'alice');
  assert.equal(store.usable(user.id), false); assert.ok(store.userById(user.id));
  resolveStatus({ status: 'confirmed', bot_token: 'FAKE', ilink_bot_id: 'fake-bot', ilink_user_id: 'fake-user', baseurl: 'https://ilinkai.weixin.qq.com' });
  await check; await deleted;
  assert.equal(store.userById(user.id), undefined); assert.equal(store.wechatBindings().length, 0);
  await wechat.close();
});
