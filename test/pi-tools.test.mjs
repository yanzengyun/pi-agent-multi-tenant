import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiEngine } from '../src/pi-engine.mjs';
import { RunQueue } from '../src/queue.mjs';
import { Store } from '../src/store.mjs';

function fixture(t, action, contextFactory) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tools-'));
  const store = new Store(directory), engine = new PiEngine({ provider: 'fake', model: 'fake' });
  engine.Type = { Object: value => value, String: value => value };
  engine.sdk = {
    createExtensionRuntime: () => ({}),
    ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => {}, getModel: () => ({}) }) },
    SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
    SettingsManager: { inMemory: () => ({}) },
    async createAgentSession(options) {
      const session = {
        systemPrompt: options.resourceLoader.getSystemPrompt(), messages: [],
        getActiveToolNames: () => options.tools, subscribe: () => () => {}, dispose() {},
        async prompt(prompt) {
          session.text = await action(options.customTools, prompt, session.systemPrompt);
          session.messages.push({ role: 'assistant' });
        },
        getLastAssistantText: () => session.text,
      };
      return { session };
    },
  };
  const queue = new RunQueue(store, engine, { contextFactory });
  t.after(async () => { await queue.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, queue };
}

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
    assert.match(system,/TZ=Asia\/Shanghai date/);
    const cmd = tools.find(t=>t.name==='cmd');
    if (prompt==='draft') {assert.equal(cmd,undefined); return 'FAKE_DRAFT';}
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
