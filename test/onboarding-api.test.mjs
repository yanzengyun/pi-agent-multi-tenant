import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { MockEngine } from '../src/engine.mjs';
import { makeServer } from '../src/server.mjs';

test('only administrators can issue/cancel QR logins or retrieve human SB credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-onboarding-api-')), store = new Store(directory);
  const responses = new Map(), prepared = new Set();
  let qrCount = 0;
  const wechatClient = {
    async qr() { return { qrcode: 'fake-qr-' + ++qrCount, qrcode_img_content: 'https://weixin.qq.com/fake' }; },
    async status(id) { return responses.get(id) || { status: 'wait' }; },
    async updates(_binding, signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
  };
  const silverbullet = {
    view(id) { return { status: prepared.has(id) ? 'ready' : 'not_provisioned' }; },
    async provision(user) { prepared.add(user.id); return this.view(user.id); },
    loginDetails(id) { assert.ok(prepared.has(id)); return { username: 'fake-human-user', password: 'fake-human-private-password' }; },
    tools() { return null; }, async close() {},
  };
  const app = await makeServer({ store, engine: new MockEngine(), adminPassword: 'admin-fixture-password', wechatClient, silverbullet });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function api(path, token, method = 'GET', data) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  const admin = (await api('/api/login', null, 'POST', { username: 'admin', password: 'admin-fixture-password' })).data.token;
  const alice = (await api('/api/admin/users', admin, 'POST', { username: 'alice', password: 'alice-fixture-password' })).data;
  const bob = (await api('/api/admin/users', admin, 'POST', { username: 'bob' })).data;
  const aliceToken = (await api('/api/login', null, 'POST', { username: 'alice', password: 'alice-fixture-password' })).data.token;
  assert.equal((await api(`/api/admin/users/${alice.id}/wechat/login`, aliceToken, 'POST', {})).status, 403);
  assert.equal(qrCount, 0);
  const qr = (await api(`/api/admin/users/${alice.id}/wechat/login`, admin, 'POST', {})).data;
  assert.match(qr.image, /^data:image\/png/);
  assert.equal((await api(`/api/admin/users/${bob.id}/wechat/login/${qr.id}`, admin)).status, 404);
  assert.equal((await api(`/api/admin/users/${alice.id}/wechat/login/${qr.id}`, aliceToken)).status, 403);
  const qrToken = store.loginAttempt(alice.id, qr.id).qr_token;
  responses.set(qrToken, { status: 'confirmed', bot_token: 'fake-api-private-token', ilink_bot_id: 'fake-api-bot', ilink_user_id: 'fake-api-peer' });
  const confirmed = await api(`/api/admin/users/${alice.id}/wechat/login/${qr.id}`, admin);
  assert.equal(confirmed.data.status, 'confirmed'); assert.ok(prepared.has(alice.id)); assert.ok(!prepared.has(bob.id));
  assert.equal((await api(`/api/admin/users/${alice.id}/silverbullet/credentials`, aliceToken, 'POST', {})).status, 403);
  assert.equal((await api(`/api/admin/users/${alice.id}/silverbullet/credentials`, admin, 'POST', {})).data.password, 'fake-human-private-password');
  const listing = await api('/api/admin/users', admin);
  assert.ok(!JSON.stringify(listing.data).includes('fake-api-private-token'));
  assert.ok(!JSON.stringify(listing.data).includes('fake-human-private-password'));
  assert.equal((await api(`/api/admin/users/${alice.id}/wechat`, admin, 'DELETE', {})).status, 200);
  assert.equal(store.wechatBinding(alice.id), undefined);
});
