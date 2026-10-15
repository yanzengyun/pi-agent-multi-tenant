// Real SB HTTP and rg, synthetic users in a disposable slim container only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';
import { PiEngine } from '../src/pi-engine.mjs';
import { RunQueue } from '../src/queue.mjs';

const output = resolve(process.argv[2] || '/tmp/pi-note-rg-search-result.json');
const image = 'ghcr.io/silverbulletmd/silverbullet:2.12.0-slim';
const container = 'pi-search-verify-' + randomBytes(6).toString('hex');
const directory = mkdtempSync(join(tmpdir(), 'pi-search-fixture-')), store = new Store(directory);
const report = { method: 'scoped SB HTTP + rg stdin', productionTouched: false, browser: false,
  vectorDatabase: false, modelCalls: 0, checks: [], timingsMs: {}, startedAt: new Date().toISOString(), image };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
let sb, queue, created = false;


try {
  report.rgVersion = execFileSync('rg', ['--version'], { encoding: 'utf8' }).split('\n')[0];
  report.imageId = docker('image', 'inspect', image, '--format', '{{.Id}}');
  docker('create', '--name', container, '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.5',
    '-p', '127.0.0.1::3000', '-e', 'SB_HOSTNAME=0.0.0.0', '-e', 'SB_RUNTIME_API=0', '-e', 'SB_SHELL_BACKEND=none', image);
  created = true; docker('start', container);
  const baseUrl = 'http://127.0.0.1:' + docker('port', container, '3000/tcp').split(':').at(-1);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(baseUrl + '/.instance')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'fixture server must start');
  const password = randomBytes(24).toString('base64url');
  const setup = await fetch(baseUrl + '/.setup/api/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primaryUrl: baseUrl, adminUsername: 'fixture_admin', adminPassword: password,
      space: { name: 'Fixture bootstrap', prefix: '/bootstrap', folder: 'spaces/bootstrap', revisions: 'disabled' } }) });
  assert.equal(setup.status, 200);
  sb = new SilverBullet(store, { baseUrl, username: 'fixture_admin', password });
  const people = [store.createUser('fixture_alice', 'fixture'), store.createUser('fixture_bob', 'fixture')], states = [];
  for (const user of people) { await sb.provision(user); states.push(store.integration(user.id, 'silverbullet').state); }
  const request = (state, path, options = {}) => fetch(baseUrl + state.prefix + path, {
    ...options, headers: { Authorization: 'Bearer ' + state.token, ...options.headers }, signal: AbortSignal.timeout(15000) });
  const tools = people.map(person => sb.tools(person.id));
  const search = (index, query) => tools[index].search({ query });
  const content = '# 周末安排\n这周六下午去游泳，记得带泳镜和毛巾。\nDeployment healthcheck passed.\noldopalqrx\n字面量 .* 和 --files 也是笔记内容。\n';
  await tools[0].write('验收/运动安排', content);
  await tools[1].write('验收/运动安排', '# 合成私有笔记\nbobsecretvkn483\n');
  for (let i = 0; i < 100; i++) await tools[0].write('验收/普通笔记' + i, '# 合成笔记\n' + '天气晴朗，午后阅读和散步。\n'.repeat(30));
  report.fixtureUserNotes = 102;
  const measure = async (key, fn) => { const start = performance.now(), result = await fn(); report.timingsMs[key] = Math.round(performance.now() - start); return result; };
  for (const [label, query] of [['chineseBody', '游泳'], ['chineseCompound', '泳镜'], ['englishBody', 'HEALTHCHECK'], ['pageTitle', '运动安排'], ['literalRegex', '.*'], ['optionLikeQuery', '--files']]) {
    const result = await measure(label, () => search(0, query));
    assert.ok(result.items.some(hit => hit.page === '验收/运动安排'), label + ' must match');
    assert.equal(result.incomplete, false); report.scannedPages = result.scannedPages; report.scannedBytes = result.scannedBytes; report.checks.push(label);
  }
  assert.equal((await search(0, 'quasarzznvxtp731')).items.length, 0); report.checks.push('noMatch');
  const first = await tools[0].list({ prefix: '验收', limit: 1 });
  const second = await tools[0].list({ prefix: '验收', limit: 1, offset: first.nextOffset });
  assert.equal(first.total, 101); assert.notEqual(first.items[0].page, second.items[0].page);
  assert.ok(first.items.every(item => !('content' in item) && item.url)); report.checks.push('metadataAndPagination');
  await tools[0].write('归档/验收旧笔记', 'oldarchivekqr11');
  assert.equal((await search(0, 'oldarchivekqr11')).items.length, 0);
  assert.equal((await tools[0].search({ query: 'oldarchivekqr11', includeArchived: true })).items.length, 1);
  report.checks.push('explicitArchiveSearch');
  if (process.argv.includes('--model')) {
    const engine = new PiEngine({ sdkModule: process.env.PI_SDK_MODULE || resolve('sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
      modelsPath: process.env.PI_MODELS_PATH || resolve('models.json'), provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', thinkingLevel: 'medium', apiKey: process.env.MINIMAX_CN_API_KEY });
    await engine.initialize();
    queue = new RunQueue(store, engine, { contextFactory: userId => ({ notes: sb.tools(userId) }) });
    const conversation = store.createConversation(people[0].id, '合成笔记检索验收');
    for (const [prompt, expected] of [
      ['请用笔记列表工具列出我验收目录的前3篇笔记，再告诉我这个目录总共有几篇，只需列标题。', ['note_list']],
      ['请搜索我笔记中关于游泳的记录，读取找到的原文，告诉我安排在周几、需要带什么，并提供笔记链接。', ['note_search', 'note_read']],
    ]) {
      const run = store.createRun(people[0].id, conversation.id, prompt);
      const settled = new Promise(resolve => queue.once('settled', resolve)); queue.kick(); await settled; report.modelCalls++;
      const finished = store.run(people[0].id, run.id);
      if (finished.error === 'model_quota_exhausted') { report.modelVerification = 'quota_exhausted'; break; }
      assert.equal(finished.status, 'completed', finished.error);
      const events = store.traces(people[0].id, run.id);
      const called = events.filter(e => e.kind === 'sdk_event' && e.payload.type === 'tool_execution_start').map(e => e.payload.toolName);
      for (const name of expected) assert.ok(called.includes(name), 'Model did not call ' + name);
      if (expected.includes('note_read')) { assert.match(finished.response, /周六|星期六/); assert.ok(called.indexOf('note_search') < called.indexOf('note_read')); }
      report.checks.push('actualModel:' + expected.join(',')); report.modelVerification = 'passed';
    }
  }
  const old = await tools[0].read('验收/运动安排');
  await tools[0].write('验收/运动安排', content.replace('oldopalqrx', 'newamberjtz'), old.etag);
  assert.ok((await measure('immediateUpdate', () => search(0, 'newamberjtz'))).items.length);
  assert.equal((await search(0, 'oldopalqrx')).items.length, 0); report.checks.push('immediateUpdate');
  const updated = await tools[0].read('验收/运动安排'); await tools[0].remove('验收/运动安排', updated.etag, true, 'synthetic_search_verification');
  assert.equal((await measure('immediateDelete', () => search(0, 'newamberjtz'))).items.length, 0); report.checks.push('immediateDelete');
  assert.equal((await search(0, 'bobsecretvkn483')).items.length, 0); assert.ok((await search(1, 'bobsecretvkn483')).items.length); report.checks.push('separateSearchResults');
  for (const path of ['/.fs', '/.fs/' + encodeURIComponent('验收') + '/' + encodeURIComponent('运动安排.md')]) {
    const response = await fetch(baseUrl + states[1].prefix + path, { headers: { Authorization: 'Bearer ' + states[0].token } }); assert.ok([401, 403].includes(response.status));
  }
  report.checks.push('crossTenantListAndReadDenied');
  assert.equal((await sb.admin('runtimes')).length, 0); report.checks.push('noBrowserRuntimes');
  const bounded = await search(0, '合成笔记'); assert.ok(bounded.items.length > 0 && bounded.items.length <= 20); assert.equal(bounded.incomplete, true); report.checks.push('boundedResults');
  await assert.rejects(search(0, '\n'), /invalid_note_query/); report.checks.push('invalidQueryRejected');
  report.memory = { silverbullet: JSON.parse(docker('stats', '--no-stream', '--format', '{{json .}}', container)),
    verifier: process.memoryUsage(), events: docker('exec', container, 'sh', '-c',
      'if [ -r /sys/fs/cgroup/memory.events ]; then cat /sys/fs/cgroup/memory.events; elif [ -r /sys/fs/cgroup/memory/memory.failcnt ]; then cat /sys/fs/cgroup/memory/memory.failcnt; else echo unavailable; fi') };
  report.success = true;
} catch (error) {
  report.success = false; report.failure = error.message; process.exitCode = 1;
  if (created) report.fixtureLogs = docker('logs', '--tail', '30', container);
} finally {
  await queue?.close(); await sb?.close(); store.close();
  if (created) { docker('rm', '-f', container); report.fixtureContainerRemoved = true; }
  rmSync(directory, { recursive: true, force: true }); report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ success: report.success, checks: report.checks, timingsMs: report.timingsMs,
    failure: report.failure, report: output, fixtureContainerRemoved: report.fixtureContainerRemoved }));
}
