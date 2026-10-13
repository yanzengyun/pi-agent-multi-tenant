import test from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../src/speech.mjs';

test('TTS uses the existing key, limits text, returns SILK and exposes no credentials', async () => {
  let calls = 0;
  const speech = new Speech('fake-secret', { fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.minimax.cn/v1/t2a_v2');
    assert.equal(options.headers.Authorization, 'Bearer fake-secret');
    const request = JSON.parse(options.body);
    assert.equal(request.audio_setting.format, 'pcm');
    assert.equal(request.text, '你好');
    return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: Buffer.alloc(24000).toString('hex') } }));
  } });
  const voice = await speech.synthesize('你好');
  assert.ok(voice.audio.length > 0);
  assert.equal(voice.sampleRate, 24000);
  assert.ok(voice.duration > 0 && voice.duration <= 60000);
  assert.ok(!JSON.stringify(voice).includes('fake-secret'));
  await assert.rejects(speech.synthesize('x'.repeat(201)), /speech_text_invalid/);
  assert.equal(calls, 1);
});

test('TTS rejects provider failures and malformed or overlong audio with safe errors', async () => {
  for (const data of [
    { base_resp: { status_code: 1004, status_msg: 'fake-secret' } },
    { base_resp: { status_code: 0 }, data: { audio: 'not-hex' } },
    { base_resp: { status_code: 0 }, data: { audio: Buffer.alloc(24000 * 2 * 61).toString('hex') } },
  ]) {
    const speech = new Speech('fake-secret', { fetcher: async () => new Response(JSON.stringify(data)) });
    await assert.rejects(speech.synthesize('你好'), error => /speech_/.test(error.message) && !error.message.includes('fake-secret'));
  }
});

test('WeChat voice transport encrypts the SILK and emits a native voice payload', async () => {
  const { ILinkClient } = await import('../src/wechat.mjs');
  const { createDecipheriv } = await import('node:crypto');
  const audio = Buffer.from('fake-silk'), binding = { base_url: 'https://ilinkai.weixin.qq.com', token: 'fake-bot-token', remote_user: 'own-peer' };
  let uploadRequest, outgoing, ciphertext;
  const client = new ILinkClient({ fetcher: async (url, options) => {
    if (String(url).includes('getuploadurl')) {
      uploadRequest = JSON.parse(options.body);
      assert.equal(uploadRequest.media_type, 4); assert.equal(uploadRequest.to_user_id, 'own-peer');
      return Response.json({ ret: 0, upload_param: 'fake-upload' });
    }
    if (String(url).includes('/c2c/upload')) {
      assert.equal(options.headers.Authorization, undefined);
      ciphertext = options.body;
      return new Response('', { headers: { 'x-encrypted-param': 'fake-download' } });
    }
    outgoing = JSON.parse(options.body); return Response.json({ ret: 0 });
  } });
  const media = await client.uploadVoice(binding, { audio }, undefined);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploadRequest.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), audio);
  await client.sendVoice(binding, { context_token: 'own-context' }, { sample_rate: 24000, duration: 1000 }, media, 'stable-voice-id');
  assert.equal(outgoing.msg.context_token, 'own-context');
  assert.equal(outgoing.msg.to_user_id, 'own-peer');
  assert.equal(outgoing.msg.item_list[0].type, 3);
  assert.equal(outgoing.msg.item_list[0].voice_item.encode_type, 6);
  assert.equal(outgoing.msg.item_list[0].voice_item.playtime, 1000);
});

test('media upload rejects untrusted CDN URLs before sending audio or credentials', async () => {
  const { ILinkClient } = await import('../src/wechat.mjs');
  let calls = 0;
  const client = new ILinkClient({ fetcher: async () => { calls++; return Response.json({ ret: 0, upload_full_url: 'https://evil.test/upload' }); } });
  await assert.rejects(client.uploadVoice({ base_url: 'https://ilinkai.weixin.qq.com', token: 'fake-token', remote_user: 'own-peer' }, { audio: Buffer.from('fake') }), /untrusted_wechat_cdn/);
  assert.equal(calls, 1);
});

test('speech tools require an own WeChat inbox and synthesize once per run', async () => {
  const { Store } = await import('../src/store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'pi-voice-scope-')), store = new Store(directory);
  try {
    const alice = store.createUser('alice', 'fake'), bob = store.createUser('bob', 'fake');
    const binding = store.bindWechat(alice.id, { token: 'fake-token', botId: 'scope-bot', remoteUser: 'scope-peer', baseUrl: 'https://ilinkai.weixin.qq.com' });
    const speech = new Speech('fake-key'); let calls = 0;
    speech.synthesize = async () => { calls++; return { audio: Buffer.from('fake'), duration: 1000, sampleRate: 24000 }; };
    const webRun = store.createRun(alice.id, binding.conversation_id, 'web');
    assert.equal(speech.tools(store, alice.id, webRun), undefined);
    store.acceptWechat(binding, { id: 'scope-message', text: '用语音回复', contextToken: 'fake-context' });
    const run = store.pending().find(run => run.id !== webRun.id);
    assert.equal(speech.tools(store, bob.id, run), undefined);
    const tools = speech.tools(store, alice.id, run);
    await Promise.all([tools.prepare('你好'), tools.prepare('你好')]);
    assert.equal(calls, 1); assert.equal(store.voice(alice.id, run.id).duration, 1000);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
