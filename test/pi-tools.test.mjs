import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiEngine } from '../src/pi-engine.mjs';
import { RunQueue } from '../src/queue.mjs';
import { Store } from '../src/store.mjs';

function fixture(t, action, contextFactory, prepareEngine) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tools-'));
  const store = new Store(directory), engine = new PiEngine({ provider: 'fake', model: 'fake' });
  prepareEngine?.(engine);
  engine.Type = { Object: value => value, String: value => value, Number: value => value, Boolean: value => value, Optional: value => value };
  engine.sdk = {
    createExtensionRuntime: () => ({}),
    ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => {}, getModel: () => ({}) }) },
    SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
    SettingsManager: { inMemory: () => ({}) },
    async createAgentSession(options) {
      assert.equal(options.resourceLoader.getSystemPrompt(), undefined, 'must keep native Pi system builder');
      let system = 'PI_NATIVE_TEST_DOUBLE\n' + options.resourceLoader.getAgentsFiles().agentsFiles.map(f => f.content).join('\n') + '\n' + options.customTools.map(t => t.name + ': ' + (t.promptGuidelines ?? []).join('\n')).join('\n');
      const session = {
        systemPrompt: system, messages: [],
        getActiveToolNames: () => options.tools, subscribe: () => () => {}, dispose() {},
        async prompt(prompt) {
          for (const ext of options.resourceLoader.getExtensions().extensions) {
            for (const handler of ext.handlers.get('before_agent_start') ?? []) {
              const result = await handler({ systemPrompt: system, prompt });
              if (result?.systemPrompt !== undefined) system = result.systemPrompt;
            }
          }
          session.systemPrompt = system;
          session.text = await action(options.customTools, prompt, session.systemPrompt, session);
          session.messages.push({ role: 'assistant', ...session.final });
        },
        getLastAssistantText: () => session.text,
      };
      return { session };
    },
  };
  const queue = new RunQueue(store, engine, { contextFactory });
  t.after(async () => { await queue.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, queue, engine };
}

test('SDK memory_write appends by default and keeps existing user facts', async t => {
  const { store, queue } = fixture(t, async tools => {
    await tools.find(tool => tool.name === 'memory_write').execute('save', { content: 'NEW_PYTHON_GOAL' });
    return 'saved';
  });
  const user = store.createUser('memory_alice', 'fake');
  store.writeMemory(user.id, 'KEEP_CHINESE_PREFERENCE');
  const conversation = store.createConversation(user.id, 'memory');
  const run = store.createRun(user.id, conversation.id, '记住我正在学习Python');
  const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
  assert.equal(store.memory(user.id), 'KEEP_CHINESE_PREFERENCE\n\nNEW_PYTHON_GOAL');
});

test('SDK memory entries support scoped update, forget and explicit overwrite with next-run injection', async t => {
  const { store, queue } = fixture(t, async (tools, prompt, system) => {
    const find = name => tools.find(tool => tool.name === name);
    const read = async () => JSON.parse((await find('memory_read').execute('read', {})).content[0].text);
    if (prompt === 'check') { assert.match(system, /EXPLICIT_REWRITE/); assert.doesNotMatch(system, /ALICE_KEEP|ALICE_NEW/); return 'checked'; }
    let snapshot = await read(); assert.equal(snapshot.content, 'ALICE_KEEP\n\nALICE_OLD');
    await find('memory_update').execute('update', { id: snapshot.entries[1].id, content: 'ALICE_NEW', version: snapshot.version, userId: other.id });
    await assert.rejects(find('memory_forget').execute('stale', { id: snapshot.entries[0].id, version: snapshot.version }), /memory_conflict/);
    snapshot = await read();
    await find('memory_forget').execute('forget', { id: snapshot.entries[1].id, version: snapshot.version, userId: other.id });
    await assert.rejects(find('memory_write').execute('replace', { mode: 'overwrite', content: 'DROP' }), /memory_conflict/);
    snapshot = await read();
    await find('memory_write').execute('replace', { mode: 'overwrite', content: 'EXPLICIT_REWRITE', version: snapshot.version });
    await assert.rejects(find('memory_write').execute('bad-mode', { mode: 'delete', content: 'bad' }), /invalid_memory_mode/);
    return 'saved';
  });
  const user = store.createUser('entry_alice', 'fake'), other = store.createUser('entry_bob', 'fake');
  store.writeMemory(user.id, 'ALICE_KEEP\n\nALICE_OLD'); store.writeMemory(other.id, 'BOB_PRIVATE');
  const conversation = store.createConversation(user.id, 'memory');
  for (const prompt of ['edit', 'check']) {
    const run = store.createRun(user.id, conversation.id, prompt);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
    assert.equal(store.run(user.id, run.id).status, 'completed');
  }
  assert.equal(store.memory(user.id), 'EXPLICIT_REWRITE'); assert.equal(store.memory(other.id), 'BOB_PRIVATE');
});

test('SDK quota error survives model failure normalization without exposing provider text', async t => {
  const { store, queue } = fixture(t, async (_tools, _prompt, _system, session) => {
    session.final = { stopReason: 'error', errorMessage: '429 已达到 Token Plan 用量上限 (2056) fake-private-key' };
    return '';
  });
  const user = store.createUser('quota_user', 'fake'), conversation = store.createConversation(user.id, 'quota');
  const run = store.createRun(user.id, conversation.id, '你好');
  const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).error, 'model_quota_exhausted');
  assert.ok(!JSON.stringify(store.traces(user.id, run.id)).includes('fake-private-key'));
});

test('SDK runs without a sandbox expose no command or dedicated time tools', async t => {
  const { store, queue } = fixture(t, async tools => {
    assert.ok(!tools.some(tool => ['time_now', 'cmd', 'bash', 'read', 'write', 'edit'].includes(tool.name)));
    return 'No live command access';
  });
  const user = store.createUser('fake_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  const run = store.createRun(user.id, conversation.id, '现在几点？');
  const settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
});

test('account info returns server supplied links and only the active capabilities', async t => {
  const { store, queue } = fixture(t, async (tools, prompt, system) => {
    const tool = tools.find(tool => tool.name === 'account_info');
    assert.ok(tool, 'Missing account info tool');
    assert.match(system, /自然朋友/);
    const info = JSON.parse((await tool.execute('fake', { userId: 'another-user', url: 'https://other.example' })).content[0].text);
    assert.equal(info.personalPageUrl, 'https://assistant.example/assistant/account');
    assert.equal(info.notes.url, 'https://assistant.example/users/own-space/');
    assert.deepEqual(info.availableTools, tools.map(tool => tool.name));
    assert.ok(!info.availableTools.some(name => ['cmd', 'web_search', 'voice_reply', 'time_now'].includes(name)));
    return 'FAKE_OK';
  }, () => ({ accountInfo: () => ({ personalPageUrl: 'https://assistant.example/assistant/account', notes: { status: 'ready', url: 'https://assistant.example/users/own-space/' } }) }));
  const user = store.createUser('fake_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  const run = store.createRun(user.id, conversation.id, '我的笔记在哪，你能做什么？');
  const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
});

test('agent.md requests use persona tools and update only the authenticated user', async t => {
  const { store, queue } = fixture(t, async (tools, prompt, system) => {
    assert.match(system, /agent\.md/);
    assert.match(system, /persona_write/);
    const read = tools.find(tool => tool.name === 'persona_read'), write = tools.find(tool => tool.name === 'persona_write');
    assert.equal((await read.execute('read', {})).content[0].text, 'FAKE_KEEP');
    await write.execute('write', { content: 'FAKE_KEEP\nFAKE_SHORT_REPLIES', userId: other.id, path: '/etc/AGENTS.md' });
    return 'saved';
  });
  const user = store.createUser('fake_alice', 'fake'), other = store.createUser('fake_bob', 'fake');
  store.setAgentProfile(user.id, 'FAKE_KEEP'); store.setAgentProfile(other.id, 'FAKE_BOB');
  const conversation = store.createConversation(user.id, 'fake');
  const run = store.createRun(user.id, conversation.id, '修改自己的agent.md，回复简短。');
  const settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
  assert.equal(store.agentProfile(user.id), 'FAKE_KEEP\nFAKE_SHORT_REPLIES');
  assert.equal(store.agentProfile(other.id), 'FAKE_BOB');
  assert.equal(readFileSync(join(store.directory, 'tenants', user.id, 'workspace', 'AGENTS.md'), 'utf8'), store.agentProfile(user.id));
});

test('persona draft SDK runs keep only the read tool', async t => {
  const { store, queue } = fixture(t, async tools => {
    assert.deepEqual(tools.map(tool => tool.name), ['persona_read']); return 'FAKE_DRAFT';
  });
  const user = store.createUser('fake_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  const before = store.agentProfile(user.id);
  const run = store.createRun(user.id, conversation.id, '生成草稿', 'persona_draft');
  const settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
  assert.equal(store.agentProfile(user.id), before);
});


test('SDK cmd is scoped by the queue and cannot grant command access to persona drafts', async t => {
  const called = [];
  const {store,queue} = fixture(t, async (tools,prompt,system) => {
    assert.ok(!tools.some(tool=>tool.name==='time_now'));
    const cmd = tools.find(t=>t.name==='cmd');
    if (prompt==='draft') {assert.equal(cmd,undefined); return 'FAKE_DRAFT';}
    assert.match(system,/TZ=Asia\/Shanghai date/);
    assert.ok(cmd); await cmd.execute('fake',{command:'printf FAKE',userId:'another-user',socket:'/etc/passwd'});
    return 'FAKE_OK';
  }, userId=>({sandbox:{execute:async command=>{called.push({userId,command});return {stdout:'FAKE'};}}}));
  const user=store.createUser('fake_alice','fake'), conversation=store.createConversation(user.id,'fake');
  for (const [prompt,mode] of [['command',undefined],['draft','persona_draft']]) {
    const run=store.createRun(user.id,conversation.id,prompt,mode);
    const settled=new Promise(resolve=>queue.once('settled',resolve));queue.kick();await settled;
    assert.equal(store.run(user.id,run.id).status,'completed');
  }
  assert.deepEqual(called,[{userId:user.id,command:'printf FAKE'}]);
});

test('voice tool prepares only the own run, exposes no receiver and remains absent in drafts', async t => {
  const calls = [];
  const { store, queue } = fixture(t, async (tools, prompt) => {
    const tool = tools.find(tool => tool.name === 'voice_reply');
    if (prompt === 'draft') { assert.equal(tool, undefined); return 'draft'; }
    assert.ok(tool);
    const result = await tool.execute('fake', { text: '你好', userId: 'another-user', receiver: 'another-peer' });
    assert.equal(JSON.parse(result.content[0].text).prepared, true);
    return '你好';
  }, (userId, run) => ({ speech: { prepare: async text => { calls.push({ userId, runId: run.id, text }); return { prepared: true }; } } }));
  const user = store.createUser('voice_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  const run = store.createRun(user.id, conversation.id, '用语音回复');
  let settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
  assert.deepEqual(calls, [{ userId: user.id, runId: run.id, text: '你好' }]);
  store.createRun(user.id, conversation.id, 'draft', 'persona_draft');
  settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
  assert.equal(calls.length, 1);
});

test('note lifecycle tools use the scoped transport and are absent from persona drafts', async t => {
  const calls = [];
  const { store, queue } = fixture(t, async (tools, prompt, system) => {
    if (prompt === 'draft') {
      assert.deepEqual(tools.map(tool => tool.name), ['persona_read']); return 'FAKE_DRAFT';
    }
    assert.match(system, /默认归档/);
    for (const name of ['note_archive', 'note_restore', 'note_delete']) {
      const tool = tools.find(item => item.name === name); assert.ok(tool);
      assert.ok(!('userId' in tool.parameters) && !('url' in tool.parameters));
      await tool.execute('fake', { page: 'demo', etag: '"read-version"', confirm: true, reason: 'requested', userId: 'foreign', url: 'https://other.example' });
    }
    return 'FAKE_OK';
  }, userId => ({ notes: {
    archive: async (...args) => calls.push({ userId, name: 'archive', args }),
    restore: async (...args) => calls.push({ userId, name: 'restore', args }),
    remove: async (...args) => calls.push({ userId, name: 'delete', args }),
  } }));
  const user = store.createUser('note_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  for (const [prompt, mode] of [['notes', undefined], ['draft', 'persona_draft']]) {
    const run = store.createRun(user.id, conversation.id, prompt, mode);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
    assert.equal(store.run(user.id, run.id).status, 'completed');
  }
  assert.deepEqual(calls.map(item => [item.userId, item.name]), [[user.id, 'archive'], [user.id, 'restore'], [user.id, 'delete']]);
  assert.ok(calls.every(item => !JSON.stringify(item.args).includes('foreign')));
});

test('list/search tools use authenticated context, advertise limitations and stay out of persona drafts', async t => {
  const calls = [];
  const { store, queue } = fixture(t, async (tools, prompt, system) => {
    if (prompt === 'draft') { assert.deepEqual(tools.map(tool => tool.name), ['persona_read']); return 'DRAFT'; }
    assert.match(system, /note_list\/note_search/);
    for (const [name, input] of [['note_list', { prefix: '生活', offset: 20 }], ['note_search', { query: '游泳' }]]) {
      const tool = tools.find(item => item.name === name); assert.ok(tool);
      assert.ok(!('userId' in tool.parameters) && !('url' in tool.parameters));
      const value = JSON.parse((await tool.execute('test', input)).content[0].text);
      assert.equal(value.owner, 'own');
    }
    return 'OK';
  }, userId => ({ notes: {
    list: async input => { calls.push({ userId, input }); return { owner: 'own' }; },
    search: async input => { calls.push({ userId, input }); return { owner: 'own' }; },
  } }));
  const user = store.createUser('list_alice', 'fake'), conversation = store.createConversation(user.id, 'notes');
  for (const [prompt, mode] of [['list and search', undefined], ['draft', 'persona_draft']]) {
    const run = store.createRun(user.id, conversation.id, prompt, mode);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
    assert.equal(store.run(user.id, run.id).status, 'completed');
  }
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.userId === user.id));
});

test('time prefix reaches SDK while business history stays raw, is scoped and skips persona drafts', async t => {
  const received = [];
  const { store, queue } = fixture(t, async (_tools, prompt, system) => {
    received.push(prompt);
    assert.doesNotMatch(system, /当前时间：\d{4}-/);
    assert.match(system, /程序附加的时间信息/);
    return 'ok';
  });
  const alice = store.createUser('clock_alice', 'fake'), bob = store.createUser('clock_bob', 'fake');
  const a = store.createConversation(alice.id, 'clock'), b = store.createConversation(bob.id, 'clock');
  for (const [user, conversation, prompt, age] of [
    [alice, a, 'first', 0], [alice, a, 'short', 0],
    [bob, b, 'other user', 0], [alice, a, 'long gap', 700000],
  ]) {
    if (age) store.db.prepare('UPDATE runs SET created_at=created_at-? WHERE user_id=? AND conversation_id=?').run(age, user.id, conversation.id);
    const run = store.createRun(user.id, conversation.id, prompt);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
    assert.equal(store.run(user.id, run.id).status, 'completed');
    assert.equal(store.messages(user.id, conversation.id).filter(m => m.role === 'user').at(-1).content, prompt);
  }
  assert.match(received[0], /^\[程序附加/);
  assert.equal(received[1], 'short');
  assert.match(received[2], /^\[程序附加/);
  assert.match(received[3], /^\[程序附加/);
  await queue.close();
  const draft = store.createRun(alice.id, a.id, 'draft', 'persona_draft');
  const after = store.createRun(alice.id, a.id, 'after draft');
  const previous = store.db.prepare("SELECT created_at FROM runs WHERE prompt='long gap'").get().created_at;
  store.db.prepare('UPDATE runs SET created_at=created_at+1000 WHERE id=?').run(draft.id);
  assert.equal(store.previousUserRunReceivedAt(alice.id, a.id, after.id), previous);
  assert.equal(store.previousUserRunReceivedAt(bob.id, a.id, after.id), null);
});

test('read_doc is scoped to the current workspace and absent from persona drafts', async t => {
  let ownPath, foreignPath;
  const { store, queue } = fixture(t, async (tools, prompt) => {
    const tool = tools.find(item => item.name === 'read_doc');
    if (prompt === 'draft') { assert.equal(tool, undefined); return 'DRAFT'; }
    assert.ok(tool); assert.ok(!('userId' in tool.parameters));
    const value = JSON.parse((await tool.execute('read', { path: ownPath, userId: 'foreign' })).content[0].text);
    assert.match(value.content, /ALICE_DOC/);
    await assert.rejects(tool.execute('escape', { path: foreignPath }), /document_outside_tenant/);
    return 'OK';
  }, undefined, engine => { engine.documentConverter = async path => readFileSync(path, 'utf8'); });
  const alice = store.createUser('doc_alice', 'fake'), bob = store.createUser('doc_bob', 'fake');
  const aliceWorkspace = join(store.directory, 'tenants', alice.id, 'workspace');
  const bobWorkspace = join(store.directory, 'tenants', bob.id, 'workspace');
  mkdirSync(aliceWorkspace, { recursive: true }); mkdirSync(bobWorkspace, { recursive: true });
  ownPath = join(aliceWorkspace, 'own.csv'); foreignPath = join(bobWorkspace, 'foreign.csv');
  writeFileSync(ownPath, 'ALICE_DOC,1\n'); writeFileSync(foreignPath, 'BOB_PRIVATE,2\n');
  const conversation = store.createConversation(alice.id, 'docs');
  for (const [prompt, mode] of [['read', undefined], ['draft', 'persona_draft']]) {
    const run = store.createRun(alice.id, conversation.id, prompt, mode);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
    assert.equal(store.run(alice.id, run.id).status, 'completed');
  }
});
