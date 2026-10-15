import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { notePath, NoteLifecycle } from './note-lifecycle.mjs';
import { NoteCatalog } from './note-catalog.mjs';
export { notePath } from './note-lifecycle.mjs';

export class SilverBullet {
  constructor(store, config) {
    this.store = store; this.config = config; this.cookie = null; this.loginWork = null; this.provisions = new Map(); this.loginChanges = new Map();
    this.noteOperations = new Map();
    const url = new URL(config.baseUrl);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_sb_url');
    this.base = config.baseUrl.replace(/\/$/, '');
    // Connect over loopback while presenting the configured public origin to native auth.
    const origin = new URL(config.publicUrl || config.baseUrl);
    this.originHeaders = { Host: origin.host, 'X-Forwarded-Proto': origin.protocol.slice(0, -1) };
  }
  // Node fetch replaces Host. Native dashboard auth requires the public Host even over loopback.
  adminFetch(path, { method, headers, body }) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.base + path), request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(url, { method, headers }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2_000_000) req.destroy(new Error('sb_response_too_large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const resultHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) resultHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
        });
      });
      req.setTimeout(20000, () => req.destroy(new Error('sb_request_timeout')));
      req.on('error', reject); req.end(body);
    });
  }
  async login() {
    if (this.loginWork) return this.loginWork;
    this.loginWork = (async () => {
      const response = await this.adminFetch('/.dashboard/api/login', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { ...this.originHeaders, 'Content-Type': 'application/json' },
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
      const response = await this.adminFetch('/.dashboard/api/admin/' + path, { method, redirect: 'error',
        signal: AbortSignal.timeout(20000), headers: { ...this.originHeaders, Cookie: this.cookie, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data) });
      if (response.status === 401 && attempt === 0) { this.cookie = null; await this.login(); continue; }
      if (!response.ok) throw Object.assign(new Error('sb_admin_request_failed'), { status: response.status });
      return response.json();
    }
  }
  view(userId) {
    const item = this.store.integration(userId, 'silverbullet');
    return { status: item?.status || 'not_provisioned', ...(item?.status === 'ready' ? {
      passwordUnified: !!item.state.passwordUnified,
      url: (this.config.publicUrl || this.base).replace(/\/$/, '') + item.state.prefix + '/', username: item.state.humanUsername } : {}) };
  }
  async provision(user) {
    this.store.requireUsable(user.id);
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
    return { ...this.view(userId), password: item.state.humanPassword, passwordManagedByUser: !!item.state.passwordManagedByUser };
  }
  async setUnifiedLogin(user, password, username) {
    const previous = this.store.integration(user.id, 'silverbullet')?.state;
    await this.setHumanLogin(user, { username: username || (previous?.passwordManagedByUser ? previous.humanUsername : user.username), password });
    const item = this.store.integration(user.id, 'silverbullet');
    this.store.setIntegration(user.id, 'silverbullet', 'ready', { ...item.state, passwordUnified: true });
    return this.view(user.id);
  }
  async setHumanLogin(user, { username, password }) {
    this.store.requireUsable(user.id);
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('invalid_sb_credentials');
    if (this.loginChanges.has(user.id)) throw new Error('sb_busy');
    const work = this.changeHumanLogin(user, username, password).finally(() => this.loginChanges.delete(user.id));
    this.loginChanges.set(user.id, work); return work;
  }
  async changeHumanLogin(user, username, password) {
    await this.provision(user);
    const state = this.store.integration(user.id, 'silverbullet').state, accounts = await this.admin('users');
    const marker = `Pi tenant ${user.id} human`, target = accounts[username];
    if (username === state.agentUsername || (target && (target.admin || target.fullName !== marker))) throw new Error('sb_username_conflict');
    const current = await this.admin('spaces/' + state.spaceId);
    const names = Object.keys(current.members || {}).sort().join();
    if (current.access !== 'none' || current.folder !== state.folder || current.binding?.prefix !== state.prefix || current.shell?.enabled !== false ||
        ![[state.humanUsername,state.agentUsername], [username,state.agentUsername]].some(pair => pair.sort().join() === names) ||
        Object.values(current.members).some(m => m.role !== 'write' || m.runtimeApi !== false)) throw new Error('sb_space_permissions_mismatch');
    if (!target) await this.admin('users', 'POST', { username, password, admin: false, fullName: marker, email: '', loginMethod: 'local' });
    else await this.admin('users/' + username + '/password', 'POST', { password });
    if (username !== state.humanUsername) {
      const members = { [username]: { role: 'write', runtimeApi: false }, [state.agentUsername]: { role: 'write', runtimeApi: false } };
      await this.admin('spaces/' + state.spaceId, 'PATCH', { members });
      const updated = await this.admin('spaces/' + state.spaceId);
      if (Object.keys(updated.members || {}).sort().join() !== Object.keys(members).sort().join() ||
          Object.values(updated.members).some(m => m.role !== 'write' || m.runtimeApi !== false)) throw new Error('sb_space_permissions_mismatch');
    }
    const former = state.humanUsername;
    this.store.setIntegration(user.id, 'silverbullet', 'ready', { ...state, humanUsername: username, humanPassword: null, passwordManagedByUser: true, passwordUnified: false });
    if (former !== username && accounts[former]?.fullName === marker && accounts[former]?.admin === false) {
      await this.admin('users/' + former, 'DELETE').catch(() => {});
    }
    return this.view(user.id);
  }
  busy(userId) { return this.provisions.has(userId) || this.loginChanges.has(userId) || this.noteOperations.has(userId); }
  async archiveUser(user) {
    const item = this.store.integration(user.id, 'silverbullet');
    if (!item) return null;
    if (this.busy(user.id)) throw new Error('sb_busy');
    const state = item.state, folder = 'spaces/pi-tenants/' + user.id, prefix = '/users/' + user.id;
    if (state.folder !== folder || state.prefix !== prefix) throw new Error('sb_space_ownership_mismatch');
    const accounts = await this.admin('users'), spaces = await this.admin('spaces');
    const markers = [`Pi tenant ${user.id} human`, `Pi tenant ${user.id} agent`];
    const ownedAccounts = Object.keys(accounts).filter(name => markers.includes(accounts[name].fullName));
    for (const name of [state.humanUsername, state.agentUsername, ...ownedAccounts]) {
      if (accounts[name] && (accounts[name].admin || !markers.includes(accounts[name].fullName) || name === this.config.username)) throw new Error('sb_account_ownership_conflict');
    }
    const ownedSpaces = Object.entries(spaces).filter(([id, space]) => id === state.spaceId || space.folder === folder);
    const allowedMembers = new Set([state.humanUsername, state.agentUsername, ...ownedAccounts]);
    for (const [, space] of ownedSpaces) {
      if (space.folder !== folder || space.binding?.prefix !== prefix || space.access !== 'none' ||
          Object.keys(space.members || {}).some(name => !allowedMembers.has(name))) throw new Error('sb_space_ownership_mismatch');
    }
    for (const [id, space] of Object.entries(spaces)) {
      if (!ownedSpaces.some(([ownedId]) => ownedId === id) && Object.keys(space.members || {}).some(name => ownedAccounts.includes(name))) throw new Error('sb_account_in_other_space');
    }
    for (const [id] of ownedSpaces) {
      const path = 'spaces/' + encodeURIComponent(id);
      await this.admin(path, 'PATCH', { name: `已删除用户 ${user.username} (${user.id})`, members: {}, access: 'none', shell: { enabled: false, whitelist: [] } });
      const archived = await this.admin(path);
      if (archived.folder !== folder || archived.binding?.prefix !== prefix || archived.access !== 'none' ||
          Object.keys(archived.members || {}).length || archived.shell?.enabled !== false) throw new Error('sb_archive_permissions_mismatch');
    }
    for (const name of ownedAccounts) await this.admin('users/' + encodeURIComponent(name), 'DELETE');
    const remaining = await this.admin('users');
    if (Object.values(remaining).some(account => markers.includes(account.fullName))) throw new Error('sb_account_cleanup_incomplete');
    // Archive the space with no members instead of guessing whether DELETE also erases its files.
    return { folder, spaceIds: ownedSpaces.map(([id]) => id) };
  }
  async file(userId, page, { method = 'GET', content, etag, signal } = {}) {
    this.store.requireUsable(userId);
    const item = this.store.integration(userId, 'silverbullet');
    if (item?.status !== 'ready') throw new Error('sb_not_ready');
    if (item.state.prefix !== '/users/' + userId || item.state.folder !== 'spaces/pi-tenants/' + userId) throw new Error('sb_space_ownership_mismatch');
    if (!['GET', 'PUT', 'DELETE'].includes(method)) throw new Error('invalid_note_method');
    const url = this.base + item.state.prefix + '/.fs/' + notePath(page);
    const headers = { Authorization: `Bearer ${item.state.token}`, 'Content-Type': 'text/markdown; charset=utf-8', 'X-Sync-Mode': 'true' };
    if (method === 'PUT') {
      if (typeof content !== 'string' || content.length > 30000) throw new Error('invalid_note_content');
      if (etag) headers['If-Match'] = etag; else headers['If-None-Match'] = '*';
    }
    if (method === 'DELETE') {
      if (typeof etag !== 'string' || !etag || etag.length > 256) throw new Error('note_revision_required');
      headers['If-Match'] = etag;
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
  async inventory(userId, signal) {
    this.store.requireUsable(userId);
    const item = this.store.integration(userId, 'silverbullet');
    if (item?.status !== 'ready') throw new Error('sb_not_ready');
    if (item.state.prefix !== '/users/' + userId || item.state.folder !== 'spaces/pi-tenants/' + userId) throw new Error('sb_space_ownership_mismatch');
    const response = await fetch(this.base + item.state.prefix + '/.fs', { redirect: 'error',
      headers: { Authorization: `Bearer ${item.state.token}`, 'X-Sync-Mode': 'true' },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new Error('sb_inventory_request_failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2_000_000) throw new Error('note_inventory_too_large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('invalid_note_inventory'); }
  }
  tools(userId) {
    if (this.store.integration(userId, 'silverbullet')?.status !== 'ready') return null;
    const notes = new NoteLifecycle((page, options) => this.file(userId, page, options), this.store.directory, userId);
    const catalog = new NoteCatalog({ inventory: signal => this.inventory(userId, signal),
      read: (page, signal) => this.file(userId, page, { signal }), url: () => this.view(userId).url });
    const operation = work => {
      this.store.requireUsable(userId);
      if (this.busy(userId)) throw new Error('sb_busy');
      const pending = Promise.resolve().then(work).finally(() => this.noteOperations.delete(userId));
      this.noteOperations.set(userId, pending); return pending;
    };
    return { list: (input, signal) => catalog.list(input, signal), search: (input, signal) => catalog.search(input, signal),
      read: (page, signal) => this.file(userId, page, { signal }),
      write: (page, content, etag, signal) => this.file(userId, page, { method: 'PUT', content, etag, signal }),
      archive: (page, etag, reason, signal) => operation(() => notes.archive(page, etag, reason, signal)),
      restore: (page, etag, signal) => operation(() => notes.restore(page, etag, signal)),
      remove: (page, etag, confirm, reason, signal) => operation(() => notes.remove(page, etag, confirm, reason, signal)) };
  }
  async close() { await Promise.allSettled([...this.provisions.values(), ...this.loginChanges.values(), ...this.noteOperations.values()]); }
}
