// Deterministic transport for isolation tests, never presented as a real model.
export class MockEngine {
  async run(context, prompt) {
    context.emit('engine', { mode: 'mock' });
    if (prompt.startsWith('remember:')) {
      context.writeMemory(prompt.slice(9).trim());
      context.emit('tool', { name: 'memory_write' });
      return 'Memory saved';
    }
    if (prompt === 'recall') {
      context.emit('tool', { name: 'memory_read' });
      return context.memory();
    }
    if (prompt === 'history') return context.history.map(m => m.content).join('\n');
    return `MOCK: ${prompt}`;
  }
}
