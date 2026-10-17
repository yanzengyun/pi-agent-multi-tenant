// Real SDK, fake keys, synthetic users, loopback HTTP only. No production data.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { PiEngine } from '../src/pi-engine.mjs';
import { tenantResourceLoader } from '../src/tenant-resources.mjs';
const sdkPath = process.argv[2] ?? fileURLToPath(new URL('../sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url));
const requests = [];
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  requests.push(JSON.parse(text)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  emit('message_stop', {}); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const temp = mkdtempSync(join(tmpdir(), 'pi-native-verify-'));
try {
  const modelsPath = join(temp, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}`, api: 'anthropic-messages', apiKey: 'fake-loopback-only',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const engine = new PiEngine({ sdkModule: resolve(sdkPath), modelsPath, provider: 'fixture', model: 'fixture', apiKey: 'fake-loopback-only', thinkingLevel: 'off' });
  await engine.initialize();
  const { ModelRuntime, SessionManager, SettingsManager, createAgentSession, createExtensionRuntime } = engine.sdk;
  const userId = '11111111-1111-4111-8111-111111111111';
  const root = join(temp, 'tenants', userId), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  for (const folder of [workspace, agentDir, sessions]) mkdirSync(folder, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath, allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('fixture', 'fake-loopback-only');
  const legacyLoader = tenantResourceLoader({ directory: temp, userId, memory: () => '', agentProfile: () => '' }, workspace, agentDir, createExtensionRuntime, 'fake');
  legacyLoader.getSystemPrompt = () => 'LEGACY_CUSTOM_PROMPT'; legacyLoader.getAgentsFiles = () => ({ agentsFiles: [] });
  legacyLoader.getExtensions = () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() });
  const manager = SessionManager.create(workspace, sessions);
  const { session: legacy } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime,
    model: runtime.getModel('fixture', 'fixture'), sessionManager: manager, resourceLoader: legacyLoader,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), tools: [] });
  await legacy.prompt('LEGACY_USER_MESSAGE'); legacy.dispose();
  let sdkFile = manager.getSessionFile(); assert.ok(sdkFile);
  const cap = join(temp, 'context-capture'); mkdirSync(cap);
  writeFileSync(join(cap, 'arming.json'), JSON.stringify({ userId, expiresAt: Date.now() + 60000 }));
  writeFileSync(join(cap, 'status.json'), JSON.stringify({ armed: true, remaining: 3, captures: [] }));
  const start = Date.now();
  for (let i = 0; i < 3; i++) {
    const ctx = { userId, directory: temp, conversation: { sdk_file: sdkFile }, signal: new AbortController().signal,
      agentProfile: () => 'ALICE_STYLE_SYNTHETIC', memory: () => i === 2 ? 'ALICE_MEMORY_UPDATED' : 'ALICE_MEMORY_ORIGINAL',
      emit() {}, setSdkFile: file => { sdkFile = file; },
      timeContext: { receivedAt: start + i * 1000, previousReceivedAt: i ? start + (i - 1) * 1000 : null } };
    assert.equal(await engine.run(ctx, `ALICE_NEW_${i}`), 'OK');
  }
  const [first, second, third] = requests.slice(1);
  const text = payload => payload.system.map(block => block.text ?? '').join('\n');
  assert.ok(text(first).startsWith('You are an expert coding assistant operating inside pi'));
  assert.doesNotMatch(text(first), /LEGACY_CUSTOM_PROMPT/);
  assert.match(text(first), /ALICE_STYLE_SYNTHETIC/); assert.match(text(first), /ALICE_MEMORY_ORIGINAL/);
  assert.match(text(first), /<project_context>/); assert.match(text(first), /memory_read:/);
  assert.match(JSON.stringify(first.messages), /LEGACY_USER_MESSAGE/);
  assert.deepEqual(first.system, second.system);
  assert.equal(first.messages.at(-1).content[0].text, second.messages.at(-3).content[0].text);
  assert.match(first.messages.at(-1).content[0].text, /^\[程序附加的时间信息\]/);
  assert.equal(second.messages.at(-1).content[0].text, 'ALICE_NEW_1');
  assert.match(text(third), /ALICE_MEMORY_UPDATED/); assert.doesNotMatch(text(third), /ALICE_MEMORY_ORIGINAL/);
  assert.deepEqual(first.tools.map(t => t.name).sort(), ['memory_forget', 'memory_read', 'memory_update', 'memory_write', 'persona_read', 'persona_write']);
  for (let i = 1; i <= 3; i++) {
    const capture = JSON.parse(gunzipSync(readFileSync(join(cap, `request-${i}.json.gz`))));
    assert.deepEqual(capture.payload, requests[i]);
  }
  assert.equal(JSON.parse(readFileSync(join(cap, 'status.json'))).armed, false);
  await engine.run({ userId: '22222222-2222-4222-8222-222222222222', directory: temp, conversation: {},
    signal: new AbortController().signal, agentProfile: () => 'BOB_STYLE_ONLY', memory: () => 'BOB_MEMORY_ONLY',
    emit() {}, setSdkFile() {} }, 'BOB_NEW');
  const bob = requests.at(-1); assert.match(text(bob), /BOB_STYLE_ONLY/); assert.match(text(bob), /BOB_MEMORY_ONLY/);
  assert.doesNotMatch(JSON.stringify(bob), /ALICE_STYLE|ALICE_MEMORY|LEGACY_USER/);
  console.log(JSON.stringify({ nativeSystem: true, nativeAgentsContext: true, sqliteMemoryHook: true,
    legacyConversationMigrated: true, historyPreserved: true, stablePromptOnUnchangedMemory: true,
    updatedMemoryVisible: true, crossUserIsolation: true, toolAllowlistPreserved: true,
    capturedPayloadEqualsHttp: true, syntheticHttpRequests: requests.length, productionDataUsed: false }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
