import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaFailure, QUOTA_NOTICE } from '../src/model-errors.mjs';

test('quota exhaustion is distinct from ordinary 429 throttling and private errors', () => {
  assert.equal(isQuotaFailure(new Error('429 已达到 Token Plan 用量上限 (2056)')), true);
  assert.equal(isQuotaFailure('insufficient_quota'), true);
  assert.equal(isQuotaFailure({ code: 'model_quota_exhausted' }), true);
  assert.equal(isQuotaFailure('429 Too many requests: rate_limit_error'), false);
  assert.equal(isQuotaFailure('request_id=fixture2056xyz'), false);
  assert.equal(isQuotaFailure(new Error('Network failed: fake-private-key')), false);
  assert.ok(!QUOTA_NOTICE.includes('fake-private-key'));
});
