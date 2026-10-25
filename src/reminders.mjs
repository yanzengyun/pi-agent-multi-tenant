import { randomUUID } from 'node:crypto';

const DAY = 86400000;
export const REMINDER_TTL_MS = 30 * 60000;
const weekday = at => new Date(at + 8 * 3600000).getUTCDay();
export function nextReminderAt(at, now, weekdaysOnly = false) {
  let next = at + (Math.floor((now - at) / DAY) + 1) * DAY;
  while (weekdaysOnly && [0, 6].includes(weekday(next))) next += DAY;
  return next;
}
export class Reminders {
  constructor(store, onDue = () => {}) { this.store = store; this.onDue = onDue; }
  list(userId) { return this.store.db.prepare('SELECT r.id,r.text,r.next_at,r.repeat_daily,r.status,COALESCE(s.weekdays_only,0) weekdays_only FROM reminders r LEFT JOIN reminder_schedules s ON s.reminder_id=r.id WHERE r.user_id=? ORDER BY r.next_at').all(userId); }
  create(userId, { text, at, daily = false, weekdaysOnly = false }, now = Date.now()) {
    this.store.requireUsable(userId);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || typeof daily !== 'boolean' || typeof weekdaysOnly !== 'boolean' || (weekdaysOnly && !daily)) throw new Error('invalid_reminder');
    let when = Date.parse(at);
    if (!Number.isFinite(when) || when <= now || when > now + 366 * DAY) throw new Error('invalid_reminder_time');
    const day = Date.parse(at.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== at.slice(0, 10)) throw new Error('invalid_reminder_time');
    if (this.list(userId).filter(task => !['completed', 'expired'].includes(task.status)).length >= 20) throw new Error('reminder_limit');
    while (weekdaysOnly && [0, 6].includes(weekday(when))) when += DAY;
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO reminders VALUES (?,?,?,?,?,?)').run(id, userId, text, when, daily ? 1 : 0, 'scheduled');
    this.store.db.prepare('INSERT INTO reminder_schedules VALUES (?,?)').run(id, weekdaysOnly ? 1 : 0);
    return this.list(userId).find(task => task.id === id);
  }
  remove(userId, id) {
    if (!this.store.db.prepare('DELETE FROM reminders WHERE id=? AND user_id=?').run(id, userId).changes) throw new Error('reminder_not_found');
    this.store.db.prepare('DELETE FROM reminder_schedules WHERE reminder_id=?').run(id);
    this.store.db.prepare("UPDATE wechat_inbox SET delivery='cancelled' WHERE user_id=? AND message_id LIKE ? AND delivery='pending'").run(userId, `reminder:${id}:%`);
    return { ok: true };
  }
  tick(now = Date.now()) {
    let delivered = 0;
    for (const task of this.store.db.prepare("SELECT * FROM reminders WHERE status NOT IN ('completed','expired') AND next_at<=? ORDER BY next_at LIMIT 100").all(now)) {
      const weekdaysOnly = !!this.store.db.prepare('SELECT weekdays_only FROM reminder_schedules WHERE reminder_id=?').get(task.id)?.weekdays_only;
      if (now - task.next_at > REMINDER_TTL_MS || (weekdaysOnly && [0, 6].includes(weekday(task.next_at)))) {
        this.store.db.prepare('UPDATE reminders SET next_at=?,status=? WHERE id=?').run(
          task.repeat_daily ? nextReminderAt(task.next_at, now, weekdaysOnly) : task.next_at,
          task.repeat_daily ? 'scheduled' : 'expired', task.id);
        continue;
      }
      const binding = this.store.wechatBinding(task.user_id);
      const context = binding && this.store.latestWechatContext(binding.id);
      if (!binding || binding.status !== 'connected' || !context) {
        this.store.db.prepare("UPDATE reminders SET status='waiting_for_wechat' WHERE id=?").run(task.id); continue;
      }
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const messageId = `reminder:${task.id}:${task.next_at}`;
        const exists = this.store.db.prepare('SELECT id FROM wechat_inbox WHERE bot_id=? AND message_id=?').get(binding.bot_id, messageId);
        if (!exists) {
          const run = this.store.createRun(task.user_id, binding.conversation_id, '定时提醒：' + task.text);
          this.store.runStatus(run.id, 'completed', task.text);
          this.store.trace(run.id, 'reminder', { taskId: task.id, scheduledAt: task.next_at, text: task.text });
          this.store.db.prepare('INSERT INTO wechat_inbox VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), binding.id,
            binding.bot_id, messageId, task.user_id, context, run.id, 'pending');
        }
        const next = task.repeat_daily ? nextReminderAt(task.next_at, now, weekdaysOnly) : task.next_at;
        this.store.db.prepare('UPDATE reminders SET next_at=?,status=? WHERE id=?').run(next, task.repeat_daily ? 'scheduled' : 'completed', task.id);
        this.store.db.exec('COMMIT'); delivered++;
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    if (delivered) this.onDue();
  }
  start() {
    this.tick();
    this.timer = setInterval(() => { this.tick(); }, 1000); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  tools(userId) { return { list: () => this.list(userId), create: value => this.create(userId, value), remove: id => this.remove(userId, id) }; }
}
