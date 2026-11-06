import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformOperationService, PlatformOperationError } from '../../src/main/application/platform-operation-service.js';
import { runPhaseWithRecovery } from '../../src/main/automation/recovery/recovery-run.js';
import { WriteNotDispatchedError } from '../../src/main/automation/automation.main/automation.main.errors.js';
import { assertPlatformQueryResponse } from '../../src/main/infrastructure/platform-query-response.js';

const context = { source: 'vbk' as const, accountKey: 'account', capability: 'poi', query: { keyword: '成都' } };
test('missing collections and provider authentication failures cannot masquerade as no resources', async () => {
  const service = new PlatformOperationService();
  for (const [payload, status] of [[{}, 'protocol_failure'],
    [{ ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: '40010001', Message: '登录失效' }] }, resources: [] }, 'login_required']] as const) {
    const result = await service.query(context, async () => {
      assertPlatformQueryResponse(payload, [['resources']], '资源查询'); return [];
    }, value => !value.length);
    assert.equal(result.status, status);
  }
  assert.doesNotThrow(() => assertPlatformQueryResponse({ resources: [] }, [['resources']], '资源查询'));
});
test('empty provider response and authentication, network, protocol errors are distinct', async () => {
  const service = new PlatformOperationService();
  const empty = await service.query(context, async () => [], value => !value.length);
  assert.equal(empty.status, 'empty');
  assert.ok(empty.evidence.verifiedAt);
  for (const [message, status] of [['401 未登录', 'login_required'], ['网络超时', 'network_failure'],
    ['Ack=缺失', 'protocol_failure'], ['资源不可售', 'business_rejection']] as const) {
    const result = await service.query(context, async () => { throw new Error(message); }, () => false);
    assert.equal(result.status, status);
    assert.equal(result.evidence.verifiedAt, undefined);
    await assert.rejects(service.queryValue(context, async () => { throw new Error(message); }), error =>
      error instanceof PlatformOperationError && error.kind === status);
  }
});

test('write authorizes immediately before dispatch and never retries internally', async () => {
  const service = new PlatformOperationService(); let calls = 0;
  await assert.rejects(service.write(context, async () => { throw new Error('账号已切换'); }, async () => { calls++; }), /账号已切换/);
  assert.equal(calls, 0);
  await assert.rejects(service.write(context, async () => undefined, async () => { calls++; throw new Error('请求超时'); }),
    error => error instanceof PlatformOperationError && error.uncertainWrite);
  assert.equal(calls, 1);
});

test('uncertain write persists needs-user and propagates to Agent without advisory replay', async () => {
  let calls = 0; let advisoryCalls = 0;
  const run = { id: 'run', status: 'running', phases: [{ phase: 'basic', status: 'running' }], logs: [] };
  await assert.rejects(runPhaseWithRecovery({ run, phase: 'basic', completedPhases: [], productIdExists: true,
    basicInfoSaved: false, execute: async () => { calls++; throw new PlatformOperationError('请求超时', 'write_uncertain'); },
    advisor: async () => { advisoryCalls++; return { action: 'retry_same_phase' }; },
    applyAction: async () => undefined, persist: () => undefined, log: () => undefined } as never),
  error => error instanceof PlatformOperationError && error.uncertainWrite);
  assert.equal(calls, 1); assert.equal(advisoryCalls, 0);
  assert.equal((run as { recovery?: { phases: Record<string, { state: string }> } }).recovery?.phases.basic?.state, 'needs_user');
});

// 2026-11-06 产品 80989432：行程版本关系不可写时在发请求前就停止，报错含「协议」二字，
// 曾被文案分类误判为 protocol_failure → 写入结果不明，任务被锁成「先核查回读」。
test('write refused before dispatch is not an uncertain write and skips advisory replay', async () => {
  const service = new PlatformOperationService(); const outcomes: string[] = [];
  const tracked = new PlatformOperationService((_evidence, outcome) => outcomes.push(outcome));
  const refuse = async () => { throw new WriteNotDispatchedError('没有当前平台写入协议证据，未发送任何写请求。'); };
  await assert.rejects(tracked.write(context, async () => undefined, refuse),
    error => error instanceof WriteNotDispatchedError && !(error as { uncertainWrite?: boolean }).uncertainWrite);
  assert.deepEqual(outcomes, ['write_dispatched', 'business_rejection']);
  let advisoryCalls = 0;
  const run = { id: 'run', status: 'running', phases: [{ phase: 'itinerary', status: 'running' }], logs: [] };
  await assert.rejects(runPhaseWithRecovery({ run, phase: 'itinerary', completedPhases: [], productIdExists: true,
    basicInfoSaved: true, execute: () => service.write(context, async () => undefined, refuse),
    advisor: async () => { advisoryCalls++; return { action: 'retry_same_phase' }; },
    applyAction: async () => undefined, persist: () => undefined, log: () => undefined } as never), WriteNotDispatchedError);
  assert.equal(advisoryCalls, 0);
  const phase = (run as { recovery?: { phases: Record<string, { state: string; userInstruction?: string }> } }).recovery?.phases.itinerary;
  assert.equal(phase?.state, 'needs_user');
  assert.doesNotMatch(phase?.userInstruction ?? '', /写入结果不明/);
});
