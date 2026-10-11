import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayDataMissingError, isReplayDataMissing } from '../../src/main/infrastructure/replay-data-error.js';
import { normaliseTransportError } from '../../src/main/planning/adapters/openai-compatible-transport.js';

test('SDK 包装不能把缺失回放转换成可降级的普通模型故障', () => {
  const missing = new ReplayDataMissingError('缺少模型响应回放：commercial');
  const wrapped = new Error('Connection error', { cause: missing });
  assert.equal(isReplayDataMissing(wrapped), true);
  assert.throws(() => normaliseTransportError(wrapped), error => error === wrapped);
  assert.equal(isReplayDataMissing(new Error('ordinary provider outage')), false);
  assert.equal(normaliseTransportError(new Error('ordinary provider outage')).code, 'unknown');
});
