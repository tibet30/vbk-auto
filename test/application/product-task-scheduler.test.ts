import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductTaskScheduler } from '../../src/main/application/product-task-scheduler.js';
import type { AgentSnapshot, ProductWorkflowTask } from '../../src/shared/contracts.js';

function fixture(status: ProductWorkflowTask['status'] = 'needs_attention') {
  let task = { id: 'task', localProductId: 'product', productName: '产品', status, stage: 'planning',
    progress: 25, message: '任意展示文案', createdAt: '2026-01-01', updatedAt: '2026-01-01' } as ProductWorkflowTask;
  const calls: string[] = [];
  let snapshot: AgentSnapshot = { localProductId: 'product', events: [], run: {
    id: 'run', status: 'paused', createdAt: '2026-01-01', updatedAt: '2026-01-01' } };
  let productId: string | undefined;
  const db = {
    getWorkflowTask: () => task, listWorkflowTasks: () => [task], getProduct: () => ({ productId }),
    createWorkflowTask: () => { task = { ...task, status: 'queued' }; return task; },
    abandonWorkflowTask: () => { task = { ...task, status: 'abandoned' }; return task; },
    updateWorkflowTask: (_id: string, patch: Partial<ProductWorkflowTask>) => { task = { ...task, ...patch }; return task; },
  };
  const scheduler = new ProductTaskScheduler({ db: db as never, agent: {
    get: async () => snapshot,
    send: async (_id, content) => { calls.push(content); return snapshot; },
    resume: async () => { calls.push('resume'); return snapshot; },
    abandon: async () => { calls.push('abandon'); return snapshot; },
  }, emitTask: () => undefined, emitProduct: () => undefined });
  return { scheduler, calls, task: () => task, setSnapshot: (value: AgentSnapshot) => { snapshot = value; },
    setProductId: (id: string) => { productId = id; } };
}

test('enqueue returns queued immediately and sends only an approval-gated Agent intent', async () => {
  const f = fixture();
  assert.equal(f.scheduler.enqueue({ id: 'product', name: '产品' } as never).status, 'queued');
  assert.equal(f.calls.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!, /明确审批/);
});

test('resume uses durable Agent and structured retry mode regardless of message', async () => {
  const f = fixture();
  await f.scheduler.resume('task', 'from_error');
  assert.deepEqual(f.calls, ['resume']);
  assert.equal(f.task().retryMode, 'from_error');
});

test('from-start cannot replay a platform-bound product', async () => {
  const f = fixture(); f.setProductId('remote');
  await assert.rejects(f.scheduler.resume('task', 'from_start'), /不能从头/);
  assert.deepEqual(f.calls, []);
});

test('from-start cannot silently reset an active Agent', async () => {
  const f = fixture();
  await assert.rejects(f.scheduler.resume('task', 'from_start'), /对话中明确/);
  assert.deepEqual(f.calls, []);
});

test('completed Agent recovery creates a continue intent without replaying old orchestration', async () => {
  const f = fixture(); f.setSnapshot({ localProductId: 'product', events: [], run: {
    id: 'run', status: 'completed', createdAt: 'old', updatedAt: 'old' } });
  await f.scheduler.resume('task', 'from_error');
  assert.deepEqual(f.calls, ['继续']);
});

test('abandon persists terminal state before dispatch and is idempotent', async () => {
  const f = fixture('running');
  assert.equal((await f.scheduler.abandon('task')).status, 'abandoned');
  await f.scheduler.abandon('task');
  assert.deepEqual(f.calls, ['abandon']);
  await assert.rejects(f.scheduler.resume('task', 'from_error'), /只有/);
});

test('startup does not create a new Agent run for a queued orphan', async () => {
  const f = fixture('queued'); f.setSnapshot({ localProductId: 'product', events: [], run: null });
  f.scheduler.resumeQueued();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.task().status, 'needs_attention');
  assert.deepEqual(f.calls, []);
});
