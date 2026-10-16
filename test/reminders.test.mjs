import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Reminders } from '../src/reminders.mjs';
import { WechatManager } from '../src/wechat.mjs';

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
test('daily reminders survive restart and collapse missed days into one delivery', t => {
  const { store, directory, alice, reminders } = fixture(t), now = Date.now(); connect(store, alice, 'a');
  const task = reminders.create(alice.id, { text: 'DAILY_FAKE', at: new Date(now + 1000).toISOString(), daily: true }, now);
  // Reopen a separate connection to simulate scheduler reconstruction from persisted state.
  const reopened = new Store(directory);
  try {
    const scheduler = new Reminders(reopened), overdue = now + 3 * 86400000 + 2000;
    scheduler.tick(overdue); scheduler.tick(overdue);
    assert.equal(reopened.deliveries().length, 1);
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
