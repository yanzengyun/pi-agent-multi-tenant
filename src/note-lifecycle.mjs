import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export function notePath(page) {
  if (typeof page !== 'string' || page.length > 300 || !page.trim() || /[\\%?#\x00-\x1f]/.test(page) ||
      page.split('/').some(part => !part || part.startsWith('.'))) throw new Error('invalid_note_path');
  const name = page.endsWith('.md') ? page : page + '.md';
  return name.split('/').map(encodeURIComponent).join('/');
}

// Only the caller's bound file transport is used. Copy/read-back precedes conditional removal.
export class NoteLifecycle {
  constructor(file, directory, userId) { this.file = file; this.directory = directory; this.userId = userId; }
  async checked(page, etag, signal) {
    notePath(page);
    if (typeof etag !== 'string' || !etag || etag.length > 256) throw new Error('note_revision_required');
    const current = await this.file(page, { signal });
    if (!current.etag || current.etag !== etag) throw new Error('note_conflict');
    return current;
  }
  audit(action, page, target, current, reason) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(this.userId)) throw new Error('invalid_user_id');
    const directory = join(this.directory, 'tenants', this.userId, 'notes');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('unsafe_note_audit_directory');
    const file = join(directory, 'audit.jsonl');
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('unsafe_note_audit_file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), userId: this.userId, action,
      page, target: target || null, etag: current.etag, bytes: Buffer.byteLength(current.content),
      sha256: createHash('sha256').update(current.content).digest('hex'), reason: reason || null }) + '\n', { mode: 0o600 });
  }
  async removeChecked(page, current, signal) {
    try { await this.file(page, { method: 'DELETE', etag: current.etag, signal }); }
    catch (error) {
      if (error.message === 'note_conflict') throw error;
      // A lost DELETE response is uncertain; read current state instead of repeating the mutation.
      try { await this.file(page, { signal }); }
      catch (readError) { if (readError.message === 'note_not_found') return; }
      throw error;
    }
    try { await this.file(page, { signal }); }
    catch (error) { if (error.message === 'note_not_found') return; throw error; }
    throw new Error('note_delete_verification_failed');
  }
  async move(action, page, target, current, reason, signal) {
    await this.file(target, { method: 'PUT', content: current.content, signal });
    const copied = await this.file(target, { signal });
    if (copied.content !== current.content) throw new Error('note_copy_verification_failed');
    this.audit(action + '_prepared', page, target, current, reason);
    try { await this.removeChecked(page, current, signal); }
    catch (error) {
      this.audit(action + '_incomplete', page, target, current, reason);
      throw new Error(error.message + '; preserved_copy=' + target);
    }
    this.audit(action, page, target, current, reason);
    return { page, target, preview: current.content.slice(0, 300) };
  }
  async archive(page, etag, reason, signal) {
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) throw new Error('invalid_note_reason');
    const current = await this.checked(page, etag, signal);
    const name = decodeURIComponent(notePath(page));
    if (name.startsWith('归档/') || name.length > 240) throw new Error('note_archive_path_not_supported');
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).slice(0, 7);
    const target = `归档/${month}/${randomUUID()}/${name}`;
    const result = await this.move('archive', name, target, current, reason, signal);
    return { archived: true, page: name, archivedPage: target, preview: result.preview };
  }
  async restore(page, etag, signal) {
    const name = decodeURIComponent(notePath(page));
    const match = name.match(/^归档\/\d{4}-(?:0[1-9]|1[0-2])\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/(.+\.md)$/);
    if (!match || match[1].startsWith('归档/')) throw new Error('note_restore_requires_archived_page');
    notePath(match[1]);
    const current = await this.checked(name, etag, signal);
    await this.move('restore', name, match[1], current, null, signal);
    return { restored: true, page: match[1], archivedPage: name };
  }
  async remove(page, etag, confirm, reason, signal) {
    if (confirm !== true) throw new Error('note_delete_requires_confirmation');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) throw new Error('invalid_note_reason');
    const current = await this.checked(page, etag, signal);
    this.audit('delete_prepared', page, null, current, reason);
    await this.removeChecked(page, current, signal);
    this.audit('delete', page, null, current, reason);
    return { deleted: true, page, historicalBackupsRetained: true };
  }
}
