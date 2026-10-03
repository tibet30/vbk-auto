import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCore } from '../../src/main/agent/core.js';
import { AgentSnapshotManager } from '../../src/main/agent/core-snapshot.js';
import { hydrateAgentStages } from '../../src/shared/agent-stage-lifecycle.js';
import { agentDisplaySnapshot, agentHistoryPage } from '../../src/shared/agent-display.js';
import { sanitizeAgentSnapshot } from '../../src/shared/agent-snapshot-sanitize.js';
import type { AgentSnapshot } from '../../src/shared/contracts-agent.js';
import type { AgentModelResult } from '../../src/main/agent/types.js';

function fixture() {
  const saved = new Map<string, AgentSnapshot>();
  let id = 0;
  const store = { getAgentSnapshot: (key: string) => saved.get(key), saveAgentSnapshot: (value: AgentSnapshot) => saved.set(value.localProductId, structuredClone(value)) };
  const manager = new AgentSnapshotManager(store, () => new Date('2026-10-03T00:00:00Z'), () => `id-${++id}`);
  return { saved, store, manager, snapshot: manager.load('p') };
}

test('a decision checkpoint persists its summary, answer and next stage across reload', async () => {
  const { saved, store } = fixture();
  const outputs: AgentModelResult[] = [
    { content: '我会先核对景点。', toolCalls: [{ id: 'read', name: 'read_product', arguments: {} }] },
    { toolCalls: [{ id: 'ask', name: 'ask_user', arguments: {
      summary: '已核对行程；第 2 天较满，需要你选择节奏。回答后继续匹配酒店。',
      questions: [{ id: 'pace', label: '行程节奏', kind: 'single', required: true, options: [{ id: 'slow', label: '轻松一些' }, { id: 'full', label: '多安排景点' }] }],
    } }] },
    { content: '已按轻松节奏整理方案，本次调整完成。' },
  ];
  let calls = 0;
  const deps = { model: { complete: async () => { calls++; return outputs.shift()!; } },
    tools: [{ name: 'read_product', description: '读取', parameters: {}, execute: async () => ({ content: '行程已读取' }) }],
    accountFor: async () => ({ accountKey: 'a', productVersion: 'v1' }) };
  const core = new AgentCore(deps, store);
  await core.send('p', '核对行程'); await core.idle('p');
  const waiting = await core.get('p');
  assert.equal(waiting.stages?.length, 1);
  assert.equal(waiting.stages![0]!.status, 'waiting_input');
  assert.match(waiting.stages![0]!.summary!, /已核对行程/);
  assert.deepEqual(waiting.stages![0]!.returnedActions, ['读取产品方案']);
  const requestId = waiting.pendingInput!.id;
  const reloaded = new AgentCore(deps, store);
  await reloaded.respond('p', { requestId, answers: { pace: 'slow' } }); await reloaded.idle('p');
  const completed = await reloaded.get('p');
  assert.equal(completed.stages?.length, 2);
  assert.equal(completed.stages![0]!.status, 'resolved');
  assert.equal(completed.stages![0]!.decision, '行程节奏：轻松一些');
  assert.equal(completed.stages![1]!.status, 'completed');
  assert.match(completed.stages![1]!.summary!, /本次调整完成/);
  const before = JSON.stringify(saved.get('p')!.stages);
  await reloaded.respond('p', { requestId, answers: { pace: 'full' } }); await reloaded.idle('p');
  assert.equal(JSON.stringify(saved.get('p')!.stages), before);
  assert.equal(calls, 3);
});

test('late tool results retain their original stage; paused execution resumes the same stage', () => {
  const { manager, snapshot } = fixture();
  snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'user', '查询行程'); manager.running(snapshot);
  manager.event(snapshot, 'tool_call', 'query_poi', { name: 'query_poi', toolCallId: 'late' });
  const original = snapshot.stages![0]!.id;
  manager.event(snapshot, 'user', '改查酒店'); manager.running(snapshot);
  const current = snapshot.stages!.at(-1)!.id;
  manager.result(snapshot, 'late', '原景点查询返回');
  assert.equal(snapshot.events.at(-1)!.data!.stageId, original);
  assert.equal(snapshot.stages![0]!.status, 'superseded');
  manager.pause(snapshot, '酒店查询超时'); manager.save(snapshot);
  const restored = manager.load('p');
  assert.equal(restored.stages!.at(-1)!.id, current);
  assert.equal(restored.stages!.at(-1)!.status, 'paused');
  manager.running(restored);
  assert.equal(restored.stages!.length, 2);
  assert.equal(restored.stages!.at(-1)!.status, 'running');
});

test('final-approval invalidation does not leave a ready checkpoint visible', () => {
  const { manager, snapshot } = fixture();
  snapshot.run = manager.newRun('running'); manager.running(snapshot);
  manager.createApproval(snapshot, ['write'], '方案已整理，请确认。', { accountKey: 'a', productVersion: 'v1' });
  const previousId = snapshot.stages!.at(-1)!.id;
  assert.equal(snapshot.stages!.at(-1)!.status, 'waiting_approval');
  manager.cancelPendingInteraction(snapshot, '方案已变化，确认失效。'); manager.pause(snapshot, '需要重新核验');
  assert.equal(snapshot.stages!.find((stage) => stage.id === previousId)!.status, 'superseded');
  assert.match(snapshot.stages!.find((stage) => stage.id === previousId)!.summary!, /确认失效/);
  assert.equal(snapshot.pendingApproval, undefined);
  assert.equal(snapshot.stages!.at(-1)!.status, 'paused');
});

test('terminal tool evidence wins over an earlier model preamble', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'assistant', '准备开始查询。', { generatedToolPreamble: true });
  manager.event(snapshot, 'tool_call', 'read_vbk_phase', { name: 'read_vbk_phase', toolCallId: 'read', modelTurnId: 't' });
  manager.result(snapshot, 'read', '母产品只读核验完成。', { terminal: true }); manager.finish(snapshot);
  assert.equal(snapshot.stages!.at(-1)!.summary, '母产品只读核验完成。');
  assert.doesNotMatch(snapshot.stages!.at(-1)!.summary!, /准备开始/);
});

test('legacy checkpoints are stable and bounded pages retain full stage metadata', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  for (let index = 0; index < 150; index++) manager.event(snapshot, 'assistant', `进展 ${index}`);
  manager.createApproval(snapshot, ['write'], '等待最终确认', { accountKey: 'a', productVersion: 'v1' });
  const display = agentDisplaySnapshot(snapshot);
  assert.equal(display.events.length, 120);
  assert.equal(display.stages![0]!.summary, '等待最终确认');
  assert.equal(display.stages![0]!.eventCount, 152);
  const oldPage = agentHistoryPage(snapshot.events, 1);
  assert.equal(oldPage.events.length, 32);
  assert.equal(oldPage.events[0]!.data!.stageId, display.stages![0]!.id);
  const legacy = structuredClone(snapshot); delete legacy.stages;
  legacy.events.forEach((event) => { delete event.data?.stageId; });
  hydrateAgentStages(legacy);
  const once = JSON.stringify(legacy.stages);
  hydrateAgentStages(legacy); assert.equal(JSON.stringify(legacy.stages), once);
  assert.equal(legacy.stages![0]!.summary, '等待最终确认');
});

test('legacy final summaries do not consume future replies from the same run', () => {
  const snapshot: AgentSnapshot = { localProductId: 'p', run: null, events: [
    { id: 'a', type: 'assistant', runId: 'r', createdAt: 't', content: '第一个请求已完成' },
    { id: 'b', type: 'status', runId: 'r', createdAt: 't', content: '完成', data: { status: 'completed' } },
    { id: 'c', type: 'user', runId: 'r', createdAt: 't', content: '后续问题' },
    { id: 'd', type: 'assistant', runId: 'r', createdAt: 't', content: '后续问题的回答' },
  ] };
  hydrateAgentStages(snapshot);
  assert.equal(snapshot.stages![0]!.summary, '第一个请求已完成');
});

test('failed and cancelled tools are not described as accomplished actions', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'tool_call', 'query_poi', { name: 'query_poi', toolCallId: 'a' });
  manager.result(snapshot, 'a', '超时', { error: '超时' }); manager.pause(snapshot, '查询失败');
  assert.deepEqual(snapshot.stages![0]!.returnedActions, []);
  assert.equal(snapshot.stages![0]!.status, 'paused');
  assert.doesNotMatch(snapshot.stages![0]!.summary!, /任务已完成/);
});

test('stage summaries and decision records are redacted with the snapshot', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'assistant', 'apiKey=secret'); manager.finish(snapshot);
  snapshot.stages![0]!.decision = 'token=secret';
  const safe = sanitizeAgentSnapshot(snapshot);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});

test('usage appended outside the loop retains its checkpoint instead of starting a new phase', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'assistant', '检查完成'); manager.finish(snapshot);
  const checkpoint = snapshot.stages![0]!.id;
  snapshot.events.push({ id: 'usage', type: 'status', runId: snapshot.run.id, createdAt: 't', content: '模型用量', data: { aiUsage: {} } });
  hydrateAgentStages(snapshot);
  assert.equal(snapshot.stages!.length, 1);
  assert.equal(snapshot.events.at(-1)!.data!.stageId, checkpoint);
  assert.equal(snapshot.stages![0]!.status, 'completed');
  assert.equal(snapshot.stages![0]!.summary, '检查完成');
});

test('revoking a premature completion supersedes the former final summary', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'assistant', '声称已完成'); manager.finish(snapshot);
  manager.pause(snapshot, '已纠正提前结束，资源尚未完成');
  assert.equal(snapshot.stages![0]!.status, 'superseded');
  assert.match(snapshot.stages![0]!.summary!, /完成结论已撤销/);
  assert.equal(snapshot.stages!.at(-1)!.status, 'paused');
  assert.equal(snapshot.stages!.at(-1)!.summary, '已纠正提前结束，资源尚未完成');
  assert.notEqual(snapshot.stages![0]!.summary, snapshot.stages!.at(-1)!.summary);
  manager.save(snapshot);
  assert.deepEqual(manager.load('p').stages, snapshot.stages);
});

test('a false model success after a failed query pauses with an evidence-based summary', async () => {
  const { store } = fixture();
  const outputs: AgentModelResult[] = [
    { toolCalls: [{ id: 'fail', name: 'query_poi', arguments: { keyword: '成都' } }] },
    { content: '景点查询已完成，全部核验通过。' },
  ];
  const core = new AgentCore({ model: { complete: async () => outputs.shift()! },
    tools: [{ name: 'query_poi', description: '查询', parameters: {}, execute: async () => { throw new Error('查询超时'); } }],
    accountFor: async () => ({ accountKey: 'a', productVersion: 'v1' }) }, store);
  await core.send('p', '查询景点'); await core.idle('p');
  const result = await core.get('p');
  assert.equal(result.run!.status, 'paused');
  assert.equal(result.stages!.at(-1)!.status, 'paused');
  assert.match(result.stages!.at(-1)!.summary!, /工具操作失败/);
  assert.doesNotMatch(result.stages!.at(-1)!.summary!, /已完成|全部核验通过/);
  assert.deepEqual(result.stages!.at(-1)!.returnedActions, []);
});

test('retry success clears matching failures but not a different target', () => {
  for (const sameTarget of [false, true]) {
    const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
    manager.event(snapshot, 'tool_call', 'query_poi', { toolCallId: 'first', name: 'query_poi', arguments: { keyword: '成都', city: '四川' } });
    manager.result(snapshot, 'first', '查询超时', { error: '超时' });
    manager.event(snapshot, 'tool_call', 'query_poi', { toolCallId: 'retry', name: 'query_poi', arguments: { city: '四川', keyword: sameTarget ? '成都' : '绵阳' } });
    manager.result(snapshot, 'retry', '查询结果已返回');
    manager.event(snapshot, 'assistant', '查询已完成'); manager.finish(snapshot);
    assert.equal(snapshot.run.status, sameTarget ? 'completed' : 'paused');
  }
});

test('an earlier run failure does not block the current run', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.result(snapshot, 'old-call', '上次查询失败', { error: '超时' }, 'old-run');
  manager.event(snapshot, 'assistant', '本次请求已处理'); manager.finish(snapshot);
  assert.equal(snapshot.run.status, 'completed');
  assert.equal(snapshot.stages!.at(-1)!.summary, '本次请求已处理');
});

test('whole-request terminal readback clears failures but never hides a later failure', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.result(snapshot, 'old', '失败', { error: '超时' });
  manager.result(snapshot, 'readback', '本次结果已通过权威回读', { terminal: true });
  manager.finish(snapshot);
  assert.equal(snapshot.run.status, 'completed');
  assert.equal(snapshot.stages!.at(-1)!.summary, '本次结果已通过权威回读');
  manager.running(snapshot);
  manager.result(snapshot, 'later', '后续查询失败', { error: '超时' });
  manager.event(snapshot, 'assistant', '全部已完成'); manager.finish(snapshot);
  assert.equal(snapshot.run.status, 'paused');
  assert.doesNotMatch(snapshot.stages!.at(-1)!.summary!, /已完成/);
});

test('authoritative completion supersedes prior failures and legacy summaries stay conservative', () => {
  const { manager, snapshot } = fixture(); snapshot.run = manager.newRun('running');
  manager.event(snapshot, 'tool_call', 'execute_vbk_phase', { toolCallId: 'write' });
  manager.result(snapshot, 'write', '请求超时', { error: '超时' });
  manager.event(snapshot, 'assistant', '已完成');
  manager.finish(snapshot, true);
  assert.equal(snapshot.run.status, 'completed');
  const legacy = structuredClone(snapshot); delete legacy.stages;
  delete legacy.events.at(-1)!.data!.completionVerified;
  hydrateAgentStages(legacy);
  assert.doesNotMatch(legacy.stages!.at(-1)!.summary!, /已完成/);
});
