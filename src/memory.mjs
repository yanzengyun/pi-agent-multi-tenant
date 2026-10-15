import { createHash } from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex');
export const MEMORY_MAX_CHARS = 8000;

// Blank-line paragraphs are entries. Keep original offsets so editing one never rewrites others.
function blocks(content) {
  const entries = [], occurrences = new Map();
  const add = (start, end) => {
    const raw = content.slice(start, end), text = raw.trim();
    if (!text) return;
    const hash = digest(text).slice(0, 24), occurrence = (occurrences.get(hash) || 0) + 1;
    occurrences.set(hash, occurrence);
    start += raw.indexOf(text);
    entries.push({ id: `m_${hash}_${occurrence}`, content: text, start, end: start + text.length });
  };
  let start = 0;
  for (const match of content.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g)) {
    add(start, match.index); start = match.index + match[0].length;
  }
  add(start, content.length);
  return entries;
}

export function memorySnapshot(content) {
  return { content, version: digest(content), entries: blocks(content).map(({ id, content }) => ({ id, content })) };
}

export function changeMemory(previous, input) {
  const { mode = 'append', content, version, id } = input;
  if (!['append', 'overwrite', 'update', 'delete'].includes(mode)) throw new Error('invalid_memory_mode');
  if (mode !== 'append' && (typeof version !== 'string' || version !== digest(previous))) throw new Error('memory_conflict_read_again');
  if (mode !== 'delete' && (typeof content !== 'string' || content.length > MEMORY_MAX_CHARS || (mode !== 'overwrite' && !content.trim()))) {
    throw new Error('invalid_memory_content');
  }
  let next;
  if (mode === 'append') next = previous + (previous.trim() ? '\n\n' : '') + content.trim();
  else if (mode === 'overwrite') next = content;
  else {
    const entry = blocks(previous).find(entry => entry.id === id);
    if (!entry) throw new Error('memory_entry_not_found');
    next = previous.slice(0, entry.start) + (mode === 'update' ? content.trim() : '') + previous.slice(entry.end);
  }
  if (next.length > MEMORY_MAX_CHARS) throw new Error('memory_full_update_or_delete_entries');
  return next;
}
