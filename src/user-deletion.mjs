import { mkdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep progress in SQLite until all external resources are detached. A failed deletion stays disabled.
export class UserDeletion {
  constructor(store, { wechat, silverbullet, sandbox, credentialChanges = new Set() } = {}) {
    this.store = store; this.wechat = wechat; this.silverbullet = silverbullet; this.sandbox = sandbox;
    this.credentialChanges = credentialChanges; this.active = new Set();
  }
  async remove(userId, confirmUsername) {
    const user = this.store.userById(userId);
    if (!user) throw new Error('user_not_found');
    if (user.role !== 'user') throw new Error('cannot_delete_admin');
    if (confirmUsername !== user.username) throw new Error('delete_confirmation_mismatch');
    if (this.active.has(userId) || this.credentialChanges.has(userId) || this.silverbullet?.busy(userId)) throw new Error('user_busy');
    this.active.add(userId);
    try {
      this.store.beginDeletion(userId);
      try {
        if (this.wechat) await this.wechat.forget(userId); else this.store.removeWechat(userId);
        const notes = this.silverbullet ? await this.silverbullet.archiveUser(user) : null;
        if (!this.silverbullet && this.store.integration(userId, 'silverbullet')) throw new Error('notes_cleanup_unavailable');
        if (this.sandbox) await this.sandbox.release(userId);
        const tenants = join(this.store.directory, 'tenants');
        let parent;
        try { parent = lstatSync(tenants); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (parent?.isSymbolicLink()) throw new Error('unsafe_tenant_directory');
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(userId)) throw new Error('invalid_user_id');
        rmSync(join(tenants, userId), { recursive: true, force: true });
        const archive = join(this.store.directory, 'deleted-users');
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        if (lstatSync(archive).isSymbolicLink()) throw new Error('unsafe_archive_directory');
        const report = { id: userId, username: user.username, deletionRequestedAt: this.store.deletion(userId).created_at,
          notesFolder: notes?.folder || null, noteSpaceIds: notes?.spaceIds || [], historicalBackupsRetained: true };
        writeFileSync(join(archive, userId + '.json'), JSON.stringify(report), { mode: 0o600 });
        this.store.finishDeletion(userId);
        return { deleted: true, notesArchived: Boolean(notes), historicalBackupsRetained: true };
      } catch {
        this.store.deletionFailed(userId); throw new Error('user_cleanup_failed');
      }
    } finally { this.active.delete(userId); }
  }
}
