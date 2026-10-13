import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { systemPrompt } from './engine.mjs';

export class PiEngine {
  mode = 'pi';
  constructor(config) { this.config = config; }
  async initialize() {
    const specifier = this.config.sdkModule;
    this.sdk = await import(specifier.startsWith('/') ? pathToFileURL(specifier).href : specifier);
    const require = createRequire(specifier.startsWith('/') ? specifier : import.meta.url);
    this.Type = (await import(pathToFileURL(require.resolve('typebox')).href)).Type;
  }
  async run(ctx, prompt) {
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = this.sdk;
    const root = join(ctx.directory, 'tenants', ctx.userId);
    const workspace = join(root, 'workspace'), sessions = join(root, 'sessions'), agentDir = join(root, 'agent');
    for (const directory of [workspace, sessions, agentDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'),
      modelsPath: this.config.modelsPath, modelsStorePath: join(agentDir, 'catalog.json'),
      allowModelNetwork: false, refreshOnCreate: false });
    await runtime.setRuntimeApiKey(this.config.provider, this.config.apiKey);
    const model = runtime.getModel(this.config.provider, this.config.model);
    if (!model) throw new Error('Configured model unavailable');
    const manager = ctx.conversation.sdk_file
      ? SessionManager.open(this.checkedFile(ctx.conversation.sdk_file, sessions), sessions, workspace)
      : SessionManager.create(workspace, sessions);
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt(ctx.memory(), ctx.agentProfile?.()), getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources() {}, async reload() {},
    };
    const Type = this.Type;
    const result = text => ({ content: [{ type: 'text', text }], details: {} });
    const customTools = [
      { name: 'memory_read', label: 'Memory Read', description: 'Read only the authenticated user’s persistent memory.',
        parameters: Type.Object({}), async execute() { return result(ctx.memory()); } },
      { name: 'memory_write', label: 'Memory Write', description: 'Replace the authenticated user’s memory; preserve existing relevant facts.',
        parameters: Type.Object({ content: Type.String({ maxLength: 8000 }) }),
        async execute(_id, { content }) { ctx.writeMemory(content); return result('Memory saved'); } },
    ];
    customTools.push(
      { name: 'persona_read', label: 'Read Persona', description: 'Read only this user’s 人物设定 (assistant personality and preferences).',
        parameters: Type.Object({}), async execute() { return result(ctx.agentProfile()); } },
      { name: 'persona_write', label: 'Save Persona', description: 'Only when the user explicitly requests changing 人物设定. Read the existing setting first; preserve unrelated preferences. Cannot change permissions.',
        parameters: Type.Object({ content: Type.String({ maxLength: 8000 }) }),
        async execute(_id, { content }) { ctx.writeAgentProfile(content); return result('人物设定已保存，后续对话生效。'); } },
    );
    if (ctx.notes) customTools.push(
      { name: 'note_read', label: 'Note Read', description: 'Read a Markdown page from this user’s SilverBullet space. Never accepts another space URL.',
        parameters: Type.Object({ page: Type.String({ maxLength: 120 }) }),
        async execute(_id, { page }) { return result(JSON.stringify(await ctx.notes.read(page, ctx.signal))); } },
      { name: 'note_write', label: 'Note Write', description: 'Write only when the user explicitly asks. For an existing page, first read it and provide its etag; without etag this is create-only.',
        parameters: Type.Object({ page: Type.String({ maxLength: 120 }), content: Type.String({ maxLength: 30000 }), etag: Type.Optional(Type.String()) }),
        async execute(_id, { page, content, etag }) { return result(JSON.stringify(await ctx.notes.write(page, content, etag, ctx.signal))); } },
    );
    if (ctx.reminders) customTools.push(
      { name: 'reminder_create', label: 'Create Reminder', description: 'Only when the user asks: schedule a text reminder for this user. at must be a future ISO timestamp with timezone; daily repeats every 24h. WeChat needs the user to send at least one message first.',
        parameters: Type.Object({ text: Type.String({ maxLength: 2000 }), at: Type.String(), daily: Type.Optional(Type.Boolean()) }),
        async execute(_id, value) { return result(JSON.stringify(ctx.reminders.create(value))); } },
      { name: 'reminder_list', label: 'List Reminders', description: 'List only this user’s reminders.', parameters: Type.Object({}),
        async execute() { return result(JSON.stringify(ctx.reminders.list())); } },
      { name: 'reminder_cancel', label: 'Cancel Reminder', description: 'Cancel this user’s reminder when requested.', parameters: Type.Object({ id: Type.String() }),
        async execute(_id, { id }) { return result(JSON.stringify(ctx.reminders.remove(id))); } },
    );
    if (this.config.searchKey) customTools.push({
      name: 'web_search', label: 'Web Search', description: 'Search public webpages through MiniMax Coding Plan. Send a search query only.',
      parameters: Type.Object({ query: Type.String({ maxLength: 500 }) }),
      execute: async (_id, { query }) => {
        const response = await fetch('https://api.minimaxi.com/v1/coding_plan/search', {
          method: 'POST', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]),
          headers: { Authorization: `Bearer ${this.config.searchKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query }),
        });
        if (!response.ok) throw new Error('Search unavailable');
        const data = await response.json();
        if (data.base_resp?.status_code !== 0) throw new Error('Search failed');
        return result(JSON.stringify(data));
      },
    });
    if (ctx.personaDraft) customTools.splice(0, customTools.length, ...customTools.filter(tool => tool.name === 'persona_read'));
    const { session } = await createAgentSession({ cwd: workspace, agentDir, model, modelRuntime: runtime,
      thinkingLevel: this.config.thinkingLevel, resourceLoader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } }),
      tools: customTools.map(t => t.name), customTools,
    });
    const abort = () => { void session.abort(); };
    const unsubscribe = session.subscribe(event => {
      if (['message_end', 'tool_execution_start', 'tool_execution_end', 'auto_compaction_end'].includes(event.type)) {
        ctx.emit('sdk_event', this.sanitize(event));
      }
    });
    ctx.emit('context', { system: session.systemPrompt, activeTools: session.getActiveToolNames(),
      provider: this.config.provider, model: this.config.model });
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      ctx.signal.throwIfAborted();
      await session.prompt(prompt);
      const assistant = session.messages.findLast(message => message.role === 'assistant');
      if (assistant?.errorMessage || assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') {
        throw new Error('Model failed');
      }
      const text = session.getLastAssistantText();
      if (!text) throw new Error('Empty model response');
      return text;
    } finally {
      if (manager.getSessionFile()) ctx.setSdkFile(manager.getSessionFile());
      ctx.signal.removeEventListener('abort', abort); unsubscribe(); session.dispose();
    }
  }
  checkedFile(file, directory) {
    const actual = realpathSync(resolve(file));
    if (!actual.startsWith(realpathSync(directory) + sep)) throw new Error('Session path outside tenant');
    return actual;
  }
  sanitize(value) {
    let json = JSON.stringify(value);
    for (const key of [this.config.apiKey, this.config.searchKey]) {
      if (key) json = json.split(key).join('[REDACTED]');
    }
    return json.length > 100000 ? { truncated: true, preview: json.slice(0, 100000) } : JSON.parse(json);
  }
}
