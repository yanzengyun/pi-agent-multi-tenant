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
        audio_setting: { sample_rate: 24000, format: 'mp3', bitrate: 64000, channel: 1 } }),
    });
    if (!response.ok) throw new Error('speech_http_failed');
    // Bound the hex-encoded MP3 response plus provider metadata.
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 2100000) throw new Error('speech_audio_too_large');
      parts.push(part);
    }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (data.base_resp?.status_code !== 0) throw new Error('speech_provider_failed');
    const hex = data.data?.audio;
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('speech_audio_invalid');
    const audio = Buffer.from(hex, 'hex'), duration = data.extra_info?.audio_length;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('speech_audio_invalid');
    if (duration > 60000 || audio.length > 1000000) throw new Error('speech_audio_too_long');
    if (audio.subarray(0, 3).toString() !== 'ID3' && !(audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)) throw new Error('speech_audio_invalid');
    signal?.throwIfAborted();
    return { audio, duration, sampleRate: 24000 };
  }
  tools(store, userId, run) {
    if (!store.wechatInbox(userId, run.id) || store.wechatBinding(userId)?.status !== 'connected') return undefined;
    let work;
    return { prepare: (text, signal) => work ||= (async () => {
      const voice = await this.synthesize(text, signal);
      store.saveVoice(userId, run.id, voice);
      return { prepared: true, deliveryFormat: 'mp3_file', durationMs: voice.duration, characters: Array.from(text).length };
    })() };
  }
}
