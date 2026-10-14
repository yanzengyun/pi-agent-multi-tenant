import { DEFAULT_VOICE, voicePreferences, wantsVoice, spokenText } from './voice-preferences.mjs';

export class Speech {
  constructor(apiKey, { fetcher = fetch, voiceId = 'female-tianmei' } = {}) { this.apiKey = apiKey; this.fetcher = fetcher; this.voiceId = voiceId; }
  async voices(signal) {
    signal?.throwIfAborted();
    if (this.catalog && this.catalogUntil > Date.now()) return this.catalog;
    if (!this.catalogWork) this.catalogWork = (async () => {
      const response = await this.fetcher('https://api.minimax.cn/v1/get_voice', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_type: 'system' }),
      });
      if (!response.ok) throw new Error('voice_catalog_unavailable');
      const bytes = []; let size = 0;
      for await (const part of response.body) {
        size += part.length; if (size > 2000000) throw new Error('voice_catalog_unavailable'); bytes.push(part);
      }
      const data = JSON.parse(Buffer.concat(bytes).toString());
      if (data.base_resp?.status_code !== 0 || !Array.isArray(data.system_voice)) throw new Error('voice_catalog_unavailable');
      this.catalog = data.system_voice.filter(voice => typeof voice.voice_id === 'string' && voice.voice_id.length <= 160)
        .map(voice => ({ id: voice.voice_id, name: String(voice.voice_name || voice.voice_id).slice(0, 160),
          description: (Array.isArray(voice.description) ? voice.description.join(' ') : '').slice(0, 400) }));
      this.catalogUntil = Date.now() + 6 * 3600000;
      return this.catalog;
    })().finally(() => { this.catalogWork = null; });
    const voices = await this.catalogWork;
    signal?.throwIfAborted();
    return voices;
  }
  async settings(input, base = { ...DEFAULT_VOICE, voiceId: this.voiceId }, signal) {
    const value = voicePreferences(input, base);
    if (!(await this.voices(signal)).some(voice => voice.id === value.voiceId)) throw new Error('invalid_voice_id');
    return value;
  }
  async synthesize(text, signal, input = {}) {
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 200) throw new Error('speech_text_invalid');
    const settings = voicePreferences(input, { ...DEFAULT_VOICE, voiceId: this.voiceId });
    const response = await this.fetcher('https://api.minimax.cn/v1/t2a_v2', {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'speech-2.8-turbo', text, stream: false, output_format: 'hex',
        voice_setting: { voice_id: settings.voiceId, speed: settings.speed, vol: 1, pitch: 0,
          ...(settings.emotion === 'auto' ? {} : { emotion: settings.emotion }) },
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
    const defaults = { ...DEFAULT_VOICE, voiceId: this.voiceId };
    const preferences = () => voicePreferences(store.integration(userId, 'voice')?.state || {}, defaults);
    const prepare = (text, signal) => work ||= (async () => {
      store.requireUsable(userId);
      const settings = preferences();
      const voice = await this.synthesize(text, signal, settings);
      signal?.throwIfAborted(); store.requireUsable(userId);
      store.saveVoice(userId, run.id, voice);
      return { prepared: true, deliveryFormat: 'mp3_file', durationMs: voice.duration, characters: Array.from(text).length };
    })();
    return { prepare, preferences,
      options: async query => (await this.voices()).filter(voice => !query || JSON.stringify(voice).toLowerCase().includes(query.toLowerCase())).slice(0, 20),
      update: async (input, signal) => {
        const value = await this.settings(input, preferences(), signal);
        store.requireUsable(userId); store.setIntegration(userId, 'voice', 'configured', value); return value;
      },
      finish: async (text, signal, prompt) => {
        if (wantsVoice(prompt, preferences().mode)) await prepare(spokenText(text), signal);
      },
    };
  }
}
