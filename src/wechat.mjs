import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
export function wechatBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !url.hostname.endsWith('.weixin.qq.com') || url.pathname !== '/' || url.search || url.hash) throw new Error('untrusted_wechat_host');
  return url.origin;
}

export class ILinkClient {
  constructor() { this.uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'); }
  async request(base, path, { token, body, signal, timeout = 15000, headers = {} } = {}) {
    const response = await fetch(wechatBase(base) + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]),
      headers: { 'Content-Type': 'application/json', ...headers,
        ...(token ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}`, 'X-WECHAT-UIN': this.uin } : {}) },
      body: body === undefined ? undefined : JSON.stringify({ ...body, base_info: { channel_version: '1.0.0' } }),
    });
    const data = await response.json();
    if (data.errcode === -14 || data.ret === -14) throw new Error('wechat_session_expired');
    if (!response.ok || (typeof data.ret === 'number' && data.ret !== 0)) throw new Error('wechat_request_failed');
    return data;
  }
  qr(signal) { return this.request(DEFAULT_BASE, '/ilink/bot/get_bot_qrcode?bot_type=3', { signal }); }
  status(token, base, signal) { return this.request(base, '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(token), { signal, headers: { 'iLink-App-ClientVersion': '1' } }); }
  updates(binding, signal) {
    return this.request(binding.base_url, '/ilink/bot/getupdates', { token: binding.token, signal, timeout: 55000, body: { get_updates_buf: binding.cursor } });
  }
  send(binding, inbox, text, clientId, signal) {
    return this.request(binding.base_url, '/ilink/bot/sendmessage', { token: binding.token, signal,
      body: { msg: { from_user_id: '', to_user_id: binding.remote_user, client_id: clientId,
        message_type: 2, message_state: 2, context_token: inbox.context_token,
        item_list: [{ type: 1, text_item: { text } }] } } });
  }
}

export class WechatManager {
  constructor(store, client, { protectedBots = [], protectedUsers = [], onMessage = () => {}, pollDelayMs = 1000 } = {}) {
    this.store = store; this.client = client; this.protectedBots = protectedBots; this.protectedUsers = protectedUsers;
    this.onMessage = onMessage; this.pollDelayMs = pollDelayMs; this.controllers = new Map(); this.loops = new Map();
    this.checks = new Map(); this.flushWork = null; this.closed = false; this.abort = new AbortController();
  }
  start() {
    for (const binding of this.store.wechatBindings()) if (binding.status === 'connected') this.connect(binding);
    void this.flush();
    this.deliveryTimer = setInterval(() => { void this.flush(); }, 5000); this.deliveryTimer.unref();
  }
  view(userId) {
    const binding = this.store.wechatBinding(userId);
    return { status: binding?.status || 'not_bound', ...(binding ? { botId: binding.bot_id } : {}) };
  }
  async login(userId) {
    if (this.closed) throw new Error('wechat_closed');
    if (this.store.wechatBinding(userId)) throw new Error('wechat_already_bound');
    const attempt = this.store.newLogin(userId, Date.now() + 300000);
    try {
      const qr = await this.client.qr(this.abort.signal);
      if (this.closed) throw new Error('wechat_closed');
      if (!qr.qrcode || typeof qr.qrcode_img_content !== 'string' || qr.qrcode_img_content.length > 2048) throw new Error('invalid_wechat_qr');
      const image = await QRCode.toDataURL(qr.qrcode_img_content, { width: 280 });
      if (this.closed) throw new Error('wechat_closed');
      if (this.store.loginAttempt(userId, attempt.id)?.status !== 'creating') throw new Error('login_cancelled');
      this.store.updateLogin(userId, attempt.id, 'wait', qr.qrcode, image, DEFAULT_BASE);
      return this.publicAttempt(this.store.loginAttempt(userId, attempt.id));
    } catch (error) {
      if (!this.closed && this.store.loginAttempt(userId, attempt.id)?.status === 'creating') this.store.updateLogin(userId, attempt.id, 'failed');
      throw error;
    }
  }
  publicAttempt(attempt) { return { id: attempt.id, status: attempt.status, expiresAt: attempt.expires_at, image: attempt.qr_image }; }
  async status(userId, id) {
    if (this.closed) throw new Error('wechat_closed');
    const attempt = this.store.loginAttempt(userId, id);
    if (!attempt) throw new Error('login_not_found');
    if (!['wait', 'scaned', 'scaned_but_redirect'].includes(attempt.status)) return this.publicAttempt(attempt);
    if (attempt.expires_at <= Date.now()) { this.store.updateLogin(userId, id, 'expired'); return this.publicAttempt(this.store.loginAttempt(userId, id)); }
    if (this.checks.has(id)) return this.checks.get(id);
    const work = this.checkStatus(attempt).finally(() => this.checks.delete(id)); this.checks.set(id, work); return work;
  }
  async checkStatus(attempt) {
    const result = await this.client.status(attempt.qr_token, attempt.base_url, this.abort.signal);
    if (this.closed) throw new Error('wechat_closed');
    const current = this.store.loginAttempt(attempt.user_id, attempt.id);
    if (!['wait', 'scaned', 'scaned_but_redirect'].includes(current.status)) return this.publicAttempt(current);
    if (current.expires_at <= Date.now()) { this.store.updateLogin(attempt.user_id, attempt.id, 'expired'); return this.publicAttempt(this.store.loginAttempt(attempt.user_id, attempt.id)); }
    if (result.status === 'confirmed') {
      try {
        const credentials = { token: result.bot_token, botId: result.ilink_bot_id, remoteUser: result.ilink_user_id,
          baseUrl: wechatBase(result.baseurl || current.base_url) };
        if (![credentials.token, credentials.botId, credentials.remoteUser].every(value => typeof value === 'string' && value.length)) throw new Error('invalid_wechat_identity');
        if (this.protectedBots.includes(credentials.botId) || this.protectedUsers.includes(credentials.remoteUser)) throw new Error('protected_wechat_identity');
        const binding = this.store.bindWechat(attempt.user_id, credentials);
        this.store.updateLogin(attempt.user_id, attempt.id, 'confirmed'); this.connect(binding);
      } catch (error) { this.store.updateLogin(attempt.user_id, attempt.id, 'failed'); throw error; }
    } else {
      if (!['wait', 'scaned', 'scaned_but_redirect', 'expired'].includes(result.status)) throw new Error('invalid_wechat_status');
      const base = result.redirect_host ? wechatBase('https://' + result.redirect_host) : current.base_url;
      this.store.updateLogin(attempt.user_id, attempt.id, result.status,
        result.status === 'expired' ? null : current.qr_token, result.status === 'expired' ? null : current.qr_image, base);
    }
    return this.publicAttempt(this.store.loginAttempt(attempt.user_id, attempt.id));
  }
  disconnect(userId) {
    const binding = this.store.wechatBinding(userId);
    if (binding) this.controllers.get(binding.id)?.abort();
    this.store.removeWechat(userId);
  }
  cancelLogin(userId, id) {
    const attempt = this.store.loginAttempt(userId, id);
    if (!attempt) throw new Error('login_not_found');
    if (attempt.status !== 'confirmed') this.store.updateLogin(userId, id, 'cancelled');
    return this.publicAttempt(this.store.loginAttempt(userId, id));
  }
  connect(binding) {
    if (this.closed || this.loops.has(binding.id)) return;
    const controller = new AbortController(); this.controllers.set(binding.id, controller);
    const work = this.poll(binding, controller.signal).finally(() => { this.controllers.delete(binding.id); this.loops.delete(binding.id); });
    this.loops.set(binding.id, work);
  }
  current(binding) { return this.store.wechatBinding(binding.user_id)?.id === binding.id; }
  ingest(binding, raw) {
    if (!this.current(binding) || raw.message_type !== 1 || raw.from_user_id !== binding.remote_user ||
        (raw.to_user_id && raw.to_user_id !== binding.bot_id) || typeof raw.context_token !== 'string' ||
        !raw.context_token || raw.context_token.length > 8192 || raw.message_id == null) return true;
    const messageId = String(raw.message_id);
    if (!messageId || messageId.length > 256 || !Array.isArray(raw.item_list)) return true;
    const text = raw.item_list.map(item => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '')
      .filter(value => typeof value === 'string' && value.length).join('\n');
    // Initial transport supports text/voice transcription; no implicit media downloads.
    if (!text || text.length > 8000) return true;
    const accepted = this.store.acceptWechat(binding, { id: messageId, text, contextToken: raw.context_token });
    if (accepted) this.onMessage();
    return accepted;
  }
  async poll(binding, signal) {
    while (!signal.aborted && !this.closed && this.current(binding)) {
      try {
        const latest = this.store.wechatBinding(binding.user_id);
        const response = await this.client.updates(latest, signal);
        if (signal.aborted || !this.current(binding)) return;
        let acceptedAll = true;
        for (const message of response.msgs || []) if (!this.ingest(binding, message)) acceptedAll = false;
        if (acceptedAll && response.get_updates_buf) this.store.bindingCursor(binding.id, response.get_updates_buf);
        await this.flush();
      } catch (error) {
        if (signal.aborted || this.closed) return;
        if (error.message === 'wechat_session_expired') { this.store.bindingStatus(binding.id, 'expired'); return; }
      }
      try { await delay(this.pollDelayMs, undefined, { signal }); } catch { return; }
    }
  }
  async flush() {
    if (this.closed) return;
    if (this.flushWork) return this.flushWork;
    this.flushWork = this.deliver().finally(() => { this.flushWork = null; }); return this.flushWork;
  }
  async deliver() {
    for (const inbox of this.store.deliveries()) {
      const binding = this.store.wechatBinding(inbox.user_id);
      if (!binding || binding.id !== inbox.binding_id) { this.store.delivered(inbox.id, 'cancelled'); continue; }
      if (binding.status !== 'connected') continue;
      try {
        const reply = inbox.status === 'completed' ? inbox.response : '本次处理未完成，请稍后重试。';
        const characters = Array.from(reply), chunks = [];
        for (let offset = 0; offset < characters.length; offset += 3000) chunks.push(characters.slice(offset, offset + 3000).join(''));
        for (let i = 0; i < chunks.length; i++) {
          if (this.closed || !this.current(binding)) break;
          const connectionSignal = this.controllers.get(binding.id)?.signal;
          const signal = connectionSignal ? AbortSignal.any([this.abort.signal, connectionSignal]) : this.abort.signal;
          await this.client.send(binding, inbox, chunks[i], `pi-${inbox.id}-${i}`, signal);
        }
        if (!this.closed && this.current(binding)) this.store.delivered(inbox.id);
      } catch (error) {
        if (error.message === 'wechat_session_expired') this.store.bindingStatus(binding.id, 'expired');
        // Keep the stable client IDs and durable outbox for a later retry.
      }
    }
  }
  async close() {
    this.closed = true; this.abort.abort(); clearInterval(this.deliveryTimer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.loops.values(), this.flushWork]);
  }
}
