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

test('normal SDK runs can query fresh Beijing time without command access', async t => {
  const before = Date.now();
  const { store, queue } = fixture(t, async tools => {
    const tool = tools.find(tool => tool.name === 'time_now');
    assert.ok(tool, 'Missing live time tool');
    assert.ok(!tools.some(tool => ['cmd', 'bash', 'read', 'write', 'edit'].includes(tool.name)));
    const value = JSON.parse((await tool.execute('fake', {})).content[0].text);
    assert.equal(value.timezone, 'Asia/Shanghai');
    assert.ok(Date.parse(value.utc) >= before && Date.parse(value.utc) <= Date.now());
    assert.equal(Date.parse(value.local), Date.parse(value.utc));
    assert.match(value.local, /\+08:00$/);
    return value.local;
  });
  const user = store.createUser('fake_alice', 'fake'), conversation = store.createConversation(user.id, 'fake');
  const run = store.createRun(user.id, conversation.id, '现在几点？');
  const settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
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
  const run = store.createRun(user.id, conversation.id, '生成草稿', 'persona_draft');
  const settled = new Promise(resolve => queue.once('settled', resolve));
  queue.kick(); await settled;
  assert.equal(store.run(user.id, run.id).status, 'completed');
  assert.equal(store.agentProfile(user.id), '');
});


test('SDK cmd is scoped by the queue and cannot grant command access to persona drafts', async t => {
  const called = [];
  const {store,queue} = fixture(t, async (tools,prompt) => {
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
