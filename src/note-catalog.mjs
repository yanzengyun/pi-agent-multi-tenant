import { spawn } from 'node:child_process';
import { notePath } from './note-lifecycle.mjs';

function options(input = {}) {
  let { prefix = '', limit = 20, includeArchived = false } = input;
  if (typeof prefix !== 'string' || prefix.length > 240 || /[\\%?#:\x00-\x1f]/.test(prefix) ||
      prefix.startsWith('/') || prefix.split('/').some(part => part.startsWith('.'))) throw new Error('invalid_note_prefix');
  prefix = prefix.replace(/\/$/, '');
  if (prefix && prefix.split('/').some(part => !part)) throw new Error('invalid_note_prefix');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_note_limit');
  if (typeof includeArchived !== 'boolean') throw new Error('invalid_note_archive_filter');
  return { prefix, limit, includeArchived };
}

// Receives only transports already bound to a verified user/space. Never accepts paths on the host.
export class NoteCatalog {
  constructor({ inventory, read, url = () => null }) { this.inventory = inventory; this.read = read; this.url = url; }
  async pages(input, signal) {
    signal?.throwIfAborted();
    const config = options(input), metadata = await this.inventory(signal);
    if (!Array.isArray(metadata) || metadata.length > 10000) throw new Error('invalid_note_inventory');
    const pages = []; let skipped = 0;
    for (const file of metadata) {
      if (typeof file.name !== 'string' || !file.name.endsWith('.md') || file.name.startsWith('Library/') || file.name === 'CONFIG.md') continue;
      if (!config.includeArchived && file.name.startsWith('归档/')) continue;
      const page = file.name.slice(0, -3);
      if (config.prefix && !page.startsWith(config.prefix + '/')) continue;
      try { notePath(file.name); } catch { skipped++; continue; }
      const modified = Number(file.lastModified), validDate = Number.isFinite(modified) && Math.abs(modified) < 8.64e15;
      const base = this.url();
      pages.push({ page, title: page.split('/').at(-1), size: Number.isFinite(file.size) ? file.size : null,
        modifiedAt: validDate ? new Date(modified).toISOString() : null,
        url: base ? base.replace(/\/$/, '') + '/' + page.split('/').map(encodeURIComponent).join('/') : null });
    }
    pages.sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || '') || a.page.localeCompare(b.page));
    return { pages, skipped, config };
  }
  async list(input = {}, signal) {
    const { offset = 0 } = input;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('invalid_note_offset');
    const { pages, skipped, config } = await this.pages(input, signal);
    const items = pages.slice(offset, offset + config.limit);
    return { items, total: pages.length, offset, nextOffset: offset + items.length < pages.length ? offset + items.length : null,
      incomplete: skipped > 0, skippedPages: skipped };
  }
  async search(input, signal) {
    const { query } = input || {};
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f]/.test(query)) throw new Error('invalid_note_query');
    const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
    const { pages, skipped, config } = await this.pages(input, abort);
    const lines = [], locations = [], metadata = new Map(pages.map(page => [page.page, page]));
    let bytes = 0, scannedPages = 0, skippedPages = skipped, scanLimited = pages.length > 200;
    for (const page of pages.slice(0, 200)) {
      abort.throwIfAborted();
      if (page.size > 200000) { skippedPages++; continue; }
      let note;
      try { note = await this.read(page.page, abort); }
      catch (error) {
        if (['note_not_found', 'note_too_large'].includes(error.message)) { skippedPages++; continue; }
        throw error;
      }
      if (typeof note.content !== 'string') throw new Error('invalid_note_content');
      const size = Buffer.byteLength(note.content);
      if (size > 200000) { skippedPages++; continue; }
      if (bytes + size > 2_000_000) { scanLimited = true; break; }
      bytes += size; scannedPages++;
      lines.push(page.page); locations.push({ page: page.page, line: 0 });
      for (const [index, text] of note.content.split(/\r?\n/).entries()) {
        lines.push(text); locations.push({ page: page.page, line: index + 1 });
      }
    }
    const rows = await rg(query, lines.join('\n') + '\n', abort);
    const found = new Map();
    for (const { data } of rows) {
      const location = locations[data.line_number - 1];
      if (!location) throw new Error('invalid_note_search_result');
      let item = found.get(location.page);
      if (!item) { item = { ...metadata.get(location.page), excerpts: [] }; found.set(location.page, item); }
      if (item.excerpts.length >= 3) continue;
      const text = data.lines.text.trimEnd();
      const offset = Buffer.from(text).subarray(0, data.submatches[0].start).toString('utf8').length;
      item.excerpts.push({ line: location.line, text: text.slice(Math.max(0, offset - 100), offset + 300) });
    }
    const matches = [...found.values()];
    return { items: matches.slice(0, config.limit), scannedPages, scannedBytes: bytes, skippedPages,
      incomplete: scanLimited || skippedPages > 0 || rows.length >= 200 || matches.length > config.limit,
      matchMode: 'literal_case_insensitive', savedContentOnly: true };
  }
}

function rg(query, text, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['--json', '--fixed-strings', '--ignore-case', '--text', '--max-count', '200', '--', query, '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal });
    const chunks = []; let size = 0, exceeded = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 8_000_000) { exceeded = true; child.kill(); } else chunks.push(chunk);
    });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error.name === 'AbortError' ? error : new Error('note_search_rg_unavailable')); });
    child.on('close', (code, killed) => {
      clearTimeout(timer);
      if (signal.aborted) { reject(signal.reason); return; }
      if (exceeded || timedOut || killed || ![0, 1].includes(code)) { reject(new Error('note_search_failed')); return; }
      try {
        resolve(Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean)
          .map(line => JSON.parse(line)).filter(row => row.type === 'match'));
      } catch { reject(new Error('invalid_note_search_result')); }
    });
    child.stdin.end(text);
  });
}
