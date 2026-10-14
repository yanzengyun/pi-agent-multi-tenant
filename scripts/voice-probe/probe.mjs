// Explicit, one-shot native voice experiment. No poller, login or production restart.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ILinkClient } from '/home/admin/pi-agent-multi-tenant-live/src/wechat.mjs';

const target = process.argv[2], directory = dirname(fileURLToPath(import.meta.url));
if (!['lucy', 'personal'].includes(target)) throw new Error('Choose lucy or personal');
const db = new DatabaseSync('/home/admin/.local/share/pi-agent-multi-tenant/data/assistant.sqlite', { readOnly: true });
if (db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')").get().n) throw new Error('Wait for active runs to finish');
let binding, inbox;
if (target === 'lucy') {
  binding = db.prepare("SELECT b.* FROM wechat_bindings b JOIN users u ON u.id=b.user_id WHERE u.username='lucy' AND b.status='connected'").get();
  if (binding) inbox = db.prepare("SELECT i.context_token,r.created_at,r.prompt FROM wechat_inbox i JOIN runs r ON r.id=i.run_id WHERE i.binding_id=? AND i.message_id NOT LIKE 'reminder:%' ORDER BY i.rowid DESC LIMIT 1").get(binding.id);
  if (!inbox || Date.now() - inbox.created_at > 300000) throw new Error('Send AMR测试 to Lucy first');
} else {
  const credentials = JSON.parse(readFileSync('/home/admin/.pi/agent/wechat-assistant/credentials.json'));
  const contextFile = '/home/admin/.pi/agent/wechat-assistant/context-tokens.json';
  if (Date.now() - statSync(contextFile).mtimeMs > 300000) throw new Error('Send AMR测试 to personal WeChat first');
  const contexts = JSON.parse(readFileSync(contextFile));
  binding = { base_url: credentials.baseUrl, token: credentials.token, remote_user: credentials.userId };
  inbox = { context_token: contexts.tokens?.[credentials.userId] };
  if (!inbox.context_token) throw new Error('Send AMR测试 to personal WeChat first');
}
db.close();
const response = await fetch('https://api.minimax.cn/v1/t2a_v2', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.MINIMAX_CN_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'speech-2.8-turbo', text: '你好，这是AMR语音气泡测试。', stream: false, output_format: 'hex',
    voice_setting: { voice_id: 'female-tianmei', speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 16000, format: 'pcm', channel: 1 } }),
});
const data = await response.json();
if (!response.ok || data.base_resp?.status_code !== 0) throw new Error('TTS probe failed');
const hex = data.data?.audio;
if (typeof hex !== 'string' || hex.length > 2000000 || hex.length % 4 || !/^[a-f0-9]+$/i.test(hex)) throw new Error('Invalid probe PCM');
const encoded = spawnSync('python3', [directory + '/encode-amr.py'], { input: Buffer.from(hex, 'hex'),
  cwd: directory, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 1000000 });
if (encoded.status !== 0 || !encoded.stdout.subarray(0, 6).equals(Buffer.from('#!AMR\n'))) throw new Error('AMR probe encode failed');
const audio = encoded.stdout;
const client = new ILinkClient();
const media = await client.uploadVoice(binding, { audio }); // pi-connect uploads audio as FILE (media_type=3).
// pi-connect sets EncodeType=0 with json omitempty: wire payload has no encode_type or playtime.
const result = await client.request(binding.base_url, '/ilink/bot/sendmessage', { token: binding.token,
  body: { msg: { from_user_id: '', to_user_id: binding.remote_user, client_id: 'pi-amr-probe-' + randomUUID(),
    message_type: 2, message_state: 2, context_token: inbox.context_token,
    item_list: [{ type: 3, voice_item: { media } }] } } });
const report = { testedAt: new Date().toISOString(), target, variant: 'pi_connect_exact_amr',
  audioFormat: 'amr_nb', sampleRate: 8000, durationMs: (audio.length - 6) / 32 * 20, bytes: audio.length,
  uploadType: 3, messageItemType: 3, encodeTypeOnWire: null, playtimeOnWire: null,
  apiAccepted: true, ret: result.ret ?? null, errcode: result.errcode ?? null,
  hasServerMessageId: Boolean(result.message_id), clientPlaybackConfirmed: false };
writeFileSync(directory + '/result.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report));
