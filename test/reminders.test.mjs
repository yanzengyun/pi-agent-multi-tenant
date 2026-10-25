import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Reminders } from '../src/reminders.mjs';
import { ILinkClient, WechatManager } from '../src/wechat.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reminders-')), store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const alice = store.createUser('alice', 'fake'), bob = store.createUser('bob', 'fake');
  return { store, directory, alice, bob, reminders: new Reminders(store) };
}
function connect(store, user, suffix) {
  const binding = store.bindWechat(user.id, { botId: 'bot-' + suffix, remoteUser: 'peer-' + suffix, token: 'fake-' + suffix, baseUrl: 'https://ilinkai.weixin.qq.com' });
  store.acceptWechat(binding, { id: 'fake-first-' + suffix, text: 'hello', contextToken: 'context-' + suffix });
  return binding;
}
test('reminders wait for an own WeChat message and enqueue once without a model', t => {
  const { store, alice, bob, reminders } = fixture(t), now = Date.now();
  const task = reminders.create(alice.id, { text: 'ALICE_REMINDER', at: new Date(now + 1000).toISOString() }, now);
  reminders.tick(now + 2000); assert.equal(reminders.list(alice.id)[0].status, 'waiting_for_wechat');
  connect(store, bob, 'b'); reminders.tick(now + 2000); assert.equal(store.deliveries().length, 0);
  connect(store, alice, 'a'); reminders.tick(now + 2000); reminders.tick(now + 3000);
  const deliveries = store.deliveries(); assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].user_id, alice.id); assert.equal(deliveries[0].context_token, 'context-a');
  assert.equal(deliveries[0].response, 'ALICE_REMINDER'); assert.equal(deliveries[0].status, 'completed');
  assert.throws(() => reminders.remove(bob.id, task.id), /reminder_not_found/);
  reminders.remove(alice.id, task.id); assert.equal(store.deliveries().length, 0);
});
test('daily reminders survive restart and skip expired missed days', t => {
  const { store, directory, alice, reminders } = fixture(t), now = Date.now(); connect(store, alice, 'a');
  const task = reminders.create(alice.id, { text: 'DAILY_FAKE', at: new Date(now + 1000).toISOString(), daily: true }, now);
  // Reopen a separate connection to simulate scheduler reconstruction from persisted state.
  const reopened = new Store(directory);
  try {
    const scheduler = new Reminders(reopened), overdue = now + 3 * 86400000 + 2000;
    scheduler.tick(overdue); scheduler.tick(overdue);
    assert.equal(reopened.deliveries().length, 0);
    const next = scheduler.list(alice.id)[0]; assert.equal(next.id, task.id); assert.ok(next.next_at > overdue);
    assert.equal((next.next_at - task.next_at) % 86400000, 0);
  } finally { reopened.close(); }
});
test('invalid dates, missing timezone, past time and per-user limits are rejected', t => {
  const { alice, reminders } = fixture(t), now = Date.now(), at = new Date(now + 10000).toISOString();
  for (const value of ['tomorrow', '2026-10-14T09:00', '2027-02-30T09:00:00+08:00', 'bad', new Date(now - 1000).toISOString()]) {
    assert.throws(() => reminders.create(alice.id, { text: 'fake', at: value }, now));
  }
  for (let i = 0; i < 20; i++) reminders.create(alice.id, { text: 'fake', at }, now);
  assert.throws(() => reminders.create(alice.id, { text: 'fake', at }, now), /reminder_limit/);
});

test('scheduled delivery uses the latest own context and never the other user context', async t => {
  const { store, alice, bob, reminders } = fixture(t), now = Date.now();
  const a = connect(store, alice, 'a'); connect(store, bob, 'b');
  reminders.create(alice.id, { text: 'ALICE_ONLY', at: new Date(now + 1000).toISOString() }, now);
  reminders.tick(now + 2000);
  store.acceptWechat(a, { id: 'fake-second-a', text: 'update', contextToken: 'context-a-latest' });
  const sent = [], manager = new WechatManager(store, { async send(binding, inbox, text) { sent.push({ peer: binding.remote_user, context: inbox.context_token, text }); } });
  await manager.flush(); await manager.close();
  assert.deepEqual(sent, [{ peer: 'peer-a', context: 'context-a-latest', text: 'ALICE_ONLY' }]);
});


test('scheduled reminders do not reset the previous user-message clock', t => {
  const { store, alice, reminders } = fixture(t), now = Date.now();
  const binding = connect(store, alice, 'clock');
  const first = store.pending()[0];
  store.db.prepare('UPDATE runs SET created_at=? WHERE id=?').run(now - 900000, first.id);
  reminders.create(alice.id, { text: 'CLOCK_REMINDER', at: new Date(now + 1000).toISOString() }, now);
  reminders.tick(now + 2000);
  const current = store.createRun(alice.id, binding.conversation_id, 'after reminder');
  assert.equal(store.previousUserRunReceivedAt(alice.id, binding.conversation_id, current.id), now - 900000);
});

test('weekdays-only reminders advance Friday to Monday and weekend creation starts Monday', t => {
  const { store, alice, reminders } = fixture(t); connect(store, alice, 'weekday');
  const now = Date.parse('2026-10-23T08:00:00+08:00');
  reminders.create(alice.id, { text: 'weekday', at: '2026-10-23T09:00:00+08:00', daily: true, weekdaysOnly: true }, now);
  reminders.tick(Date.parse('2026-10-23T09:00:01+08:00'));
  assert.equal(new Date(reminders.list(alice.id)[0].next_at).toISOString(), '2026-10-26T01:00:00.000Z');
  const weekend = reminders.create(alice.id, { text: 'weekend input', at: '2026-10-24T10:00:00+08:00', daily: true, weekdaysOnly: true }, now);
  assert.equal(new Date(weekend.next_at).toISOString(), '2026-10-26T02:00:00.000Z');
  assert.throws(() => reminders.create(alice.id, { text: 'bad', at: '2026-10-24T10:00:00+08:00', weekdaysOnly: true }, now), /invalid_reminder/);
});

test('expired outbox reminders never send; other users and fresh reminders continue', async t => {
  const { store, alice, bob, reminders } = fixture(t); connect(store, alice, 'expired'); connect(store, bob, 'fresh');
  const now = Date.now();
  const old = reminders.create(alice.id, { text: 'old', at: new Date(now + 1000).toISOString() }, now);
  reminders.tick(now + 2000);
  store.db.prepare("UPDATE wechat_inbox SET message_id=? WHERE user_id=? AND message_id LIKE 'reminder:%'").run(`reminder:${old.id}:${now - 31 * 60000}`, alice.id);
  reminders.create(bob.id, { text: 'fresh', at: new Date(now + 1000).toISOString() }, now); reminders.tick(now + 2000);
  const sent = [], manager = new WechatManager(store, { async send(binding) { sent.push(binding.user_id); } });
  await manager.flush(); await manager.close();
  assert.deepEqual(sent, [bob.id]);
  assert.equal(store.db.prepare("SELECT delivery FROM wechat_inbox WHERE user_id=? AND message_id LIKE 'reminder:%'").get(alice.id).delivery, 'expired');
});

test('reminder failures persist safe diagnostics/backoff across restart and stop after four attempts', async t => {
  const { store, directory, alice, reminders } = fixture(t), now = Date.now(); connect(store, alice, 'retry');
  reminders.create(alice.id, { text: 'retry', at: new Date(now + 1000).toISOString() }, now); reminders.tick(now + 2000);
  let calls = 0;
  const client = { async send() { calls++; const e = new Error('PRIVATE_TOKEN'); e.wechat = { ret: -2, prepareFailed: true }; throw e; } };
  const first = new WechatManager(store, client); await first.flush(); await first.close();
  const reopened = new Store(directory), manager = new WechatManager(reopened, client);
  try {
    await manager.flush(); assert.equal(calls, 1);
    for (let i = 0; i < 3; i++) { reopened.db.exec('UPDATE wechat_delivery_state SET next_at=0'); await manager.flush(); }
    assert.equal(calls, 4); assert.equal(reopened.deliveries().length, 0);
    assert.equal(reopened.db.prepare("SELECT delivery FROM wechat_inbox WHERE message_id LIKE 'reminder:%'").get().delivery, 'failed');
    const diagnostics = reopened.db.prepare("SELECT payload FROM traces WHERE kind='wechat_delivery_failed'").all();
    assert.equal(diagnostics.length, 4); assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_TOKEN'));
  } finally { await manager.close(); reopened.close(); }
});

test('prepare-failed fallback omits context entirely and preserves client ID; unrelated errors do not retry', async () => {
  const sent = [], client = new ILinkClient({ fetcher: async (_url, options) => {
    const msg = JSON.parse(options.body).msg; sent.push(msg);
    return Response.json(sent.length === 1 ? { ret: -2, errmsg: 'prepare failed' } : { message_id: 'accepted' });
  } });
  const binding = { base_url: 'https://ilinkai.weixin.qq.com', token: 'fake', remote_user: 'own' };
  const result = await client.send(binding, { context_token: 'private-context' }, 'text', 'stable-id');
  assert.equal(result.contextFallback, true); assert.equal(sent.length, 2);
  assert.equal(sent[0].context_token, 'private-context'); assert.ok(!Object.hasOwn(sent[1], 'context_token'));
  assert.equal(sent[0].client_id, sent[1].client_id);
  for (const body of [{ ret: -2, errmsg: 'other failure' }, {}, { message_id: 'bad', errcode: -1 }]) {
    let calls = 0;
    const failing = new ILinkClient({ fetcher: async () => { calls++; return Response.json(body); } });
    await assert.rejects(failing.send(binding, { context_token: 'own' }, 'text', 'id'));
    assert.equal(calls, 1);
  }
});

test('weekday migration also suppresses weekend reminders already queued by old scheduler', async t => {
  const { store, alice, reminders } = fixture(t); connect(store, alice, 'weekend-outbox');
  const now = Date.now(), task = reminders.create(alice.id, { text: 'workday', at: new Date(now + 1000).toISOString(), daily: true }, now);
  reminders.tick(now + 2000);
  store.db.prepare('UPDATE reminder_schedules SET weekdays_only=1 WHERE reminder_id=?').run(task.id);
  store.db.prepare("UPDATE wechat_inbox SET message_id=? WHERE user_id=? AND message_id LIKE 'reminder:%'").run(`reminder:${task.id}:${Date.parse('2026-10-25T17:30:00+08:00')}`, alice.id);
  let calls = 0; const manager = new WechatManager(store, { async send() { calls++; } });
  await manager.flush(); await manager.close();
  assert.equal(calls, 0);
  assert.equal(store.db.prepare("SELECT delivery FROM wechat_inbox WHERE message_id LIKE 'reminder:%'").get().delivery, 'cancelled');
});
