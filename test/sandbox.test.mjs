import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../src/sandbox.mjs';

test('command transport fixes the authenticated identity and never falls back on broker failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sandbox-client-')), socket = join(directory, 'runner.sock'), seen = [];
  let offline = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); seen.push(body);
    res.writeHead(offline ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(offline ? { error: 'sandbox_unavailable' } : { stdout: body.command === 'binary' ? '\0'.repeat(32768) : 'FAKE', exitCode: 0 }));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const tools = new Sandbox(socket).tools('11111111-1111-4111-8111-111111111111');
  assert.equal((await tools.execute('printf FAKE')).stdout, 'FAKE');
  assert.equal(seen[0].userId, '11111111-1111-4111-8111-111111111111');
  assert.match(seen[0].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['command','requestId','userId']);
  assert.equal((await tools.execute('binary')).stdout.length, 32768);
  offline = true;
  await assert.rejects(tools.execute('anything'), /sandbox_unavailable/);
  await assert.rejects(tools.execute(''), /invalid_sandbox_command/);
});

test('aborting a command sends a cancellation scoped to its identity and request', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sandbox-cancel-')), socket = join(directory, 'runner.sock');
  const controller = new AbortController(); let command;
  let finish; const cancelled = new Promise(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/execute') { command = body; controller.abort(); }
    else { assert.equal(body.requestId, command.requestId); assert.equal(body.userId, command.userId); finish(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(new Sandbox(socket).tools('11111111-1111-4111-8111-111111111111').execute('sleep 30', controller.signal));
  await cancelled;
});
