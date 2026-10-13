import { randomBytes } from 'node:crypto';

export function notePath(page) {
  if (typeof page !== 'string' || page.length > 120 || !page.trim() || /[\\%?#\x00-\x1f]/.test(page) ||
      page.split('/').some(part => !part || part.startsWith('.'))) throw new Error('invalid_note_path');
  const name = page.endsWith('.md') ? page : page + '.md';
  return name.split('/').map(encodeURIComponent).join('/');
}

export class SilverBullet {
  constructor(store, config) {
    this.store = store; this.config = config; this.cookie = null; this.loginWork = null; this.provisions = new Map();
    const url = new URL(config.baseUrl);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_sb_url');
    this.base = config.baseUrl.replace(/\/$/, '');
  }
  async login() {
    if (this.loginWork) return this.loginWork;
    this.loginWork = (async () => {
      const response = await fetch(this.base + '/.dashboard/api/login', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }) });
      const data = await response.json();
      if (!response.ok || data.status !== 'ok') throw new Error('sb_admin_login_failed');
      this.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      if (!this.cookie) throw new Error('sb_admin_cookie_missing');
    })().finally(() => { this.loginWork = null; });
    return this.loginWork;
  }
  async admin(path, method = 'GET', data) {
    if (!this.cookie) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(this.base + '/.dashboard/api/admin/' + path, { method, redirect: 'error',
        signal: AbortSignal.timeout(20000), headers: { Cookie: this.cookie, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data) });
      if (response.status === 401 && attempt === 0) { this.cookie = null; await this.login(); continue; }
      if (!response.ok) throw Object.assign(new Error('sb_admin_request_failed'), { status: response.status });
      return response.json();
    }
  }
  view(userId) {
    const item = this.store.integration(userId, 'silverbullet');
    return { status: item?.status || 'not_provisioned', ...(item?.status === 'ready' ? {
      url: (this.config.publicUrl || this.base).replace(/\/$/, '') + item.state.prefix + '/', username: item.state.humanUsername } : {}) };
  }
  async provision(user) {
    if (this.provisions.has(user.id)) return this.provisions.get(user.id);
    const work = this.createSpace(user).finally(() => this.provisions.delete(user.id)); this.provisions.set(user.id, work); return work;
  }
  async createSpace(user) {
    let previous = this.store.integration(user.id, 'silverbullet');
    if (previous?.status === 'ready') return this.view(user.id);
    const suffix = user.id.replaceAll('-', '');
    const state = previous?.state || { humanUsername: 'pi_' + suffix, agentUsername: 'agent_' + suffix,
      humanPassword: randomBytes(24).toString('base64url'), agentPassword: randomBytes(24).toString('base64url'),
      prefix: '/users/' + user.id, folder: 'spaces/pi-tenants/' + user.id, token: null, spaceId: null };
    this.store.setIntegration(user.id, 'silverbullet', 'provisioning', state);
    try {
      const users = await this.admin('users');
      for (const [username, password, role] of [[state.humanUsername, state.humanPassword, 'human'], [state.agentUsername, state.agentPassword, 'agent']]) {
        const fullName = `Pi tenant ${user.id} ${role}`;
        const existing = users[username];
        if (existing) {
          if (existing.admin || existing.fullName !== fullName) throw new Error('sb_account_ownership_conflict');
        } else await this.admin('users', 'POST', { username, password, admin: false, fullName, email: '', loginMethod: 'local' });
      }
      const spaces = await this.admin('spaces');
      const existing = Object.entries(spaces).find(([, value]) => value.folder === state.folder);
      if (!state.spaceId && existing) state.spaceId = existing[0];
      const expected = { name: user.username + '的个人空间', folder: state.folder, binding: { prefix: state.prefix },
        access: 'none', members: { [state.humanUsername]: { role: 'write', runtimeApi: false },
          [state.agentUsername]: { role: 'write', runtimeApi: false } }, shell: { enabled: false, whitelist: [] } };
      if (!state.spaceId) {
        const created = await this.admin('spaces', 'POST', expected); state.spaceId = created.id;
        this.store.setIntegration(user.id, 'silverbullet', 'provisioning', state);
      }
      const current = await this.admin('spaces/' + encodeURIComponent(state.spaceId));
      const members = Object.keys(current.members || {}).sort();
      if (current.folder !== state.folder || current.binding?.prefix !== state.prefix || current.access !== 'none' ||
          current.shell?.enabled !== false ||
          members.join() !== Object.keys(expected.members).sort().join() ||
          Object.values(current.members).some(m => m.role !== 'write' || m.runtimeApi !== false)) throw new Error('sb_space_permissions_mismatch');
      if (!state.token) {
        // Stable token name: remove only an orphan created by a lost response.
        await this.admin('users/' + state.agentUsername + '/tokens/pi-assistant', 'DELETE').catch(error => {
          if (![400, 404].includes(error.status)) throw error;
        });
        const minted = await this.admin('users/' + state.agentUsername + '/tokens', 'POST', { name: 'pi-assistant' });
        if (!minted.token) throw new Error('sb_token_missing'); state.token = minted.token;
      }
      this.store.setIntegration(user.id, 'silverbullet', 'ready', state);
      return this.view(user.id);
    } catch (error) { this.store.setIntegration(user.id, 'silverbullet', 'failed', state); throw error; }
  }
  loginDetails(userId) {
    const item = this.store.integration(userId, 'silverbullet');
    if (item?.status !== 'ready') throw new Error('sb_not_ready');
    return { ...this.view(userId), password: item.state.humanPassword };
  }
  async file(userId, page, { method = 'GET', content, etag, signal } = {}) {
    const item = this.store.integration(userId, 'silverbullet');
    if (item?.status !== 'ready') throw new Error('sb_not_ready');
    const url = this.base + item.state.prefix + '/.fs/' + notePath(page);
    const headers = { Authorization: `Bearer ${item.state.token}`, 'Content-Type': 'text/markdown; charset=utf-8', 'X-Sync-Mode': 'true' };
    if (method === 'PUT') {
      if (typeof content !== 'string' || content.length > 30000) throw new Error('invalid_note_content');
      if (etag) headers['If-Match'] = etag; else headers['If-None-Match'] = '*';
    }
    const response = await fetch(url, { method, redirect: 'error', headers, body: content,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
    if (response.status === 412) throw new Error('note_conflict');
    if (response.status === 404) throw new Error('note_not_found');
    if (!response.ok) throw new Error('sb_file_request_failed');
    const text = await response.text();
    if (text.length > 60000) throw new Error('note_too_large');
    return { page, content: text, etag: response.headers.get('etag') };
  }
  tools(userId) {
    if (this.store.integration(userId, 'silverbullet')?.status !== 'ready') return null;
    return { read: (page, signal) => this.file(userId, page, { signal }),
      write: (page, content, etag, signal) => this.file(userId, page, { method: 'PUT', content, etag, signal }) };
  }
  async close() { await Promise.allSettled([...this.provisions.values()]); }
}
