import { systemPrompt } from './engine.mjs';
import { EventEmitter } from 'node:events';

export class RunQueue extends EventEmitter {
  constructor(store, engine, { timeoutMs = 120000, contextFactory = () => ({}), beforeRun = async () => {} } = {}) {
    super();
    this.store = store; this.engine = engine; this.timeoutMs = timeoutMs;
    this.contextFactory = contextFactory; this.beforeRun = beforeRun;
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
      const personaDraft = this.store.runMode(run.id) === 'persona_draft';
      const context = {
        personaDraft,
        ...(personaDraft ? {} : this.contextFactory(run.user_id, run)),
        userId: run.user_id, conversation: this.store.conversation(run.user_id, run.conversation_id),
        directory: this.store.directory, signal: controller.signal, emit,
        history: this.store.messages(run.user_id, run.conversation_id),
        memory: () => personaDraft ? '' : this.store.memory(run.user_id),
        agentProfile: () => this.store.agentProfile(run.user_id),
        writeAgentProfile: text => {
          if (personaDraft) throw new Error('Draft cannot change settings');
          this.store.setAgentProfile(run.user_id, text);
        },
        writeMemory: text => {
          if (personaDraft) throw new Error('Draft cannot change memory');
          if (typeof text !== 'string' || text.length > 8000) throw new Error('Memory is too large');
          this.store.writeMemory(run.user_id, text);
        },
        setSdkFile: file => this.store.setSdkFile(run.user_id, run.conversation_id, file),
      };
      try {
        await this.beforeRun(run, controller.signal);
        if (controller.signal.aborted) throw new Error('Run aborted');
        emit('prompt', { mode: this.engine.mode || 'mock',
          system: systemPrompt(context.memory(), context.agentProfile()), input: run.prompt });
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
        this.emit('settled', run.id);
      }
    }
  }
  async close() {
    this.closed = true; this.active?.abort();
    await this.work;
  }
}
