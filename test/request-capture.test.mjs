import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { requestCaptureExtensions } from '../src/request-capture.mjs';

test('operator capture is scoped, three turns only, first request only, redacted and nonmutating', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'multi-capture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = { directory, userId: 'synthetic-user' };
  assert.deepEqual(requestCaptureExtensions(ctx), []);
  const folder = join(directory, 'context-capture'); mkdirSync(folder);
  writeFileSync(join(folder, 'arming.json'), JSON.stringify({ userId: ctx.userId, expiresAt: Date.now() + 60000 }));
  writeFileSync(join(folder, 'status.json'), JSON.stringify({ armed: true, remaining: 3, captures: [] }));
  assert.deepEqual(requestCaptureExtensions({ ...ctx, userId: 'other-user' }), []);
  assert.deepEqual(requestCaptureExtensions({ ...ctx, personaDraft: true }), []);
  const payload = { system: [{ text: 'synthetic-key-12345' }], messages: [{ role: 'user', content: 'fixture' }], tools: [] };
  const original = JSON.stringify(payload);
  for (let turn = 1; turn <= 3; turn++) {
    const ext = requestCaptureExtensions(ctx, 'synthetic-key-12345')[0];
    const handler = ext.handlers.get('before_provider_request')[0];
    assert.equal(await handler({ payload }), undefined);
    await handler({ payload });
    const status = JSON.parse(readFileSync(join(folder, 'status.json')));
    assert.equal(status.captures.length, turn);
    assert.equal(status.remaining, 3 - turn);
  }
  assert.deepEqual(requestCaptureExtensions(ctx), []);
  assert.equal(JSON.stringify(payload), original);
  const saved = JSON.parse(gunzipSync(readFileSync(join(folder, 'request-1.json.gz'))));
  assert.equal(saved.payload.system[0].text, '[REDACTED]');
  assert.deepEqual(saved.payload.messages, payload.messages);
});
