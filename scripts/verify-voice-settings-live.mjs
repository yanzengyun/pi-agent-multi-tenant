// Real model and TTS in a synthetic account; all WeChat operations are fake.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.mjs';
import { PiEngine } from '../src/pi-engine.mjs';
import { Speech } from '../src/speech.mjs';
import { makeServer } from '../src/server.mjs';

const directory = mkdtempSync(join(tmpdir(), 'pi-voice-settings-live-')), store = new Store(directory);
const speech = new Speech(process.env.MINIMAX_CN_API_KEY);
const engine = new PiEngine({ sdkModule: process.env.PI_SDK_MODULE || resolve('./sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  modelsPath: resolve('./models.json'), provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY });
const audio = [], text = [];
let app;
try {
  await engine.initialize();
  const alice = store.createUser('fixture_voice_alice', 'fake'), bob = store.createUser('fixture_voice_bob', 'fake');
  const binding = store.bindWechat(alice.id, { token: 'fake-token', botId: 'fake-bot', remoteUser: 'fake-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
  app = await makeServer({ store, engine, adminPassword: 'fixture-admin-password', speech, wechatClient: {
    updates: (_binding, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    send: async (_binding, _inbox, content) => { text.push(content); },
    uploadVoice: async (_binding, voice) => { audio.push(voice); return { encrypt_query_param: 'fake-reference' }; },
    sendVoice: async () => {},
  } });
  async function run(id, content) {
    app.wechat.ingest(binding, { message_type: 1, message_id: id, from_user_id: 'fake-peer', context_token: 'fake-context',
      item_list: [{ type: 1, text_item: { text: content } }] });
    const job = store.db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(alice.id);
    for (let i = 0; i < 140 && ['queued','running'].includes(store.run(alice.id, job.id).status); i++) await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(store.run(alice.id, job.id).status, 'completed'); await app.wechat.flush(); return job;
  }
  const configured = await run('preferences', '请查我的声音设置，然后只把语速改成0.75倍、语气改成平静。其他设置保持。用文字确认，不要发语音。');
  assert.equal(store.integration(alice.id, 'voice').state.speed, 0.75);
  assert.equal(store.integration(alice.id, 'voice').state.emotion, 'calm');
  assert.equal(store.integration(bob.id, 'voice'), undefined);
  const events = store.traces(alice.id, configured.id), context = events.find(row => row.kind === 'context').payload;
  assert.ok(context.activeTools.includes('voice_preferences_read') && context.activeTools.includes('voice_preferences_write'));
  assert.equal(audio.length, 0);
  const direct = await run('direct', '/voice 你好，今天也要开心。');
  assert.ok(!store.traces(alice.id, direct.id).some(row => row.kind === 'sdk_event'));
  assert.equal(audio.length, 1);
  assert.ok(audio[0].duration > 0 && audio[0].duration <= 60000);
  if (process.env.PI_VOICE_SAMPLE_OUTPUT) writeFileSync(process.env.PI_VOICE_SAMPLE_OUTPUT, audio[0].audio, { mode: 0o600 });
  store.setIntegration(alice.id, 'voice', 'configured', { ...store.integration(alice.id, 'voice').state, mode: 'always' });
  await run('always', '你好，请只回复一句简短中文问候。');
  assert.equal(audio.length, 2);
  console.log(JSON.stringify({ actualModelPreferencesSaved: true, otherUserUnchanged: true, directVoiceSkippedModel: true,
    realTtsSlowCalm: true, automaticAudio: true, voiceCount: audio.length, systemVoices: (await speech.voices()).length, wechatMessagesSent: 0 }));
} finally {
  if (app) await app.close(); else store.close(); rmSync(directory, { recursive: true, force: true });
}
