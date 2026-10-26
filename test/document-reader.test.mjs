import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toMarkdown } from '@firecrawl/anydoc';
import { documentReader, safeDocumentName } from '../src/document-reader.mjs';

test('document reader converts locally and cannot cross tenant paths or symlinks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tenant-doc-')), alice = join(root, 'alice'), bob = join(root, 'bob');
  mkdirSync(alice); mkdirSync(bob);
  writeFileSync(join(alice, 'own.csv'), 'name,amount\nalpha,12\nbeta,34\n');
  writeFileSync(join(bob, 'private.csv'), 'BOB_PRIVATE,99\n');
  symlinkSync(join(bob, 'private.csv'), join(alice, 'escape.csv'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reader = documentReader(alice, toMarkdown);
  const own = await reader.read('own.csv');
  assert.match(own.content, /beta/); assert.match(own.content, /34/); assert.equal(own.ocr, false);
  await assert.rejects(reader.read(join(bob, 'private.csv')), /document_outside_tenant/);
  await assert.rejects(reader.read('escape.csv'), /document_outside_tenant/);
  assert.doesNotMatch(JSON.stringify(own), /BOB_PRIVATE/);
});

test('document reader rejects unsupported, oversized and OCR-only input without cloud fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tenant-doc-policy-'));
  writeFileSync(join(root, 'bad.txt'), 'text'); writeFileSync(join(root, 'scan.pdf'), 'fake');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(documentReader(root, toMarkdown).read('bad.txt'), /unsupported_document_type/);
  const needsOcr = Object.assign(new Error('scan'), { code: 'needsOcr' });
  await assert.rejects(documentReader(root, async () => { throw needsOcr; }).read('scan.pdf'), /document_needs_ocr/);
  assert.equal(safeDocumentName('../../合同 1.pdf'), '合同_1.pdf');
});
