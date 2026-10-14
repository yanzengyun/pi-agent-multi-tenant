import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Speech } from '../src/speech.mjs';
import { makeServer } from '../src/server.mjs';
import { MockEngine } from '../src/engine.mjs';
import { DEFAULT_VOICE, voicePreferences, directVoiceText, wantsVoice } from '../src/voice-preferences.mjs';
import { RunQueue } from '../src/queue.mjs';

function speechFixture() {
  const calls = [];
  const speech = new Speech('fixture-private-key', { fetcher: async (url, options) => {
    const input = JSON.parse(options.body); calls.push({ url, input });
    if (url.endsWith('/get_voice')) return Response.json({ base_resp: { status_code: 0 },
      system_voice: [{ voice_id: 'female-tianmei', voice_name: '甜美女声' }, { voice_id: 'fixture-alternative', voice_name: '测试男声' }],
      voice_cloning: [{ voice_id: 'other-private-voice' }] });
    return Response.json({ base_resp: { status_code: 0 }, data: { audio: Buffer.from('ID3fixture').toString('hex') }, extra_info: { audio_length: 1000 } });
  } });
  return { speech, calls };
}

test('voice settings reject foreign fields and invalid controls; negative requests override always mode', () => {
  for (const input of [{ userId: 'foreign' }, { speed: 0 }, { speed: NaN }, { emotion: 'whisper' }, { mode: 'execute' }, { voiceId: '' }]) {
    assert.throws(() => voicePreferences(input), /invalid_voice_preferences/);
  }
  assert.equal(directVoiceText('发个语音'), '你好，我现在可以用语音回复你了。');
  assert.equal(directVoiceText('/voice 你好'), '你好');
  assert.equal(directVoiceText('不要发语音'), null);
  assert.equal(wantsVoice('只用文字回复', 'always'), false);
  assert.equal(wantsVoice('你好', 'ondemand'), false);
  assert.equal(wantsVoice('你好', 'always'), true);
});

test('catalog is system-only and concurrent per-user synthesis does not change shared defaults', async () => {
  const { speech, calls } = speechFixture();
  const catalog = await speech.voices();
  assert.ok(!JSON.stringify(catalog).includes('other-private-voice'));
  await Promise.all([
    speech.synthesize('甲', undefined, { voiceId: 'fixture-alternative', speed: 0.75, emotion: 'happy' }),
    speech.synthesize('乙'),
  ]);
  const requests = calls.filter(c => c.url.endsWith('/t2a_v2')).map(c => c.input.voice_setting);
  assert.deepEqual(requests[0], { voice_id: 'fixture-alternative', speed: 0.75, emotion: 'happy', vol: 1, pitch: 0 });
  assert.deepEqual(requests[1], { voice_id: 'female-tianmei', speed: 1, vol: 1, pitch: 0 });
  assert.equal(speech.voiceId, 'female-tianmei');
  await assert.rejects(speech.settings({ voiceId: 'other-private-voice' }), /invalid_voice_id/);
  assert.equal(calls.filter(c => c.url.endsWith('/get_voice')).length, 1);
});

test('own voice API persists across restart, rejects cross-user changes and previews without saving or sending', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-voice-api-')), store = new Store(directory);
  const { speech, calls } = speechFixture();
  const app = await makeServer({ store, engine: new MockEngine(), speech, adminPassword: 'fixture-admin-password' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function api(path, token, method = 'GET', data) {
    return fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data) });
  }
  const admin = (await (await api('/api/login', null, 'POST', { username: 'admin', password: 'fixture-admin-password' })).json()).token;
  for (const username of ['alice','bob']) await api('/api/admin/users', admin, 'POST', { username, password: 'fixture-user-password' });
  const token = async username => (await (await api('/api/login', null, 'POST', { username, password: 'fixture-user-password' })).json()).token;
  const alice = await token('alice'), bob = await token('bob');
  assert.equal((await api('/api/account/voice', null)).status, 401);
  assert.equal((await api('/api/account/voice', admin)).status, 403);
  assert.deepEqual((await (await api('/api/account/voice', bob)).json()).settings, DEFAULT_VOICE);
  const selected = { voiceId: 'fixture-alternative', speed: 0.75, emotion: 'calm', mode: 'always' };
  assert.equal((await api('/api/account/voice', alice, 'PUT', selected)).status, 200);
  assert.deepEqual((await (await api('/api/account/voice', alice)).json()).settings, selected);
  assert.deepEqual((await (await api('/api/account/voice', bob)).json()).settings, DEFAULT_VOICE);
  assert.equal((await api('/api/account/voice', alice, 'PUT', { ...selected, userId: store.user('bob').id })).status, 400);
  assert.equal((await api('/api/account/voice', alice, 'PUT', { voiceId: 'other-private-voice' })).status, 400);
  const preview = await api('/api/account/voice/preview', bob, 'POST', { settings: selected, text: '试听' });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'audio/mpeg');
  assert.match(preview.headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 3).toString(), 'ID3');
  assert.deepEqual((await (await api('/api/account/voice', bob)).json()).settings, DEFAULT_VOICE);
  assert.equal(store.pending().length, 0); assert.equal(store.wechatBindings().length, 0);
  assert.equal(calls.filter(c => c.url.endsWith('/t2a_v2')).length, 1);
  const reopened = new Store(directory);
  assert.deepEqual(reopened.integration(store.user('alice').id, 'voice').state, selected); reopened.close();
});

test('direct voice bypasses the model; always mode adds audio and TTS failure preserves a successful text reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-voice-queue-')), store = new Store(directory);
  const { speech } = speechFixture();
  let modelCalls = 0;
  const engine = { run: async () => { modelCalls++; return '你好，今天也要开心。'; } };
  const queue = new RunQueue(store, engine, { contextFactory: (id, run) => ({ speech: speech.tools(store, id, run) }) });
  t.after(async () => { await queue.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const user = store.createUser('fixture_user', 'fake');
  const binding = store.bindWechat(user.id, { token: 'fake-token', botId: 'fake-bot', remoteUser: 'fake-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
  async function run(id, prompt) {
    store.acceptWechat(binding, { id, text: prompt, contextToken: 'fake-context' });
    const job = store.pending().at(-1); const settled = new Promise(resolve => queue.once('settled', resolve));
    queue.kick(); await settled; return job;
  }
  let job = await run('direct', '/voice 你好'); assert.equal(modelCalls, 0); assert.ok(store.voice(user.id, job.id));
  store.setIntegration(user.id, 'voice', 'configured', { ...DEFAULT_VOICE, mode: 'always' });
  job = await run('always', '你好'); assert.equal(modelCalls, 1); assert.ok(store.voice(user.id, job.id));
  job = await run('text-only', '只用文字回复'); assert.equal(modelCalls, 2); assert.equal(store.voice(user.id, job.id), undefined);
  speech.synthesize = async () => { throw new Error('fixture-provider-failed'); };
  job = await run('failure', '你好'); assert.equal(store.run(user.id, job.id).status, 'completed');
  assert.equal(store.run(user.id, job.id).response, '你好，今天也要开心。');
  assert.equal(store.traces(user.id, job.id).some(row => row.kind === 'voice_failed'), true);
});
