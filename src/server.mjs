import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hashPassword, checkPassword, issueToken, tokenHash, requestToken } from './auth.mjs';
import { RunQueue } from './queue.mjs';
import { WechatManager } from './wechat.mjs';

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
function text(value, maximum = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'invalid_input');
  return value;
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'json_required');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw new HttpError(400, 'invalid_json'); }
}

export async function makeServer({ store, engine, adminPassword, secureCookies = false, origin, timeoutMs,
  wechatClient, wechatOptions, silverbullet }) {
  if (!store.users().some(user => user.role === 'admin')) {
    text(adminPassword, 256);
    if (adminPassword.length < 12) throw new Error('Bootstrap admin password must have at least 12 characters');
    store.createUser('admin', await hashPassword(adminPassword), 'admin');
  }
  const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
  const queue = new RunQueue(store, engine, { timeoutMs, contextFactory: userId => ({ notes: silverbullet?.tools(userId) }) });
  const wechat = wechatClient && new WechatManager(store, wechatClient, { ...wechatOptions, onMessage: () => queue.kick() });
  if (wechat) { queue.on('settled', () => { void wechat.flush(); }); wechat.start(); }
  if (silverbullet && wechat) {
    for (const binding of store.wechatBindings()) {
      if (binding.status === 'connected') void silverbullet.provision(store.userById(binding.user_id)).catch(() => {});
    }
  }
  const index = readFileSync(new URL('../public/index.html', import.meta.url));
  let activeLogins = 0;
  const failures = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.headers.origin && req.headers.origin !== (origin || `http://${req.headers.host}`)) throw new HttpError(403, 'origin_denied');
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(index); return;
      }
      if (req.method === 'GET' && ['/app.js', '/style.css'].includes(path)) {
        const file = readFileSync(new URL('../public' + path, import.meta.url));
        res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(file); return;
      }
      if (req.method === 'GET' && path === '/health') return reply(200, { status: 'ok', mode: engine.mode || 'mock' });
      if (req.method === 'POST' && path === '/api/login') {
        const input = await body(req), username = text(input.username, 64), password = text(input.password, 256);
        const address = req.socket.remoteAddress;
        for (const [key, entry] of failures) if (entry.until < Date.now()) failures.delete(key);
        if (activeLogins >= 2 || failures.size >= 1000 || (failures.get(address)?.count || 0) >= 10) throw new HttpError(429, 'login_throttled');
        activeLogins++;
        const user = store.user(username); let valid;
        try { valid = await checkPassword(password, user?.password || dummyPassword); } finally { activeLogins--; }
        if (!user || !valid) {
          const entry = failures.get(address) || { count: 0, until: Date.now() + 60000 }; entry.count++; failures.set(address, entry);
          throw new HttpError(401, 'invalid_credentials');
        }
        const token = issueToken(store, user.id);
        res.setHeader('Set-Cookie', `pi_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookies ? '; Secure' : ''}`);
        return reply(200, { token, user: { id: user.id, username: user.username, role: user.role } });
      }
      const token = requestToken(req), principal = token && store.principal(tokenHash(token));
      if (!principal) throw new HttpError(401, 'authentication_required');
      if (req.method === 'POST' && path === '/api/logout') {
        await body(req); store.deleteToken(tokenHash(token));
        res.setHeader('Set-Cookie', 'pi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return reply(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/me') return reply(200, principal);
      if (path.startsWith('/api/admin/')) {
        if (principal.role !== 'admin') throw new HttpError(403, 'admin_required');
        if (req.method === 'GET' && path === '/api/admin/users') return reply(200, {
          users: store.users().map(user => ({ ...user, wechat: wechat?.view(user.id) || { status: 'disabled' },
            silverbullet: silverbullet?.view(user.id) || { status: 'disabled' } })), mode: engine.mode || 'mock',
          wechatEnabled: Boolean(wechat), silverbulletEnabled: Boolean(silverbullet) });
        if (req.method === 'POST' && path === '/api/admin/users') {
          const input = await body(req), username = text(input.username, 64);
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) throw new HttpError(400, 'invalid_username');
          if (store.user(username)) throw new HttpError(409, 'username_exists');
          const password = input.password || randomBytes(32).toString('base64url');
          text(password, 256);
          if (password.length < 12) throw new HttpError(400, 'password_too_short');
          // A request cannot supply a role or a filesystem path.
          const user = store.createUser(username, await hashPassword(password));
          return reply(201, user);
        }
        const integration = path.match(/^\/api\/admin\/users\/([^/]+)\/(wechat|silverbullet)(?:\/(login|credentials)(?:\/([^/]+))?)?$/);
        if (integration) {
          const user = store.userById(integration[1]);
          if (!user || user.role !== 'user') throw new HttpError(404, 'not_found');
          const [, , kind, action, attemptId] = integration;
          if (kind === 'wechat') {
            if (!wechat) throw new HttpError(503, 'wechat_disabled');
            if (req.method === 'POST' && action === 'login' && !attemptId) {
              await body(req);
              try { return reply(201, await wechat.login(user.id)); }
              catch (error) { throw new HttpError(409, error.message === 'wechat_already_bound' ? error.message : 'wechat_login_failed'); }
            }
            if (req.method === 'GET' && action === 'login' && attemptId) {
              try {
                const result = await wechat.status(user.id, attemptId);
                if (result.status === 'confirmed' && silverbullet) void silverbullet.provision(user).catch(() => {});
                return reply(200, result);
              }
              catch (error) {
                if (error.message === 'login_not_found') throw new HttpError(404, 'not_found');
                throw new HttpError(409, 'wechat_binding_failed');
              }
            }
            if (req.method === 'DELETE' && action === 'login' && attemptId) {
              await body(req);
              try { return reply(200, wechat.cancelLogin(user.id, attemptId)); }
              catch { throw new HttpError(404, 'not_found'); }
            }
            if (req.method === 'DELETE' && !action) { await body(req); wechat.disconnect(user.id); return reply(200, { ok: true }); }
            if (req.method === 'GET' && !action) return reply(200, wechat.view(user.id));
          } else {
            if (!silverbullet) throw new HttpError(503, 'silverbullet_disabled');
            if (req.method === 'POST' && !action) {
              await body(req);
              try { return reply(201, await silverbullet.provision(user)); }
              catch { throw new HttpError(502, 'silverbullet_provision_failed'); }
            }
            // Human login credentials require an explicit administrator action.
            if (req.method === 'POST' && action === 'credentials') {
              await body(req);
              try { return reply(200, silverbullet.loginDetails(user.id)); }
              catch { throw new HttpError(409, 'silverbullet_not_ready'); }
            }
            if (req.method === 'GET' && !action) return reply(200, silverbullet.view(user.id));
          }
        }
      }
      const note = path.match(/^\/api\/notes\/(.+)$/);
      if (note && ['GET', 'PUT'].includes(req.method)) {
        if (!silverbullet) throw new HttpError(503, 'silverbullet_disabled');
        let page;
        try { page = decodeURIComponent(note[1]); } catch { throw new HttpError(400, 'invalid_note_path'); }
        const input = req.method === 'PUT' ? await body(req) : {};
        try { return reply(200, await silverbullet.file(principal.id, page, { method: req.method,
          content: input.content, etag: input.etag })); }
        catch (error) {
          const codes = { invalid_note_path: 400, invalid_note_content: 400, note_conflict: 409, note_not_found: 404, sb_not_ready: 409 };
          throw new HttpError(codes[error.message] || 502, codes[error.message] ? error.message : 'note_request_failed');
        }
      }
      if (req.method === 'GET' && path === '/api/memory') return reply(200, { content: store.memory(principal.id) });
      if (req.method === 'PUT' && path === '/api/memory') {
        const input = await body(req);
        if (typeof input.content !== 'string' || input.content.length > 8000) throw new HttpError(400, 'invalid_memory');
        store.writeMemory(principal.id, input.content); return reply(200, { ok: true });
      }
      if (path === '/api/conversations') {
        if (req.method === 'GET') return reply(200, { conversations: store.conversations(principal.id) });
        if (req.method === 'POST') { const input = await body(req); return reply(201, store.createConversation(principal.id, text(input.title || '生活日常', 100))); }
      }
      const conversation = path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|runs))?$/);
      if (conversation) {
        const item = store.conversation(principal.id, conversation[1]);
        if (!item) throw new HttpError(404, 'not_found');
        if (req.method === 'GET' && conversation[2] === 'messages') return reply(200, { messages: store.messages(principal.id, item.id) });
        if (req.method === 'POST' && conversation[2] === 'runs') {
          const input = await body(req), prompt = text(input.prompt);
          const waiting = store.pending();
          if (waiting.length >= 20 || waiting.filter(r => r.user_id === principal.id).length >= 5) throw new HttpError(429, 'queue_full');
          const run = store.createRun(principal.id, item.id, prompt); queue.kick();
          return reply(202, { id: run.id, status: run.status });
        }
      }
      const run = path.match(/^\/api\/runs\/([^/]+)(?:\/(trace))?$/);
      if (run && req.method === 'GET') {
        const item = store.run(principal.id, run[1]);
        if (!item) throw new HttpError(404, 'not_found');
        return reply(200, run[2] ? { events: store.traces(principal.id, item.id) } : item);
      }
      throw new HttpError(404, 'not_found');
    } catch (error) {
      if (!res.headersSent) reply(error.status || 500, { error: error.status ? error.message : 'internal_error' });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, queue, wechat, async close() {
    const closed = server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    server.closeIdleConnections(); await wechat?.close(); await queue.close(); await closed; await silverbullet?.close(); store.close();
  } };
}
