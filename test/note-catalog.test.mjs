import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteCatalog } from '../src/note-catalog.mjs';

function fixture() {
  const pages = new Map([
    ['生活/运动.md', '周六下午去游泳，带泳镜。\nLiteral .* and --files\noldopalqrx'],
    ['生活/阅读.md', 'Deployment HEALTHCHECK passed.'],
    ['归档/旧事.md', '归档的游泳安排'], ['Library/教程.md', '内部游泳示例'], ['CONFIG.md', '系统配置'],
  ]);
  const calls = [];
  const catalog = new NoteCatalog({ url: () => 'https://notes.example/users/alice/',
    inventory: async () => [...pages].map(([name, content], index) => ({ name, size: Buffer.byteLength(content), lastModified: 1000 + index })),
    read: async page => { calls.push(page); if (!pages.has(page + '.md')) throw new Error('note_not_found'); return { content: pages.get(page + '.md') }; },
  });
  return { catalog, pages, calls };
}

test('listing is metadata only, paginated and excludes library/config/archives by default', async () => {
  const { catalog, calls } = fixture();
  const first = await catalog.list({ limit: 1 });
  assert.deepEqual(first.items.map(p => p.page), ['生活/阅读']);
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  assert.match(first.items[0].url, /users\/alice\//); assert.ok(!('content' in first.items[0]));
  const second = await catalog.list({ limit: 1, offset: first.nextOffset });
  assert.deepEqual(second.items.map(p => p.page), ['生活/运动']); assert.equal(second.nextOffset, null);
  assert.deepEqual(calls, []);
  assert.equal((await catalog.list({ includeArchived: true })).total, 3);
  assert.equal((await catalog.list({ prefix: '生活/' })).total, 2);
});

test('Chinese, title, literal regex/option data and case insensitive matching return original lines', async () => {
  const { catalog, calls } = fixture();
  for (const query of ['游泳', '泳镜', '运动', '.*', '--files', 'healthcheck']) {
    const result = await catalog.search({ query });
    assert.equal(result.items.length, 1, query); assert.equal(result.incomplete, false);
    assert.ok(result.items[0].excerpts.length); assert.ok(result.items[0].url.startsWith('https://notes.example/users/alice/'));
  }
  const result = await catalog.search({ query: '游泳' });
  assert.equal(result.items[0].excerpts[0].line, 1); assert.match(result.items[0].excerpts[0].text, /游泳/);
  assert.ok(calls.every(page => page.startsWith('生活/')));
  assert.equal((await catalog.search({ query: 'quasarzznvxtp731' })).items.length, 0);
});

test('writes and deletions are visible immediately without a persistent search cache', async () => {
  const { catalog, pages } = fixture();
  assert.equal((await catalog.search({ query: 'oldopalqrx' })).items.length, 1);
  pages.set('生活/运动.md', 'newamberjtz');
  assert.equal((await catalog.search({ query: 'oldopalqrx' })).items.length, 0);
  assert.equal((await catalog.search({ query: 'newamberjtz' })).items.length, 1);
  pages.delete('生活/运动.md'); assert.equal((await catalog.search({ query: 'newamberjtz' })).items.length, 0);
});

test('path and query controls are rejected, caller cannot select another URL or account', async () => {
  const { catalog } = fixture();
  for (const prefix of ['../', '/users/bob', 'x/../y', '%2e%2e/', 'x\\y', 'https://foreign']) await assert.rejects(catalog.list({ prefix }), /invalid_note_prefix/);
  for (const query of ['', '\n', 'hello\nworld', '\0', 'x'.repeat(201)]) await assert.rejects(catalog.search({ query }), /invalid_note_query/);
  await assert.rejects(catalog.list({ limit: 500 }), /invalid_note_limit/);
  await assert.rejects(catalog.list({ offset: -1 }), /invalid_note_offset/);
  const own = await catalog.search({ query: '游泳', userId: 'bob', url: 'https://foreign' });
  assert.ok(own.items.every(item => item.url.startsWith('https://notes.example/users/alice/')));
});

test('partial scans, skipped oversized notes and result limits are explicitly reported', async () => {
  const { catalog, pages } = fixture();
  for (let i = 0; i < 205; i++) pages.set('额外/' + i + '.md', '游泳');
  const result = await catalog.search({ query: '游泳', limit: 1 });
  assert.equal(result.items.length, 1); assert.equal(result.incomplete, true); assert.ok(result.scannedPages <= 200);
  const big = new NoteCatalog({ inventory: async () => [{ name: '大笔记.md', size: 300000 }], read: async () => { throw new Error('should_not_read'); } });
  const skipped = await big.search({ query: '游泳' }); assert.equal(skipped.skippedPages, 1); assert.equal(skipped.incomplete, true);
});

test('aborted operations and transport permission errors are not reported as empty results', async () => {
  const { catalog } = fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(catalog.search({ query: '游泳' }, abort.signal), { name: 'AbortError' });
  const denied = new NoteCatalog({ inventory: async () => { throw new Error('access_denied'); }, read: async () => ({ content: '' }) });
  await assert.rejects(denied.search({ query: '游泳' }), /access_denied/);
});
