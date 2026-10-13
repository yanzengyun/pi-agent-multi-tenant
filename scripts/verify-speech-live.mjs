// Real model and TTS with an isolated synthetic user. Upload probe sends no chat message.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { PiEngine } from '../src/pi-engine.mjs';
import { Speech } from '../src/speech.mjs';
import { makeServer } from '../src/server.mjs';
import { ILinkClient } from '../src/wechat.mjs';

const directory = mkdtempSync(join(tmpdir(), 'pi-real-speech-'));
const store = new Store(directory), speech = new Speech(process.env.MINIMAX_CN_API_KEY);
const engine = new PiEngine({ sdkModule: resolve('./sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  modelsPath: resolve('./models.json'), provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview',
  thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY });
let app, voice, receivedVoice = false;
const text = [];
const fakeClient = {
  updates: (_binding, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  send: async (_binding, _inbox, content) => { text.push(content); },
  uploadVoice: async (_binding, prepared) => { voice = prepared; return { encrypt_query_param: 'fake-ref', aes_key: 'fake-key', encrypt_type: 1 }; },
  sendVoice: async () => { receivedVoice = true; },
};
try {
  await engine.initialize();
  const user = store.createUser('fake_voice', 'fake');
  const binding = store.bindWechat(user.id, { token: 'fake-token', botId: 'fake-bot', remoteUser: 'fake-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
  app = await makeServer({ store, engine, adminPassword: 'fake-only-not-a-live-password', speech, wechatClient: fakeClient });
  app.wechat.ingest(binding, { message_type: 1, message_id: 'fake-voice-probe', from_user_id: binding.remote_user,
    context_token: 'fake-context', item_list: [{ type: 1, text_item: { text: '请用语音回复“你好，语音回复已经准备好了”。请实际调用voice_reply工具，保留相同的文字答案。' } }] });
  const run = store.db.prepare('SELECT * FROM runs WHERE user_id=?').get(user.id);
  for (let i = 0; i < 140; i++) {
    if (!['queued', 'running'].includes(store.run(user.id, run.id).status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(store.run(user.id, run.id).status, 'completed');
  await app.wechat.flush();
  assert.ok(receivedVoice); assert.equal(text[0], '✅ 已收到，pi 处理中...');
  assert.ok(Buffer.from(voice.audio).subarray(0, 3).toString() === 'ID3' || (voice.audio[0] === 0xff && (voice.audio[1] & 0xe0) === 0xe0));
  const events = store.traces(user.id, run.id);
  assert.ok(events.some(event => event.kind === 'sdk_event' && event.payload.type === 'tool_execution_start' && event.payload.toolName === 'voice_reply'));
  assert.equal(store.voice(user.id, run.id), undefined);
  const report = { real_model_voice_tool: true, real_tts_existing_key: true, mp3_header_verified: true,
    duration_ms: voice.duration, audio_bytes: voice.audio.length, text_and_voice_outbox: true, live_messages_sent: 0 };
  if (process.argv.includes('--verify-upload')) {
    const db = new DatabaseSync('/home/admin/.local/share/pi-agent-multi-tenant/data/assistant.sqlite', { readOnly: true });
    const liveBinding = db.prepare("SELECT * FROM wechat_bindings WHERE status='connected' LIMIT 1").get(); db.close();
    assert.ok(liveBinding, 'No connected binding for upload-only probe');
    const media = await new ILinkClient().uploadVoice(liveBinding, voice);
    assert.ok(media.encrypt_query_param); report.real_wechat_audio_file_upload = true;
  }
  console.log(JSON.stringify(report));
} finally {
  if (app) await app.close(); else store.close();
  rmSync(directory, { recursive: true, force: true });
}
