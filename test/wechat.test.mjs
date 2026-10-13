import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { WechatManager, wechatBase } from '../src/wechat.mjs';
import { RunQueue } from '../src/queue.mjs';
import { MockEngine } from '../src/engine.mjs';

export class FakeWechat {
  constructor() { this.count = 0; this.sent = []; this.responses = new Map(); this.failSend = false; }
  async qr() { const id = 'fake-qr-' + ++this.count; return { qrcode: id, qrcode_img_content: 'https://weixin.qq.com/' + id }; }
  async status(token) { return this.responses.get(token) || { status: 'wait' }; }
  async updates(_binding, signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
  async send(binding, inbox, text, clientId) {
    this.sent.push({ localUser: binding.user_id, receiver: binding.remote_user, context: inbox.context_token, text, clientId });
    if (this.failSend) throw new Error('temporary_failure');
  }
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-wechat-test-')), store = new Store(directory);
  const alice = store.createUser('alice', 'fake-hash'), bob = store.createUser('bob', 'fake-hash');
  const client = new FakeWechat(), manager = new WechatManager(store, client, options);
  t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, alice, bob, client, manager };
}
function confirm(client, store, user, login, suffix) {
  client.responses.set(store.loginAttempt(user.id, login.id).qr_token, { status: 'confirmed', bot_token: 'fake-private-token-' + suffix,
    ilink_bot_id: 'fake-bot-' + suffix, ilink_user_id: 'fake-peer-' + suffix, baseurl: 'https://ilinkai.weixin.qq.com' });
}

test('QRs are isolated, expire and cannot be silently reused after cancellation', async t => {
  const { store, alice, bob, client, manager } = fixture(t);
  const a = await manager.login(alice.id), b = await manager.login(bob.id);
  assert.match(a.image, /^data:image\/png;base64,/);
  assert.ok(!JSON.stringify(a).includes('fake-qr-1'));
  await assert.rejects(manager.status(bob.id, a.id), /login_not_found/);
  manager.cancelLogin(alice.id, a.id);
  assert.equal((await manager.status(alice.id, a.id)).status, 'cancelled');
  store.db.prepare('UPDATE wechat_logins SET expires_at=0 WHERE id=?').run(b.id);
  assert.equal((await manager.status(bob.id, b.id)).status, 'expired');
  assert.equal(store.loginAttempt(bob.id, b.id).qr_token, null);
  const fresh = await manager.login(alice.id); confirm(client, store, alice, fresh, 'a');
  await manager.status(alice.id, fresh.id);
  manager.cancelLogin(alice.id, fresh.id);
  assert.equal(manager.view(alice.id).status, 'connected');
});

test('late scan confirmation cannot bind a cancelled or superseded login', async t => {
  const { store, alice, manager, client } = fixture(t);
  const a = await manager.login(alice.id); let resolve;
  client.status = () => new Promise(r => { resolve = r; });
  const checking = manager.status(alice.id, a.id);
  manager.cancelLogin(alice.id, a.id);
  resolve({ status: 'confirmed', bot_token: 'fake-late-token', ilink_bot_id: 'late-bot', ilink_user_id: 'late-peer' });
  assert.equal((await checking).status, 'cancelled');
  assert.equal(store.wechatBinding(alice.id), undefined);
});

test('same WeChat identity cannot bind two tenants and production identities are protected', async t => {
  const { store, alice, bob, manager, client } = fixture(t, { protectedBots: ['fake-bot-production'] });
  const protectedQr = await manager.login(alice.id); confirm(client, store, alice, protectedQr, 'production');
  await assert.rejects(manager.status(alice.id, protectedQr.id), /protected_wechat_identity/);
  assert.equal(store.wechatBinding(alice.id), undefined);
  const a = await manager.login(alice.id); confirm(client, store, alice, a, 'a'); await manager.status(alice.id, a.id);
  const b = await manager.login(bob.id); confirm(client, store, bob, b, 'a');
  await assert.rejects(manager.status(bob.id, b.id), /wechat_identity_already_bound/);
  assert.equal(store.wechatBinding(bob.id), undefined);
});

test('shutdown rejects late QR and scan responses without accessing a closed database', async t => {
  const { store, alice, manager, client } = fixture(t);
  const qr = await manager.login(alice.id); let resolveStatus;
  client.status = () => new Promise(resolve => { resolveStatus = resolve; });
  const checking = manager.status(alice.id, qr.id);
  let resolveQr;
  client.qr = () => new Promise(resolve => { resolveQr = resolve; });
  const creating = manager.login(alice.id);
  await manager.close();
  // Any lookup after shutdown would fail, as it would after Store.close().
  store.loginAttempt = () => { throw new Error('database_closed'); };
  resolveStatus({ status: 'confirmed', bot_token: 'fake-token', ilink_bot_id: 'late-bot', ilink_user_id: 'late-peer' });
  resolveQr({ qrcode: 'late-qr', qrcode_img_content: 'https://weixin.qq.com/fake' });
  await assert.rejects(checking, /wechat_closed/);
  await assert.rejects(creating, /wechat_closed/);
  assert.equal(store.wechatBinding(alice.id), undefined);
});

test('unbinding does not allow a different person to inherit the previous memory or identity', async t => {
  const { store, alice, bob, manager, client } = fixture(t);
  const qr = await manager.login(alice.id); confirm(client, store, alice, qr, 'a'); await manager.status(alice.id, qr.id);
  store.writeMemory(alice.id, 'ALICE_PRIVATE'); manager.disconnect(alice.id);
  const differentPerson = await manager.login(alice.id); confirm(client, store, alice, differentPerson, 'b');
  await assert.rejects(manager.status(alice.id, differentPerson.id), /wechat_identity_mismatch/);
  const reassigned = await manager.login(bob.id); confirm(client, store, bob, reassigned, 'a');
  await assert.rejects(manager.status(bob.id, reassigned.id), /wechat_identity_mismatch/);
  assert.equal(store.wechatBinding(alice.id), undefined); assert.equal(store.wechatBinding(bob.id), undefined);
  const samePerson = await manager.login(alice.id); confirm(client, store, alice, samePerson, 'a');
  assert.equal((await manager.status(alice.id, samePerson.id)).status, 'confirmed');
  assert.equal(store.memory(alice.id), 'ALICE_PRIVATE');
});

test('sender is verified before context or model input; message replay is deduplicated', async t => {
  const { store, alice, bob, manager, client } = fixture(t);
  const a = await manager.login(alice.id); confirm(client, store, alice, a, 'a'); await manager.status(alice.id, a.id);
  const binding = store.wechatBinding(alice.id);
  const raw = { message_type: 1, message_id: 'fake-message-1', from_user_id: 'fake-peer-a', to_user_id: 'fake-bot-a',
    context_token: 'fake-own-context', item_list: [{ type: 1, text_item: { text: 'remember: ALICE_PRIVATE' } }] };
  manager.ingest(binding, { ...raw, from_user_id: 'fake-peer-b', context_token: 'fake-foreign-context' });
  assert.equal(store.pending().length, 0);
  manager.ingest(binding, raw); manager.ingest(binding, raw);
  assert.equal(store.pending().length, 1);
  const queue = new RunQueue(store, new MockEngine()); await queue.work; await manager.flush();
  assert.equal(store.memory(alice.id), 'ALICE_PRIVATE'); assert.equal(store.memory(bob.id), '');
  assert.equal(client.sent.length, 1); assert.equal(client.sent[0].receiver, 'fake-peer-a');
  assert.equal(client.sent[0].context, 'fake-own-context');
  await queue.close();
});

test('failed deliveries retain stable client IDs; unbinding cancels pending replies', async t => {
  const { store, alice, manager, client } = fixture(t);
  const a = await manager.login(alice.id); confirm(client, store, alice, a, 'a'); await manager.status(alice.id, a.id);
  const binding = store.wechatBinding(alice.id);
  const raw = { message_type: 1, message_id: 'm1', from_user_id: binding.remote_user, context_token: 'fake-context', item_list: [{ type: 1, text_item: { text: 'hello' } }] };
  manager.ingest(binding, raw); const queue = new RunQueue(store, new MockEngine()); await queue.work;
  client.failSend = true; await manager.flush(); assert.equal(store.deliveries().length, 1);
  client.failSend = false; await manager.flush();
  assert.equal(client.sent[0].clientId, client.sent[1].clientId); assert.equal(store.deliveries().length, 0);
  manager.ingest(binding, { ...raw, message_id: 'm2' }); queue.kick(); await queue.work;
  manager.disconnect(alice.id); await manager.flush();
  assert.equal(client.sent.length, 2); assert.equal(store.deliveries().length, 0);
  await queue.close();
});

test('provider redirects cannot reach arbitrary hosts or loopback', () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://127.0.0.1', 'https://ilinkai.weixin.qq.com.evil.test', 'https://user:secret@ilinkai.weixin.qq.com']) {
    assert.throws(() => wechatBase(value), /untrusted_wechat_host/);
  }
  assert.equal(wechatBase('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
});

test('bindings, cursor and inbox survive restart without re-running a replayed message', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-wechat-restart-'));
  let store = new Store(directory), manager = new WechatManager(store, new FakeWechat());
  t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const user = store.createUser('alice', 'fake-hash');
  const credentials = { botId: 'restart-bot', remoteUser: 'restart-peer', token: 'fake-restart-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const binding = store.bindWechat(user.id, credentials);
  const raw = { message_type: 1, message_id: 'restart-message', from_user_id: 'restart-peer', context_token: 'fake-restart-context', item_list: [{ type: 1, text_item: { text: 'remember: RESTART_OWN_MEMORY' } }] };
  manager.ingest(binding, raw); store.bindingCursor(binding.id, 'fake-cursor-1');
  await manager.close(); store.close();
  store = new Store(directory); const client = new FakeWechat(); manager = new WechatManager(store, client); manager.start();
  assert.equal(store.wechatBinding(user.id).cursor, 'fake-cursor-1');
  manager.ingest(store.wechatBinding(user.id), raw);
  assert.equal(store.pending().length, 1);
  const queue = new RunQueue(store, new MockEngine()); await queue.work; await manager.flush();
  manager.ingest(store.wechatBinding(user.id), raw);
  assert.equal(store.pending().length, 0); assert.equal(client.sent.length, 1);
  assert.equal(store.memory(user.id), 'RESTART_OWN_MEMORY'); await queue.close();
});

test('processing notice precedes execution and reply; replay does not resend it', async t => {
  const { store, alice, manager, client } = fixture(t);
  const binding = store.bindWechat(alice.id, { token: 'fake-token', botId: 'notice-bot', remoteUser: 'notice-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
  const raw = { message_type: 1, message_id: 'notice-message', from_user_id: binding.remote_user,
    context_token: 'notice-context', item_list: [{ type: 1, text_item: { text: 'hello' } }] };
  manager.ingest(binding, raw);
  let modelCalls = 0;
  const queue = new RunQueue(store, { async run() {
    modelCalls++;
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].text, '✅ 已收到，pi 处理中...');
    return 'done';
  } }, { beforeRun: run => manager.processing(run) });
  await queue.work; await manager.flush();
  manager.ingest(binding, raw); queue.kick(); await queue.work; await manager.flush();
  assert.equal(modelCalls, 1);
  assert.deepEqual(client.sent.map(message => message.text), ['✅ 已收到，pi 处理中...', 'done']);
  assert.ok(client.sent.every(message => message.localUser === alice.id && message.receiver === binding.remote_user && message.context === 'notice-context'));
  assert.notEqual(client.sent[0].clientId, client.sent[1].clientId);
  await queue.close();
});

test('failed processing notice does not block execution or final delivery', async t => {
  const { store, alice, manager, client } = fixture(t);
  const binding = store.bindWechat(alice.id, { token: 'fake-token', botId: 'failure-bot', remoteUser: 'failure-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
  manager.ingest(binding, { message_type: 1, message_id: 'notice-failure', from_user_id: binding.remote_user,
    context_token: 'failure-context', item_list: [{ type: 1, text_item: { text: 'hello' } }] });
  client.failSend = true;
  const queue = new RunQueue(store, { async run() { client.failSend = false; return 'done'; } }, { beforeRun: run => manager.processing(run) });
  await queue.work; await manager.flush();
  assert.deepEqual(client.sent.map(message => message.text), ['✅ 已收到，pi 处理中...', 'done']);
  assert.equal(store.deliveries().length, 0);
  await queue.close();
});
