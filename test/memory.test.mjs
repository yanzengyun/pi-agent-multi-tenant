import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { memorySnapshot } from '../src/memory.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-memory-'));
  const store = new Store(directory), alice = store.createUser('alice', 'fake'), bob = store.createUser('bob', 'fake');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, alice, bob, directory };
}

test('append preserves legacy text byte for byte, isolates users and survives reopening', t => {
  const { store, alice, bob, directory } = fixture(t);
  const legacy = '  # 用户背景\r\n偏好中文\r\n\r\n已有目标  \r\n';
  store.writeMemory(alice.id, legacy); store.writeMemory(bob.id, 'BOB_PRIVATE');
  const first = store.changeMemory(alice.id, { content: '学习Python' });
  assert.equal(first.content, legacy + '\n\n学习Python');
  const id = first.entries.at(-1).id;
  const second = store.changeMemory(alice.id, { content: '喜欢游泳' });
  assert.ok(second.entries.some(entry => entry.id === id));
  assert.equal(store.memory(bob.id), 'BOB_PRIVATE');
  const reopened = new Store(directory);
  try { assert.equal(reopened.memory(alice.id), second.content); } finally { reopened.close(); }
});

test('update and forget touch only a selected paragraph and require a fresh version', t => {
  const { store, alice, bob } = fixture(t);
  const legacy = '  第一段\n保留同段事实  \r\n\r\n第二段\r\n\r\n第三段  ';
  store.writeMemory(alice.id, legacy); store.writeMemory(bob.id, '别人的条目');
  const old = memorySnapshot(legacy), middle = old.entries[1];
  const updated = store.changeMemory(alice.id, { mode: 'update', id: middle.id, version: old.version, content: '修正后的第二段' });
  assert.equal(updated.content, legacy.replace('第二段', '修正后的第二段'));
  assert.throws(() => store.changeMemory(alice.id, { mode: 'delete', id: old.entries[0].id, version: old.version }), /memory_conflict/);
  const removed = store.changeMemory(alice.id, { mode: 'delete', id: updated.entries[1].id, version: updated.version });
  assert.equal(removed.content, updated.content.replace('修正后的第二段', ''));
  assert.throws(() => store.changeMemory(alice.id, { mode: 'delete', id: memorySnapshot('别人的条目').entries[0].id, version: removed.version }), /memory_entry_not_found/);
  assert.equal(store.memory(alice.id), removed.content); assert.equal(store.memory(bob.id), '别人的条目');
});

test('overwrite is explicit and versioned; invalid and full writes leave existing facts intact', t => {
  const { store, alice } = fixture(t);
  store.writeMemory(alice.id, 'KEEP');
  const version = memorySnapshot('KEEP').version;
  for (const input of [{ mode: 'overwrite', content: 'DROP' }, { content: '' }, { content: ' ' },
    { mode: 'invented', content: 'DROP' }, { content: 'x'.repeat(8000) }, { mode: 'delete', id: 'bad', version }]) {
    assert.throws(() => store.changeMemory(alice.id, input)); assert.equal(store.memory(alice.id), 'KEEP');
  }
  assert.equal(store.changeMemory(alice.id, { mode: 'overwrite', content: 'REPLACED', version }).content, 'REPLACED');
  const full = store.changeMemory(alice.id, { mode: 'overwrite', content: 'x'.repeat(8000), version: memorySnapshot('REPLACED').version });
  assert.throws(() => store.changeMemory(alice.id, { content: 'new' }), /memory_full/);
  assert.equal(store.memory(alice.id), full.content);
  assert.equal(store.changeMemory(alice.id, { mode: 'overwrite', content: '', version: full.version }).content, '');
});

test('a second connection appends to latest state and stale destructive edits cannot clobber it', t => {
  const { store, alice, directory } = fixture(t), other = new Store(directory);
  try {
    store.writeMemory(alice.id, 'KEEP'); const before = memorySnapshot('KEEP');
    other.changeMemory(alice.id, { content: 'OTHER_CONNECTION' });
    assert.throws(() => store.changeMemory(alice.id, { mode: 'overwrite', content: 'STALE', version: before.version }), /memory_conflict/);
    assert.equal(store.changeMemory(alice.id, { content: 'NEW' }).content, 'KEEP\n\nOTHER_CONNECTION\n\nNEW');
  } finally { other.close(); }
});

test('duplicate paragraphs have distinct IDs and unavailable users cannot mutate memory', t => {
  const { store, alice } = fixture(t);
  store.writeMemory(alice.id, '重复\n\n重复'); const before = memorySnapshot(store.memory(alice.id));
  assert.notEqual(before.entries[0].id, before.entries[1].id);
  const after = store.changeMemory(alice.id, { mode: 'update', id: before.entries[1].id, content: '只改第二条', version: before.version });
  assert.equal(after.content, '重复\n\n只改第二条');
  store.beginDeletion(alice.id);
  assert.throws(() => store.changeMemory(alice.id, { content: 'denied' }), /user_unavailable/);
  assert.equal(store.memory(alice.id), after.content);
});
