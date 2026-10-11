import assert from 'node:assert/strict';
import test from 'node:test';
import { productExecutionView, ProductExecutionService } from '../../src/main/application/product-execution-service.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { draftPhasesFor } from '../../src/main/automation/automation.main/automation.main.phases.js';
import { parseProduct } from '../../src/main/automation/schema/schema.js';

function product() {
  const value = buildProductSnapshot({ destination: '成都', days: 1, productForm: 'groupTour' });
  value.productId = 'remote'; value.status = 'draft_saved';
  Object.assign(value.product.basicInfo!, { subtitle: '成都游览', province: '四川', operationNotes: '按行程安排' });
  Object.assign(value.product.operations!, { pickupCity: '成都' });
  value.product.itinerary = [{ day: 1, title: '成都', spots: [], description: '游览', hotel: '', meals: '自理' }];
  value.automation = { id: 'automation', status: 'succeeded', logs: [],
    phases: draftPhasesFor(parseProduct(value.product)).map(phase => ({ phase, status: 'completed' })) };
  return value;
}

test('product ID and draft status alone cannot replace persisted phase evidence', () => {
  const value = product();
  assert.equal(productExecutionView(value).mother, 'verified');
  value.automation!.phases.find(phase => phase.phase === 'preflight')!.status = 'pending';
  assert.equal(productExecutionView(value).mother, 'pending');
});

test('verified mother and failed traffic child remain separate outcomes', () => {
  const value = product();
  value.automation!.trafficLine = { children: [{ variant: 'trainRoundTrip', lineDescription: '火车往返',
    childProductId: 'child', verified: false, failureReason: '班期失败', completedStages: ['childCreated'] }] };
  value.automation!.status = 'failed';
  value.automation!.currentPhase = 'trafficLine';
  value.automation!.phases.push({ phase: 'trafficLine', status: 'failed' });
  const view = productExecutionView(value);
  assert.equal(view.mother, 'verified'); assert.equal(view.children[0]!.verified, false);
  assert.equal(view.children[0]!.reason, '班期失败');
  assert.equal(view.nextAction, 'resume');
});

test('uncertain write requires verification and cannot turn into task success', () => {
  const value = product();
  const snapshot = { localProductId: value.id, events: [], run: null,
    uncertainWrite: { toolCallId: 'call', message: '结果不明', createdAt: 'old' } };
  let task = { id: 'task', localProductId: value.id, status: 'running', progress: 90 } as never;
  const service = new ProductExecutionService({ getProduct: () => value, getAgentSnapshot: () => snapshot,
    latestWorkflowTaskForProduct: () => task, createWorkflowTask: () => task,
    updateWorkflowTask: (_id, patch) => { task = { ...task, ...patch } as never; return task; } });
  assert.equal(service.read(value.id).nextAction, 'verify_write');
  assert.equal(service.reconcile(value.id)!.status, 'needs_attention');
});

test('an abandoned Agent cannot be projected as succeeded by late verified mother facts', () => {
  const value = product();
  const snapshot = { localProductId: value.id, events: [], run: { id: 'run', status: 'abandoned',
    createdAt: 'old', updatedAt: 'new' } } as never;
  let task = { id: 'task', localProductId: value.id, status: 'running', progress: 90 } as never;
  const service = new ProductExecutionService({ getProduct: () => value, getAgentSnapshot: () => snapshot,
    latestWorkflowTaskForProduct: () => task, createWorkflowTask: () => task,
    updateWorkflowTask: (_id, patch) => { task = { ...task, ...patch } as never; return task; } });
  assert.equal(service.reconcile(value.id)!.status, 'abandoned');
  assert.equal(service.read(value.id).nextAction, 'none');
});
