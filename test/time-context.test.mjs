import test from 'node:test';
import assert from 'node:assert/strict';
import { timePrefix, withTimeContext } from '../src/time-context.mjs';
const start = Date.parse('2026-10-17T01:00:00Z');
test('first turn includes Beijing time and date', () => {
  assert.match(timePrefix({ receivedAt: start, now: start }), /2026-10-17 09:00:00/);
});
test('threshold is strictly over ten minutes and uses receipt timestamps', () => {
  assert.equal(timePrefix({ receivedAt: start + 600000, previousReceivedAt: start, now: start + 900000 }), '');
  assert.match(timePrefix({ receivedAt: start + 600001, previousReceivedAt: start, now: start + 600001 }), /程序附加/);
});
test('crossing Beijing midnight injects even within ten minutes', () => {
  assert.match(timePrefix({ receivedAt: Date.parse('2026-10-17T16:01:00Z'), previousReceivedAt: Date.parse('2026-10-17T15:59:00Z') }), /程序附加/);
});
test('delayed processing distinguishes receipt time and processing time', () => {
  const prefix = timePrefix({ receivedAt: start, now: start + 3600000 });
  assert.match(prefix, /当前北京时间：2026-10-17 10:00:00/);
  assert.match(prefix, /接收时间：2026-10-17 09:00:00/);
});
test('image blocks and original prompt remain untouched; short gap returns original', () => {
  const blocks = [{ type: 'text', text: '原文' }, { type: 'image', data: 'fake' }];
  const changed = withTimeContext(blocks, { receivedAt: start, now: start });
  assert.equal(blocks[0].text, '原文'); assert.equal(changed[1], blocks[1]); assert.ok(changed[0].text.endsWith('原文'));
  assert.equal(withTimeContext(blocks, { receivedAt: start + 1000, previousReceivedAt: start }), blocks);
});
