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
}
