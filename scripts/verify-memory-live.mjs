// Synthetic temporary users and SDK sessions only. No production DB, notes or WeChat.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.mjs';
import { PiEngine } from '../src/pi-engine.mjs';
import { RunQueue } from '../src/queue.mjs';

const output = resolve(process.argv[2] || '/tmp/pi-memory-verification.json');
const directory = mkdtempSync(join(tmpdir(), 'pi-memory-model-')), store = new Store(directory);
const report = { startedAt: new Date().toISOString(), syntheticOnly: true, wechatMessagesSent: 0, checks: [], modelCalls: 0 };
let queue;
try {
  const engine = new PiEngine({ sdkModule: process.env.PI_SDK_MODULE || resolve('sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    modelsPath: process.env.PI_MODELS_PATH || resolve('models.json'), provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview',
    thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY });
  await engine.initialize(); queue = new RunQueue(store, engine);
  const alice = store.createUser('fixture_memory_alice', 'fake'), bob = store.createUser('fixture_memory_bob', 'fake');
  const legacy = '习惯：喜欢中文沟通。\n\n课程：正在学习Python。';
  store.writeMemory(alice.id, legacy); store.writeMemory(bob.id, 'BOB_PRIVATE_KEEP');
  const steps = [
    { name: 'defaultAppend', prompt: '请记住：我喜欢游泳。只新增这个事实，保留已有记忆。', tool: 'memory_write',
      check: (value, calls) => { assert.ok(value.startsWith(legacy)); assert.match(value, /游泳/); assert.ok(calls.some(call => call.toolName === 'memory_write' && (!call.args.mode || call.args.mode === 'append'))); } },
    { name: 'targetedUpdate', prompt: '请把记忆中的课程从Python改为Rust，其他偏好保持。修改已有条目。', tool: 'memory_update',
      check: value => { assert.match(value, /Rust/); assert.doesNotMatch(value, /Python/); assert.match(value, /游泳/); assert.match(value, /中文/); } },
    { name: 'targetedForget', prompt: '请忘记我喜欢游泳这件事，其他长期记忆保留。', tool: 'memory_forget',
      check: value => { assert.doesNotMatch(value, /游泳/); assert.match(value, /Rust/); assert.match(value, /中文/); } },
    { name: 'explicitOverwrite', prompt: '请将整份长期记忆完整重写为“只偏好中文回答。”，替换之前的全部记忆。', tool: 'memory_write',
      check: (value, calls) => { assert.match(value, /中文/); assert.doesNotMatch(value, /Rust|游泳/); assert.ok(calls.some(call => call.toolName === 'memory_write' && call.args.mode === 'overwrite' && call.args.version)); } },
  ];
  for (const step of steps) {
    // Separate sessions ensure ID/version must be read and persistence crosses conversations.
    const conversation = store.createConversation(alice.id, '合成记忆验收-' + step.name);
    const run = store.createRun(alice.id, conversation.id, step.prompt);
    const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled; report.modelCalls++;
    const finished = store.run(alice.id, run.id);
    if (finished.error === 'model_quota_exhausted') { report.modelVerification = 'quota_exhausted'; throw new Error('model_quota_exhausted'); }
    assert.equal(finished.status, 'completed', finished.error);
    const calls = store.traces(alice.id, run.id).filter(event => event.kind === 'sdk_event' && event.payload.type === 'tool_execution_start').map(event => event.payload);
    assert.ok(calls.some(call => call.toolName === step.tool), 'Model must call ' + step.tool);
    if (step.name !== 'defaultAppend') assert.ok(calls.some(call => call.toolName === 'memory_read'), 'Model must read IDs/version before editing memory');
    step.check(store.memory(alice.id), calls);
    assert.equal(store.memory(bob.id), 'BOB_PRIVATE_KEEP'); report.checks.push(step.name);
  }
  report.checks.push('otherUserPreserved', 'crossSessionPersistence'); report.success = true; report.modelVerification = 'passed';
} catch (error) {
  report.success = false; report.failure = error.message; process.exitCode = 1;
} finally {
  await queue?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  report.fixtureRemoved = true; report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report));
}
