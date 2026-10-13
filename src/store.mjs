import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = join(this.directory, 'assistant.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        user_id TEXT PRIMARY KEY REFERENCES users(id), content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
        sdk_file TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id), prompt TEXT NOT NULL,
        status TEXT NOT NULL, response TEXT, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id);
      CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS traces_run ON traces(run_id, id);
      CREATE TABLE IF NOT EXISTS wechat_logins (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
        qr_token TEXT, qr_image TEXT, base_url TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wechat_bindings (
        id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
        bot_id TEXT UNIQUE NOT NULL, remote_user TEXT UNIQUE NOT NULL, token TEXT NOT NULL,
        base_url TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id));
      CREATE TABLE IF NOT EXISTS wechat_identities (
        remote_user TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id));
      INSERT OR IGNORE INTO wechat_identities SELECT remote_user,user_id FROM wechat_bindings;
      CREATE TABLE IF NOT EXISTS wechat_inbox (
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, bot_id TEXT NOT NULL, message_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id), context_token TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
        delivery TEXT NOT NULL DEFAULT 'pending', UNIQUE(bot_id,message_id));
      CREATE TABLE IF NOT EXISTS integrations (
        user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
        status TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(user_id,kind));
    `);
  }
  close() { this.db.close(); }
  user(username) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username); }
  userById(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  createUser(username, password, role = 'user') {
    const id = randomUUID();
    this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, username, password, role, Date.now());
    return { id, username, role };
  }
  users() { return this.db.prepare('SELECT id,username,role,created_at FROM users ORDER BY created_at').all(); }
  createToken(hash, userId) {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(hash, userId, Date.now() + 86400000);
  }
  principal(hash) {
    return this.db.prepare(`SELECT u.id,u.username,u.role FROM auth_sessions s
      JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?`).get(hash, Date.now());
  }
  deleteToken(hash) { this.db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(hash); }
  memory(userId) { return this.db.prepare('SELECT content FROM memories WHERE user_id=?').get(userId)?.content || ''; }
  writeMemory(userId, content) {
    this.db.prepare('INSERT INTO memories VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET content=excluded.content').run(userId, content);
  }
  createConversation(userId, title) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO conversations VALUES (?,?,?,NULL,?)').run(id, userId, title, Date.now());
    return this.conversation(userId, id);
  }
  conversation(userId, id) { return this.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId); }
  conversations(userId) {
    return this.db.prepare('SELECT id,title,created_at FROM conversations WHERE user_id=? ORDER BY created_at').all(userId);
  }
  setSdkFile(userId, id, file) {
    this.db.prepare('UPDATE conversations SET sdk_file=? WHERE id=? AND user_id=?').run(file, id, userId);
  }
  messages(userId, id) {
    return this.db.prepare(`SELECT m.role,m.content,m.created_at FROM messages m
      JOIN conversations c ON c.id=m.conversation_id WHERE c.id=? AND c.user_id=? ORDER BY m.id`).all(id, userId);
  }
  message(userId, id, role, content) {
    if (!this.conversation(userId, id)) throw new Error('Conversation not found');
    this.db.prepare('INSERT INTO messages VALUES (NULL,?,?,?,?)').run(id, role, content, Date.now());
  }
  createRun(userId, conversationId, prompt) {
    if (!this.conversation(userId, conversationId)) throw new Error('Conversation not found');
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,NULL,NULL,?)').run(id, userId, conversationId, prompt, 'queued', Date.now());
    return this.run(userId, id);
  }
  run(userId, id) { return this.db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(id, userId); }
  recentRuns(userId) {
    return this.db.prepare(`SELECT id,status,substr(prompt,1,120) AS preview,created_at FROM runs
      WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50`).all(userId);
  }
  pending() { return this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at,rowid").all(); }
  runStatus(id, status, response = null, error = null) {
    this.db.prepare('UPDATE runs SET status=?,response=?,error=? WHERE id=?').run(status, response, error, id);
  }
  recover() {
    this.db.prepare("UPDATE runs SET status='interrupted',error='server_restarted' WHERE status='running'").run();
  }
  trace(id, kind, payload) {
    this.db.prepare('INSERT INTO traces VALUES (NULL,?,?,?,?)').run(id, kind, JSON.stringify(payload), Date.now());
  }
  traces(userId, id) {
    return this.db.prepare(`SELECT t.kind,t.payload,t.created_at FROM traces t
      JOIN runs r ON r.id=t.run_id WHERE r.id=? AND r.user_id=? ORDER BY t.id`).all(id, userId)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  loginAttempt(userId, id) { return this.db.prepare('SELECT * FROM wechat_logins WHERE user_id=? AND id=?').get(userId, id); }
  newLogin(userId, expiresAt) {
    this.db.prepare("UPDATE wechat_logins SET status='cancelled',qr_token=NULL,qr_image=NULL WHERE user_id=? AND status IN ('creating','wait','scaned','scaned_but_redirect')").run(userId);
    const id = randomUUID();
    this.db.prepare('INSERT INTO wechat_logins VALUES (?,?,?,NULL,NULL,NULL,?)').run(id, userId, 'creating', expiresAt);
    return this.loginAttempt(userId, id);
  }
  updateLogin(userId, id, status, qrToken = null, qrImage = null, baseUrl = null) {
    this.db.prepare('UPDATE wechat_logins SET status=?,qr_token=?,qr_image=?,base_url=? WHERE user_id=? AND id=?')
      .run(status, qrToken, qrImage, baseUrl, userId, id);
  }
  wechatBinding(userId) { return this.db.prepare('SELECT * FROM wechat_bindings WHERE user_id=?').get(userId); }
  wechatBindings() { return this.db.prepare('SELECT * FROM wechat_bindings').all(); }
  bindWechat(userId, credentials) {
    // Identity must not be silently transferred to another local user.
    const conflict = this.db.prepare('SELECT user_id FROM wechat_bindings WHERE bot_id=? OR remote_user=?').get(credentials.botId, credentials.remoteUser);
    if (conflict && conflict.user_id !== userId) throw new Error('wechat_identity_already_bound');
    const identity = this.db.prepare('SELECT * FROM wechat_identities WHERE remote_user=? OR user_id=?').all(credentials.remoteUser, userId);
    if (identity.some(row => row.user_id !== userId || row.remote_user !== credentials.remoteUser)) throw new Error('wechat_identity_mismatch');
    if (this.wechatBinding(userId)) throw new Error('wechat_already_bound');
    const conversation = this.createConversation(userId, '微信生活日常');
    this.db.prepare('INSERT INTO wechat_bindings VALUES (?,?,?,?,?,?,?, ?,?)').run(randomUUID(), userId,
      credentials.botId, credentials.remoteUser, credentials.token, credentials.baseUrl, '', 'connected', conversation.id);
    this.db.prepare('INSERT OR IGNORE INTO wechat_identities VALUES (?,?)').run(credentials.remoteUser, userId);
    return this.wechatBinding(userId);
  }
  removeWechat(userId) {
    const binding = this.wechatBinding(userId);
    if (binding) this.db.prepare("UPDATE wechat_inbox SET delivery='cancelled' WHERE binding_id=? AND delivery='pending'").run(binding.id);
    this.db.prepare('DELETE FROM wechat_bindings WHERE user_id=?').run(userId);
    this.db.prepare("UPDATE wechat_logins SET status='cancelled',qr_token=NULL,qr_image=NULL WHERE user_id=?").run(userId);
  }
  bindingStatus(id, status) { this.db.prepare('UPDATE wechat_bindings SET status=? WHERE id=?').run(status, id); }
  bindingCursor(id, cursor) { this.db.prepare('UPDATE wechat_bindings SET cursor=? WHERE id=?').run(cursor, id); }
  acceptWechat(binding, message) {
    if (this.db.prepare('SELECT id FROM wechat_inbox WHERE bot_id=? AND message_id=?').get(binding.bot_id, message.id)) return true;
    const queued = this.pending();
    if (queued.length >= 20 || queued.filter(r => r.user_id === binding.user_id).length >= 5) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.createRun(binding.user_id, binding.conversation_id, message.text);
      this.db.prepare('INSERT INTO wechat_inbox VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), binding.id,
        binding.bot_id, message.id, binding.user_id, message.contextToken, run.id, 'pending');
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deliveries() {
    return this.db.prepare(`SELECT i.*,r.status,r.response,r.error FROM wechat_inbox i JOIN runs r ON r.id=i.run_id
      WHERE i.delivery='pending' AND r.status IN ('completed','failed','interrupted') ORDER BY r.created_at,i.rowid`).all();
  }
  delivered(id, status = 'sent') { this.db.prepare('UPDATE wechat_inbox SET delivery=? WHERE id=?').run(status, id); }
  integration(userId, kind) {
    const row = this.db.prepare('SELECT status,state FROM integrations WHERE user_id=? AND kind=?').get(userId, kind);
    return row && { status: row.status, state: JSON.parse(row.state) };
  }
  setIntegration(userId, kind, status, state) {
    this.db.prepare('INSERT INTO integrations VALUES (?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET status=excluded.status,state=excluded.state')
      .run(userId, kind, status, JSON.stringify(state));
  }
}
