export const DEFAULT_VOICE = { voiceId: 'female-tianmei', speed: 1, emotion: 'auto', mode: 'ondemand' };
export const VOICE_EMOTIONS = ['auto', 'happy', 'sad', 'calm'];

export function voicePreferences(input = {}, base = DEFAULT_VOICE) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_VOICE, key))) throw new Error('invalid_voice_preferences');
  const result = { ...base, ...input };
  if (typeof result.voiceId !== 'string' || !result.voiceId || result.voiceId.length > 160 ||
      typeof result.speed !== 'number' || !Number.isFinite(result.speed) || result.speed < 0.5 || result.speed > 2 ||
      !VOICE_EMOTIONS.includes(result.emotion) || !['ondemand', 'always'].includes(result.mode)) throw new Error('invalid_voice_preferences');
  return result;
}

export function directVoiceText(prompt) {
  const text = prompt.trim();
  const command = text.match(/^\/(?:voice|语音)(?:\s+([\s\S]+))?$/i);
  if (command) return command[1]?.trim() || '你好，我现在可以用语音回复你了。';
  if (/^(?:请|给我|帮我)?(?:发个|发一条|发一个|发段|发一段)语音[吧呀啊。！!？?]*$/.test(text)) return '你好，我现在可以用语音回复你了。';
  return null;
}

export function wantsVoice(prompt, mode) {
  if (/(?:不要|不用|别|不需要)(?:发|用|回复)?语音|只(?:要|用)?文字/.test(prompt)) return false;
  return mode === 'always' || directVoiceText(prompt) !== null || /(?:用语音|语音回复|读给我听|朗读)/.test(prompt);
}

export function spokenText(text) {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/[*#`_]/g, '').trim();
  const chars = Array.from(plain);
  if (!chars.length) return '这段内容适合查看文字，请打开文字回复。';
  if (chars.length <= 200) return plain;
  const excerpt = chars.slice(0, 200).join(''), boundary = Math.max(...['。', '！', '？', '\n'].map(mark => excerpt.lastIndexOf(mark)));
  return boundary >= 40 ? excerpt.slice(0, boundary + 1) : excerpt;
}
