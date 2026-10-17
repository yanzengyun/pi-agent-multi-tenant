import test from 'node:test';
import assert from 'node:assert/strict';
import { tenantResourceLoader, sqliteMemoryText } from '../src/tenant-resources.mjs';

test('native prompt builder is enabled, only own AGENTS context is exposed, and memory is extension-injected', async () => {
  let memory = 'ALICE_MEMORY';
  const ctx = { directory: '/nonexistent-fixture', userId: 'alice', agentProfile: () => 'ALICE_STYLE', memory: () => memory };
  const loader = tenantResourceLoader(ctx, '/fixture/alice/workspace', '/fixture/alice/agent', () => ({}), 'fake');
  assert.equal(loader.getSystemPrompt(), undefined);
  const files = loader.getAgentsFiles().agentsFiles;
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.path.startsWith('/fixture/alice/')));
  assert.equal(files[1].content, 'ALICE_STYLE');
  assert.ok(!JSON.stringify(files).includes('ALICE_MEMORY'));
  const ext = loader.getExtensions().extensions[0];
  const hook = ext.handlers.get('before_agent_start')[0];
  const first = await hook({ systemPrompt: 'NATIVE_BASE' });
  assert.ok(first.systemPrompt.startsWith('NATIVE_BASE'));
  assert.match(first.systemPrompt, /ALICE_MEMORY/);
  assert.equal((await hook({ systemPrompt: 'NATIVE_BASE' })).systemPrompt, first.systemPrompt);
  memory = 'ALICE_UPDATED';
  const next = await hook({ systemPrompt: 'NATIVE_BASE' });
  assert.match(next.systemPrompt, /ALICE_UPDATED/);
  assert.doesNotMatch(next.systemPrompt, /ALICE_MEMORY/);
  assert.equal(sqliteMemoryText(memory), sqliteMemoryText(memory));
});
