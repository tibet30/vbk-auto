import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCore } from '../../src/main/agent/core.js';
import type { AgentCoreDependencies, AgentModelResult } from '../../src/main/agent/types.js';
import type { AgentSnapshot } from '../../src/shared/contracts-agent.js';
import { AgentSnapshotManager } from '../../src/main/agent/core-snapshot.js';
import { AgentToolRunner } from '../../src/main/agent/core-tools.js';

function fixture(outputs: AgentModelResult[]) {
  const saved = new Map<string, AgentSnapshot>();
  let executions = 0;
  const deps: AgentCoreDependencies = {
    model: { complete: async () => outputs.shift() ?? { content: '已完成' } },
    accountFor: async () => ({ accountKey: 'a', productVersion: 'v' }),
    tools: [{ name: 'query_poi', description: '查询', parameters: { type: 'object', required: ['keyword'],
      properties: { keyword: { type: 'string' } } }, execute: async () => { executions++; return { content: '已核验' }; } }],
  };
  const core = new AgentCore(deps, { getAgentSnapshot: id => saved.get(id),
    saveAgentSnapshot: snapshot => saved.set(snapshot.localProductId, structuredClone(snapshot)) });
  return { core, deps, executions: () => executions };
}

for (const scenario of ['malformed', 'unknown', 'validation', 'questions', 'approval', 'denied', 'precondition'] as const) {
  test(`unexecuted ${scenario} cannot become a completed request or returned action`, async () => {
    const call = { id: 'rejected', name: 'query_poi', arguments: { keyword: '成都' } as Record<string, unknown> };
    if (scenario === 'unknown') call.name = 'missing_tool';
    if (scenario === 'validation') call.arguments = { keyword: '' };
    if (scenario === 'questions') { call.name = 'ask_user'; call.arguments = { questions: [] }; }
    if (scenario === 'approval' || scenario === 'precondition') {
      call.name = 'request_approval'; call.arguments = scenario === 'approval' ? {} : { scope: ['query_poi'], summary: '确认' };
    }
    const { core, deps, executions } = fixture([{ toolCalls: [{ ...call,
      ...(scenario === 'malformed' ? { argumentError: '无效 JSON', rawArguments: '{oops' } : {}) }] }]);
    if (scenario === 'denied') deps.tools[0]!.requiresApproval = true;
    if (scenario === 'precondition') deps.approvalPrecondition = async () => '未准备好';
    await core.send('p', '查景点'); await core.idle('p');
    const result = await core.get('p');
    assert.equal(executions(), 0);
    assert.equal(result.run!.status, 'paused');
    assert.ok(!result.events.some(event => event.type === 'status' && event.data?.status === 'completed'));
    assert.deepEqual(result.stages!.at(-1)!.returnedActions, []);
    assert.match(result.stages!.at(-1)!.summary!, /未执行|工具操作失败/);
  });
}

test('corrected arguments clear a rejection of the same tool and allow verified execution', async () => {
  const { core, executions } = fixture([
    { toolCalls: [{ id: 'bad', name: 'query_poi', arguments: { keyword: '' } }] },
    { toolCalls: [{ id: 'fixed', name: 'query_poi', arguments: { keyword: '成都' } }] },
  ]);
  await core.send('p', '查景点'); await core.idle('p');
  const result = await core.get('p');
  assert.equal(executions(), 1);
  assert.equal(result.run!.status, 'completed');
  assert.deepEqual(result.stages!.at(-1)!.returnedActions, ['查询景点']);
});

for (const flag of ['error', 'cancelled', 'preparationDenied'] as const) {
  test(`structured ${flag} results are never reused from the read cache`, async () => {
    const { core, deps } = fixture([
      { toolCalls: [{ id: 'first', name: 'query_poi', arguments: { keyword: '成都' } }] },
      { toolCalls: [{ id: 'retry', name: 'query_poi', arguments: { keyword: '成都' } }] },
    ]);
    let attempts = 0;
    deps.tools[0]!.execute = async () => ({ content: '查询响应', data: ++attempts === 1
      ? { [flag]: flag === 'error' ? '超时' : true } : {} });
    await core.send('p', '查景点'); await core.idle('p');
    const result = await core.get('p');
    assert.equal(attempts, 2);
    assert.equal(result.run!.status, 'completed');
    assert.ok(!result.events.some(event => event.data?.cachedReadQuery === true));
  });
}

test('authorization rejected for one phase is not cleared by successful work in another phase', () => {
  const saved = new Map<string, AgentSnapshot>();
  let id = 0;
  const manager = new AgentSnapshotManager({ getAgentSnapshot: key => saved.get(key),
    saveAgentSnapshot: snapshot => saved.set(snapshot.localProductId, structuredClone(snapshot)) },
  () => new Date(), () => `e-${++id}`);
  const snapshot = manager.load('p'); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'tool_call', 'execute_vbk_phase', { name: 'execute_vbk_phase', toolCallId: 'basic', arguments: { phase: 'basic' } });
  manager.blockedResult(snapshot, 'basic', '基础信息未获授权', 'authorization_denied');
  manager.event(snapshot, 'tool_call', 'execute_vbk_phase', { name: 'execute_vbk_phase', toolCallId: 'itinerary', arguments: { phase: 'itinerary' } });
  manager.result(snapshot, 'itinerary', '行程已录入'); manager.finish(snapshot);
  assert.equal(snapshot.run.status, 'paused');
  manager.running(snapshot);
  manager.event(snapshot, 'tool_call', 'execute_vbk_phase', { name: 'execute_vbk_phase', toolCallId: 'basic-retry', arguments: { phase: 'basic' } });
  manager.result(snapshot, 'basic-retry', '基础信息已录入'); manager.finish(snapshot);
  assert.equal(snapshot.run.status, 'completed');
});

for (const data of [{ error: '结果失败' }, { uncertainWrite: true }]) {
  test(`failed terminal results do not complete or enter the cache: ${JSON.stringify(data)}`, async () => {
    const saved = new Map<string, AgentSnapshot>();
    let id = 0, attempts = 0;
    const manager = new AgentSnapshotManager({ getAgentSnapshot: key => saved.get(key),
      saveAgentSnapshot: snapshot => saved.set(snapshot.localProductId, structuredClone(snapshot)) },
    () => new Date(), () => `e-${++id}`);
    const deps: AgentCoreDependencies = { model: { complete: async () => ({ content: '' }) },
      accountFor: async () => ({ accountKey: 'a', productVersion: 'v' }),
      tools: [{ name: 'query_poi', description: '查询', parameters: {}, execute: async () => ({
        content: '响应内容', terminal: attempts++ === 0,
        ...(attempts === 1 ? data.uncertainWrite ? { uncertainWrite: true } : { data } : {}),
      }) }] };
    const runner = new AgentToolRunner(deps, manager, () => new Date(), () => `q-${++id}`);
    const snapshot = manager.load('p'); snapshot.run = manager.newRun('running'); manager.save(snapshot);
    const token = manager.token(snapshot);
    const call = { id: 'first', name: 'query_poi', arguments: { keyword: '成都' } };
    manager.event(snapshot, 'tool_call', call.name, { toolCallId: call.id, name: call.name, arguments: call.arguments }); manager.save(snapshot);
    await runner.execute('p', call, token);
    const after = manager.load('p');
    assert.notEqual(after.run!.status, 'completed');
    // Simulate authoritative reconciliation followed by retry in the same run.
    after.uncertainWrite = undefined; manager.running(after); manager.save(after);
    await runner.execute('p', { ...call, id: 'retry' }, token);
    assert.equal(attempts, 2);
    assert.ok(!manager.load('p').events.some(event => event.data?.cachedReadQuery === true));
  });
}
