// Real SB HTTP and rg, synthetic users in a disposable slim container only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { SilverBullet } from '../src/silverbullet.mjs';

const output = resolve(process.argv[2] || '/tmp/pi-note-rg-search-result.json');
const image = 'ghcr.io/silverbulletmd/silverbullet:2.12.0-slim';
const container = 'pi-search-verify-' + randomBytes(6).toString('hex');
const directory = mkdtempSync(join(tmpdir(), 'pi-search-fixture-')), store = new Store(directory);
const report = { method: 'scoped SB HTTP + rg stdin', productionTouched: false, browser: false,
  vectorDatabase: false, modelCalls: 0, checks: [], timingsMs: {}, startedAt: new Date().toISOString(), image };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
let sb, created = false;

// Transport is bound to one authenticated space; query is literal stdin search data.
async function searchNotes(tools, list, query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\r\n\0]/.test(query)) throw new Error('invalid_search_query');
  const candidates = (await list()).filter(f => f.name.endsWith('.md') && !f.name.startsWith('Library/') && f.name !== 'CONFIG.md');
  const lines = [], locations = []; let bytes = 0, scannedPages = 0, limited = candidates.length > 200;
  for (const file of candidates.slice(0, 200)) {
    const page = file.name.slice(0, -3), note = await tools.read(page), size = Buffer.byteLength(note.content);
    if (bytes + size > 2_000_000) { limited = true; break; }
    bytes += size; scannedPages++; lines.push(page); locations.push({ page, line: 0 });
    for (const [index, text] of note.content.split(/\r?\n/).entries()) { lines.push(text); locations.push({ page, line: index + 1 }); }
  }
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('rg', ['--json', '--fixed-strings', '--ignore-case', '--text', '--max-count', '30', '--', query, '-'],
      { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const chunks = []; let size = 0, exceeded = false;
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4_000_000) { exceeded = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (exceeded || signal || ![0, 1].includes(code)) reject(new Error('rg_search_failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(lines.join('\n') + '\n');
  });
  const matches = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'match');
  const hits = matches.map(({ data }) => {
    const location = locations[data.line_number - 1], text = data.lines.text.trimEnd();
    const offset = Buffer.from(text).subarray(0, data.submatches[0].start).toString('utf8').length;
    return { ...location, excerpt: text.slice(Math.max(0, offset - 100), offset + 300) };
  });
  return { hits: hits.slice(0, 20), scannedPages, scannedBytes: bytes, limited: limited || matches.length >= 20 };
}

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
  const list = state => async () => { const response = await request(state, '/.fs'); assert.equal(response.status, 200); return response.json(); };
  const search = (index, query) => searchNotes(tools[index], list(states[index]), query);
  const content = '# 周末安排\n这周六下午去游泳，记得带泳镜和毛巾。\nDeployment healthcheck passed.\noldopalqrx\n字面量 .* 和 --files 也是笔记内容。\n';
  await tools[0].write('验收/运动安排', content);
  await tools[1].write('验收/运动安排', '# 合成私有笔记\nbobsecretvkn483\n');
  for (let i = 0; i < 100; i++) await tools[0].write('验收/普通笔记' + i, '# 合成笔记\n' + '天气晴朗，午后阅读和散步。\n'.repeat(30));
  report.fixtureUserNotes = 102;
  const measure = async (key, fn) => { const start = performance.now(), result = await fn(); report.timingsMs[key] = Math.round(performance.now() - start); return result; };
  for (const [label, query] of [['chineseBody', '游泳'], ['chineseCompound', '泳镜'], ['englishBody', 'HEALTHCHECK'], ['pageTitle', '运动安排'], ['literalRegex', '.*'], ['optionLikeQuery', '--files']]) {
    const result = await measure(label, () => search(0, query));
    assert.ok(result.hits.some(hit => hit.page === '验收/运动安排'), label + ' must match');
    assert.equal(result.limited, false); report.scannedPages = result.scannedPages; report.scannedBytes = result.scannedBytes; report.checks.push(label);
  }
  assert.equal((await search(0, 'quasarzznvxtp731')).hits.length, 0); report.checks.push('noMatch');
  const old = await tools[0].read('验收/运动安排');
  await tools[0].write('验收/运动安排', content.replace('oldopalqrx', 'newamberjtz'), old.etag);
  assert.ok((await measure('immediateUpdate', () => search(0, 'newamberjtz'))).hits.length);
  assert.equal((await search(0, 'oldopalqrx')).hits.length, 0); report.checks.push('immediateUpdate');
  const updated = await tools[0].read('验收/运动安排'); await tools[0].remove('验收/运动安排', updated.etag, true, 'synthetic_search_verification');
  assert.equal((await measure('immediateDelete', () => search(0, 'newamberjtz'))).hits.length, 0); report.checks.push('immediateDelete');
  assert.equal((await search(0, 'bobsecretvkn483')).hits.length, 0); assert.ok((await search(1, 'bobsecretvkn483')).hits.length); report.checks.push('separateSearchResults');
  for (const path of ['/.fs', '/.fs/' + encodeURIComponent('验收') + '/' + encodeURIComponent('运动安排.md')]) {
    const response = await fetch(baseUrl + states[1].prefix + path, { headers: { Authorization: 'Bearer ' + states[0].token } }); assert.ok([401, 403].includes(response.status));
  }
  report.checks.push('crossTenantListAndReadDenied');
  assert.equal((await sb.admin('runtimes')).length, 0); report.checks.push('noBrowserRuntimes');
  const bounded = await search(0, '合成笔记'); assert.equal(bounded.hits.length, 20); assert.equal(bounded.limited, true); report.checks.push('boundedResults');
  await assert.rejects(search(0, '\n'), /invalid_search_query/); report.checks.push('invalidQueryRejected');
  report.memory = { silverbullet: JSON.parse(docker('stats', '--no-stream', '--format', '{{json .}}', container)),
    verifier: process.memoryUsage(), events: docker('exec', container, 'cat', '/sys/fs/cgroup/memory.events') };
  report.success = true;
} catch (error) {
  report.success = false; report.failure = error.message; process.exitCode = 1;
  if (created) report.fixtureLogs = docker('logs', '--tail', '30', container);
} finally {
  await sb?.close(); store.close();
  if (created) { docker('rm', '-f', container); report.fixtureContainerRemoved = true; }
  rmSync(directory, { recursive: true, force: true }); report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ success: report.success, checks: report.checks, timingsMs: report.timingsMs,
    failure: report.failure, report: output, fixtureContainerRemoved: report.fixtureContainerRemoved }));
}
