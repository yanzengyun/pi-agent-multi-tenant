import { systemPrompt } from './engine.mjs';

export class RunQueue {
  constructor(store, engine, { timeoutMs = 120000 } = {}) {
    this.store = store; this.engine = engine; this.timeoutMs = timeoutMs;
    this.closed = false; this.active = null; this.work = null;
    store.recover();
    this.kick();
  }
  kick() {
    if (this.closed || this.work) return;
    this.work = this.drain().finally(() => {
      this.work = null;
      if (!this.closed && this.store.pending().length) this.kick();
    });
  }
  async drain() {
    for (;;) {
      if (this.closed) return;
      const run = this.store.pending()[0];
      if (!run) return;
      this.store.runStatus(run.id, 'running');
      const controller = new AbortController(); this.active = controller;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let eventCount = 0;
      const emit = (kind, payload) => {
        if (eventCount++ < 500) this.store.trace(run.id, kind, payload);
      };
      const context = {
        userId: run.user_id, conversation: this.store.conversation(run.user_id, run.conversation_id),
        directory: this.store.directory, signal: controller.signal, emit,
        history: this.store.messages(run.user_id, run.conversation_id),
        memory: () => this.store.memory(run.user_id),
        writeMemory: text => {
          if (typeof text !== 'string' || text.length > 8000) throw new Error('Memory is too large');
          this.store.writeMemory(run.user_id, text);
        },
        setSdkFile: file => this.store.setSdkFile(run.user_id, run.conversation_id, file),
      };
      try {
        emit('prompt', { mode: this.engine.mode || 'mock',
          system: systemPrompt(context.memory()), input: run.prompt });
        this.store.message(run.user_id, run.conversation_id, 'user', run.prompt);
        const response = await this.engine.run(context, run.prompt);
        if (controller.signal.aborted) throw new Error('Run aborted');
        this.store.message(run.user_id, run.conversation_id, 'assistant', response);
        this.store.runStatus(run.id, 'completed', response);
        emit('completed', { response });
      } catch (failure) {
        const error = controller.signal.aborted ? 'run_aborted' : 'engine_failed';
        this.store.runStatus(run.id, 'failed', null, error);
        emit('failed', { error, ...(this.engine.sanitize ? { diagnostic: this.engine.sanitize({ message: failure.message }) } : {}) });
      } finally {
        clearTimeout(timer); this.active = null;
      }
    }
  }
  async close() {
    this.closed = true; this.active?.abort();
    await this.work;
  }
}
