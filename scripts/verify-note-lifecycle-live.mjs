// Synthetic users and notes only. Real SB transport; optional real model, no WeChat sends.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';
import { PiEngine } from '../src/pi-engine.mjs';
import { RunQueue } from '../src/queue.mjs';

const directory = mkdtempSync(join(tmpdir(), 'pi-note-lifecycle-')), store = new Store(directory);
const sb = new SilverBullet(store, JSON.parse(readFileSync('/home/admin/.config/pi-agent-multi-tenant/silverbullet.json', 'utf8')));
const users = [], report = { wechatMessagesSent: 0, realUserNotesTouched: false };
let queue;
try {
  const alice = store.createUser('verify_notes_a_' + Date.now(), 'fixture'), bob = store.createUser('verify_notes_b_' + Date.now(), 'fixture');
  users.push(alice, bob);
  await sb.provision(alice); await sb.provision(bob);
  const a = sb.tools(alice.id), b = sb.tools(bob.id), page = '验收/删除工具测试';
  const text = '---\ntags: fixture\n---\n# 合成笔记\nFAKE_UNICODE_ORIGINAL\n';
  await a.write(page, text); await b.write(page, 'BOB_MUST_REMAIN');
  const original = await a.read(page);
  await assert.rejects(sb.file(alice.id, page, { method: 'DELETE', etag: '"stale"' }), /note_conflict/);
  assert.equal((await a.read(page)).content, text);
  const moved = await a.archive(page, original.etag, 'synthetic_acceptance');
  await assert.rejects(a.read(page), /note_not_found/);
  let archived = await a.read(moved.archivedPage); assert.equal(archived.content, text);
  await assert.rejects(b.restore(moved.archivedPage, archived.etag), /note_not_found/);
  await a.write(page, 'NEW_CONTENT_MUST_REMAIN');
  await assert.rejects(a.restore(moved.archivedPage, archived.etag), /note_conflict/);
  let current = await a.read(page);
  await assert.rejects(a.remove(page, current.etag, false), /note_delete_requires_confirmation/);
  await a.remove(page, current.etag, true);
  await a.restore(moved.archivedPage, archived.etag);
  assert.equal((await a.read(page)).content, text);
  await assert.rejects(a.read(moved.archivedPage), /note_not_found/);
  const next = await a.archive(page, (await a.read(page)).etag);
  assert.notEqual(moved.archivedPage, next.archivedPage);
  archived = await a.read(next.archivedPage); await a.restore(next.archivedPage, archived.etag);
  current = await a.read(page); await a.remove(page, current.etag, true);
  await assert.rejects(a.read(page), /note_not_found/);
  assert.equal((await b.read(page)).content, 'BOB_MUST_REMAIN');
  const owner = store.integration(alice.id, 'silverbullet').state, other = store.integration(bob.id, 'silverbullet').state;
  const cross = await fetch(sb.base + other.prefix + '/.fs/' + encodeURI(page) + '.md', { headers: { Authorization: 'Bearer ' + owner.token } });
  assert.ok([401, 403, 404].includes(cross.status));
  report.realSbConditionalDelete = true; report.archiveRestoreDelete = true;
  report.repeatedArchivesUnique = true; report.noOverwrite = true; report.crossTenantDenied = true;
  if (process.argv.includes('--model')) {
    const engine = new PiEngine({ sdkModule: process.env.PI_SDK_MODULE || resolve('sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
      modelsPath: resolve('models.json'), provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY });
    await engine.initialize();
    queue = new RunQueue(store, engine, { contextFactory: userId => ({ notes: sb.tools(userId) }) });
    const conversation = store.createConversation(alice.id, '合成笔记删除验收');
    async function run(prompt, expectedTool) {
      const job = store.createRun(alice.id, conversation.id, prompt);
      const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled;
      assert.equal(store.run(alice.id, job.id).status, 'completed', store.run(alice.id, job.id).error);
      const tools = store.traces(alice.id, job.id).filter(e => e.kind === 'sdk_event' && e.payload.type === 'tool_execution_start');
      assert.ok(tools.some(e => e.payload.toolName === expectedTool), 'Model did not call ' + expectedTool);
      assert.ok(tools.findIndex(e => e.payload.toolName === 'note_read') < tools.findIndex(e => e.payload.toolName === expectedTool));
      return tools;
    }
    await a.write(page, text);
    await run(`请删除我的“${page}”这篇笔记，按默认的可恢复归档处理，请实际执行。`, 'note_archive');
    await assert.rejects(a.read(page), /note_not_found/);
    const audit = readFileSync(join(directory, 'tenants', alice.id, 'notes', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const target = audit.findLast(e => e.action === 'archive').target;
    await run(`请恢复刚才归档的笔记，归档路径是“${target}”，实际恢复到原来的位置。`, 'note_restore');
    assert.equal((await a.read(page)).content, text);
    const deletion = await run(`我确认永久删除“${page}”这篇测试笔记。请先读取当前内容和版本，再实际永久删除，其他笔记保持。`, 'note_delete');
    assert.equal(deletion.find(e => e.payload.toolName === 'note_delete').payload.args.confirm, true);
    await assert.rejects(a.read(page), /note_not_found/);
    assert.equal((await b.read(page)).content, 'BOB_MUST_REMAIN');
    report.actualModelArchiveRestoreDelete = true;
  }
  console.log(JSON.stringify(report));
} finally {
  if (queue) await queue.close();
  for (const user of users) await sb.archiveUser(user);
  await sb.close(); store.close(); rmSync(directory, { recursive: true, force: true });
}
