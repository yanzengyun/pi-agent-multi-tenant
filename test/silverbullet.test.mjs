import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { SilverBullet, notePath } from '../src/silverbullet.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-sb-test-')), store = new Store(directory);
  const state = { users: {}, spaces: {}, tokens: new Map(), files: new Map(), minted: 0, loseCreateResponse: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks).toString();
    const json = raw && req.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : {};
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/.dashboard/api/login') { res.setHeader('Set-Cookie', 'sb-session=fake-admin; Path=/; HttpOnly'); return reply(200, { status: 'ok' }); }
    if (path.startsWith('/.dashboard/api/admin/')) {
      if (req.headers.cookie !== 'sb-session=fake-admin') return reply(401, {});
      const resource = path.slice('/.dashboard/api/admin/'.length);
      if (resource === 'users') {
        if (req.method === 'GET') return reply(200, state.users);
        state.users[json.username] = json; return reply(200, { status: 'ok' });
      }
      const token = resource.match(/^users\/([^/]+)\/tokens(?:\/([^/]+))?$/);
      if (token) {
        if (req.method === 'DELETE') { for (const [key, value] of state.tokens) if (value.user === token[1] && value.name === token[2]) state.tokens.delete(key); return reply(200, { status: 'ok' }); }
        const key = 'fake-agent-token-' + ++state.minted; state.tokens.set(key, { user: token[1], name: json.name }); return reply(200, { token: key });
      }
      if (resource === 'spaces') {
        if (req.method === 'GET') return reply(200, state.spaces);
        const id = randomUUID(); state.spaces[id] = json;
        if (state.loseCreateResponse) { state.loseCreateResponse = false; return reply(502, {}); }
        return reply(200, { id });
      }
      if (resource.startsWith('spaces/')) {
        if (req.method === 'PATCH') {
          Object.assign(state.spaces[resource.slice(7)], json);
          if (state.losePatchResponse) { state.losePatchResponse = false; return reply(502, {}); }
        }
        return reply(200, state.spaces[resource.slice(7)]);
      }
      const password = resource.match(/^users\/([^/]+)\/password$/);
      if (password) { state.users[password[1]].password = json.password; return reply(200, { status: 'ok' }); }
      const account = resource.match(/^users\/([^/]+)$/);
      if (account && req.method === 'DELETE') { delete state.users[account[1]]; return reply(200, { status: 'ok' }); }
      return reply(404, {});
    }
    const note = path.match(/^(\/users\/[^/]+)\/\.fs\/(.+)$/);
    if (note) {
      const token = state.tokens.get((req.headers.authorization || '').slice(7));
      const space = Object.values(state.spaces).find(space => space.binding.prefix === note[1]);
      if (!token || !space?.members[token.user]) return reply(403, {});
      const key = note[1] + '/' + decodeURIComponent(note[2]), previous = state.files.get(key);
      if (req.method === 'PUT') {
        if ((req.headers['if-none-match'] === '*' && previous) ||
            (req.headers['if-match'] && req.headers['if-match'] !== previous?.etag)) return reply(412, {});
        const value = { content: raw, etag: '"' + randomUUID() + '"' }; state.files.set(key, value);
        res.setHeader('ETag', value.etag); res.end(''); return;
      }
      if (!previous) return reply(404, {});
      res.setHeader('ETag', previous.etag); res.end(previous.content); return;
    }
    reply(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const sb = new SilverBullet(store, { baseUrl, username: 'fake-admin', password: 'fake-admin-password' });
  t.after(async () => { await sb.close(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, sb, state, baseUrl };
}

test('provisioning creates separate human/agent accounts and private spaces without exposing tokens', async t => {
  const { store, sb, state, baseUrl } = await fixture(t);
  const alice = store.createUser('alice', 'fake-hash'), bob = store.createUser('bob', 'fake-hash');
  const a = await sb.provision(alice), b = await sb.provision(bob);
  assert.equal(a.status, 'ready'); assert.notEqual(a.url, b.url);
  assert.equal(Object.keys(state.users).length, 4); assert.equal(Object.keys(state.spaces).length, 2);
  assert.ok(Object.values(state.users).every(user => user.admin === false));
  assert.ok(Object.values(state.spaces).every(space => space.access === 'none' && space.shell.enabled === false && Object.keys(space.members).length === 2));
  assert.ok(!JSON.stringify(a).includes('fake-agent-token'));
  await sb.provision(alice); assert.equal(state.minted, 2);
  await sb.file(alice.id, '私有/测试', { method: 'PUT', content: 'ALICE_PRIVATE' });
  assert.equal((await sb.file(alice.id, '私有/测试')).content, 'ALICE_PRIVATE');
  await assert.rejects(sb.file(bob.id, '私有/测试'), /note_not_found/);
  const aToken = store.integration(alice.id, 'silverbullet').state.token;
  const bPrefix = store.integration(bob.id, 'silverbullet').state.prefix;
  const cross = await fetch(baseUrl + bPrefix + '/.fs/index.md', { headers: { Authorization: 'Bearer ' + aToken } });
  assert.equal(cross.status, 403);
  await assert.rejects(sb.file(alice.id, '私有/测试', { method: 'PUT', content: 'overwrite' }), /note_conflict/);
  const prior = await sb.file(alice.id, '私有/测试');
  await sb.file(alice.id, '私有/测试', { method: 'PUT', content: 'updated', etag: prior.etag });
  await assert.rejects(sb.file(alice.id, '私有/测试', { method: 'PUT', content: 'stale', etag: prior.etag }), /note_conflict/);
});

test('lost create response resumes provisioning without duplicate spaces or resetting passwords', async t => {
  const { store, sb, state } = await fixture(t), user = store.createUser('alice', 'fake-hash');
  state.loseCreateResponse = true;
  await assert.rejects(sb.provision(user), /sb_admin_request_failed/);
  const password = store.integration(user.id, 'silverbullet').state.humanPassword;
  assert.equal(store.integration(user.id, 'silverbullet').status, 'failed');
  await sb.provision(user);
  assert.equal(Object.keys(state.spaces).length, 1); assert.equal(Object.keys(state.users).length, 2);
  assert.equal(store.integration(user.id, 'silverbullet').state.humanPassword, password);
});

test('malformed permissions fail closed before minting an agent token', async t => {
  const { store, sb, state } = await fixture(t), user = store.createUser('alice', 'fake-hash');
  state.loseCreateResponse = true; await assert.rejects(sb.provision(user));
  Object.values(state.spaces)[0].access = 'write';
  await assert.rejects(sb.provision(user), /sb_space_permissions_mismatch/);
  assert.equal(state.minted, 0);
});

test('note names cannot escape the assigned space or address privileged endpoints', () => {
  for (const page of ['../secret', '/users/bob/index', 'a/../b', '.dashboard', 'a\\b', '%2e%2e/secret', 'a?token=x', 'a//b']) {
    assert.throws(() => notePath(page), /invalid_note_path/);
  }
  assert.equal(notePath('日记/今天'), '%E6%97%A5%E8%AE%B0/%E4%BB%8A%E5%A4%A9.md');
});

test('users can rename human note accounts without replacing agent tokens or retaining their password', async t => {
  const { store, sb, state } = await fixture(t), alice = store.createUser('alice', 'fake');
  await sb.provision(alice); await sb.file(alice.id, 'keep', { method: 'PUT', content: 'FAKE_PRESERVED' });
  const before = store.integration(alice.id, 'silverbullet').state;
  const result = await sb.setHumanLogin(alice, { username: 'alice_custom', password: 'chosen-fake-password' });
  const after = store.integration(alice.id, 'silverbullet').state;
  assert.equal(result.username, 'alice_custom'); assert.equal(after.spaceId, before.spaceId); assert.equal(after.token, before.token);
  assert.equal(after.humanPassword, null); assert.equal(sb.loginDetails(alice.id).passwordManagedByUser, true);
  assert.ok(!JSON.stringify(after).includes('chosen-fake-password')); assert.equal(state.minted, 1);
  assert.equal(state.users.alice_custom.admin, false); assert.equal(state.users[before.humanUsername], undefined);
  assert.deepEqual(Object.keys(state.spaces[before.spaceId].members).sort(), ['alice_custom', before.agentUsername].sort());
  assert.equal((await sb.file(alice.id, 'keep')).content, 'FAKE_PRESERVED');
  await sb.setHumanLogin(alice, { username: 'alice_custom', password: 'changed-fake-password' });
  assert.equal(state.users.alice_custom.password, 'changed-fake-password');
});

test('note login changes reject another user account and resume a lost membership response', async t => {
  const { store, sb, state } = await fixture(t), alice = store.createUser('alice', 'fake'), bob = store.createUser('bob', 'fake');
  await sb.provision(alice); await sb.provision(bob);
  const b = store.integration(bob.id, 'silverbullet').state;
  await assert.rejects(sb.setHumanLogin(alice, { username: b.humanUsername, password: 'fake-password-12' }), /sb_username_conflict/);
  state.losePatchResponse = true;
  await assert.rejects(sb.setHumanLogin(alice, { username: 'alice_custom', password: 'fake-password-12' }), /sb_admin_request_failed/);
  await sb.setHumanLogin(alice, { username: 'alice_custom', password: 'fake-password-12' });
  assert.equal(store.integration(alice.id, 'silverbullet').state.humanUsername, 'alice_custom'); assert.equal(state.minted, 2);
  assert.equal(store.integration(bob.id, 'silverbullet').state.humanUsername, b.humanUsername);
});

test('internal admin requests preserve the public Host required by native primary-origin auth', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    seen.push({host:req.headers.host, proto:req.headers['x-forwarded-proto']});
    res.setHeader('Content-Type','application/json');
    if (req.url.endsWith('/login')) {res.setHeader('Set-Cookie','auth_public=fake; HttpOnly');res.end('{"status":"ok"}');}
    else {assert.equal(req.headers.cookie,'auth_public=fake');res.end('{"ok":true}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const sb = new SilverBullet(null,{baseUrl:'http://127.0.0.1:'+server.address().port,publicUrl:'https://notes.example.test:32651',username:'fake',password:'fake-password'});
  assert.deepEqual(await sb.admin('users'),{ok:true});
  assert.deepEqual(seen,[{host:'notes.example.test:32651',proto:'https'},{host:'notes.example.test:32651',proto:'https'}]);
});
