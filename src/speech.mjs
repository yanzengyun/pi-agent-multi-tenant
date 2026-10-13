import { encode } from 'silk-wasm';

export class Speech {
  constructor(apiKey, { fetcher = fetch } = {}) { this.apiKey = apiKey; this.fetcher = fetcher; }
  async synthesize(text, signal) {
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 200) throw new Error('speech_text_invalid');
    const response = await this.fetcher('https://api.minimax.cn/v1/t2a_v2', {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'speech-2.8-turbo', text, stream: false, output_format: 'hex',
        voice_setting: { voice_id: 'male-qn-qingse', speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 } }),
    });
    if (!response.ok) throw new Error('speech_http_failed');
    // 60 seconds of mono PCM16 at 24kHz, hex-encoded, plus response metadata.
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 6000000) throw new Error('speech_audio_too_large');
      parts.push(part);
    }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (data.base_resp?.status_code !== 0) throw new Error('speech_provider_failed');
    const hex = data.data?.audio;
    if (typeof hex !== 'string' || hex.length % 4 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('speech_audio_invalid');
    const pcm = Buffer.from(hex, 'hex');
    if (pcm.length > 24000 * 2 * 60) throw new Error('speech_audio_too_long');
    signal?.throwIfAborted();
    const silk = await encode(pcm, 24000);
    signal?.throwIfAborted();
    if (!silk.data.length || silk.duration <= 0 || silk.duration > 60000) throw new Error('speech_audio_invalid');
    return { audio: Buffer.from(silk.data), duration: silk.duration, sampleRate: 24000 };
  }
  tools(store, userId, run) {
    if (!store.wechatInbox(userId, run.id) || store.wechatBinding(userId)?.status !== 'connected') return undefined;
    let work;
    return { prepare: (text, signal) => work ||= (async () => {
      const voice = await this.synthesize(text, signal);
      store.saveVoice(userId, run.id, voice);
      return { prepared: true, durationMs: voice.duration, characters: Array.from(text).length };
    })() };
  }
}
