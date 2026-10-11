import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { ProductCommandConflict } from '../../src/main/application/product-command-service.js';
import { makeAutomationRunContext } from '../../src/main/automation/automation.main/automation.main.make-context.js';
import { writeAutomationProduct } from '../../src/main/automation/automation.main/automation.main.persist.js';
import { approvedWorkflowPlan } from '../../src/main/automation/automation.main/runtime/workflow-plan.js';
import { refreshSupplierProductCodeForPlatformWrite } from '../../src/main/automation/automation.main/automation.main.class.helpers.js';
import { agentProductVersion, requiredAgentPhases } from '../../src/main/agent/integration-gates.js';
import { assertAgentWriteAuthorized } from '../../src/main/agent/integration-guard.js';
import type { AgentSnapshot, AutomationRun } from '../../src/shared/contracts.js';

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-save-conflict-'));
  const db = new VbkDatabase(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const product = db.createProduct({ destination: '潮汕', days: 5, productForm: 'privateTour' });
  db.attachLocalProductState({ ...product, vbkAccount: 'account' }, 42, 1);
  const current = db.getProduct(product.id)!;
  db.saveAgentSnapshot({ localProductId: product.id, run: { id: 'run', status: 'running',
    intentVersion: 'intent', createdAt: 'old', updatedAt: 'old' }, events: [{ id: 'approved', type: 'approval',
    runId: 'run', content: '确认', createdAt: 'old', data: { approval: { id: 'approval', status: 'approved',
      accountKey: 'account', intentVersion: 'intent', createdAt: 'old', productVersion: agentProductVersion(current),
      scope: requiredAgentPhases(current).map(phase => `vbk.write_phase:${phase}`) } } }] } as AgentSnapshot);
  const ctx = makeAutomationRunContext({ db, localProductId: product.id, browser: {} as never,
    cancellationRequested: new Set(), exclusive: task => task(), emit: () => undefined, advisor: async () => ({} as never) });
  return { db, id: product.id, ctx, mutations: new ProductMutationService(db) };
}

const failedBasic = (): AutomationRun => ({ id: 'automation', status: 'failed', currentPhase: 'basic', logs: [],
  phases: [{ phase: 'basic', status: 'failed' }, { phase: 'presentation', status: 'pending' }],
  recovery: { phases: { saleControl: { phase: 'saleControl', state: 'completed', attempts: [] },
    basic: { phase: 'basic', state: 'needs_user', attempts: [], finalError: '旧保存冲突' } } } });

// No browser or provider is connected: exercise the production persistence sequence only.
test('shell checkpoint diagnostics do not conflict with supplier-code persistence or recreate the shell', t => {
  const { db, id, ctx } = fixture(t);
  const baseline = db.getProduct(id)!;
  writeAutomationProduct(ctx, id, baseline.product, 'automating');
  db.setProductId(id, '79564397');
  db.saveAutomation(id, failedBasic()); // Production synchronization adds debugSnapshot.productId.
  const latestDiagnostics = structuredClone(db.getProduct(id)!.product.diagnostics);
  const next = structuredClone(baseline.product);
  const code = refreshSupplierProductCodeForPlatformWrite(next, { displayName: '测试管家' } as never, '79564397');
  assert.ok(code?.endsWith('-P79564397'));
  writeAutomationProduct(ctx, id, next, 'automating');
  const saved = db.getProduct(id)!;
  assert.deepEqual(saved.product.diagnostics, latestDiagnostics);
  assert.equal((saved.product.basicInfo as Record<string, unknown>).supplierProductCode, code);
  assert.equal(saved.productId, '79564397');
  assert.equal(saved.basicInfoSaved, false);
  assert.deepEqual(approvedWorkflowPlan(saved), { kind: 'run', retryFrom: 'basic' });
  assert.doesNotThrow(() => assertAgentWriteAuthorized(saved, db.getAgentSnapshot(id), 'basic', 'account'));
});

test('conflicting operator edits retain their value and report the exact field without values', t => {
  const { db, id, ctx, mutations } = fixture(t);
  const before = db.getProduct(id)!;
  mutations.commands.mergeChanges(id, before, { ...before.product, basicInfo: { ...before.product.basicInfo as object,
    supplierProductCode: '人工编号' } }, 'user');
  const next = structuredClone(before.product);
  (next.basicInfo as Record<string, unknown>).supplierProductCode = '自动编号';
  assert.throws(() => writeAutomationProduct(ctx, id, next), error => {
    assert.ok(error instanceof ProductCommandConflict);
    assert.deepEqual(error.fieldPath, ['basicInfo', 'supplierProductCode']);
    assert.match(error.message, /basicInfo.supplierProductCode/);
    assert.doesNotMatch(error.message, /人工编号|自动编号/);
    return true;
  });
  assert.equal((db.getProduct(id)!.product.basicInfo as Record<string, unknown>).supplierProductCode, '人工编号');
});

test('two product contexts retain independent baselines, shell identities and execution diagnostics', t => {
  const { db, id, ctx } = fixture(t);
  const other = db.createProduct({ destination: '成都', days: 2, productForm: 'freeTravel' });
  const otherCtx = makeAutomationRunContext({ db, localProductId: other.id, browser: {} as never,
    cancellationRequested: new Set(), exclusive: task => task(), emit: () => undefined, advisor: async () => ({} as never) });
  const first = db.getProduct(id)!;
  const second = db.getProduct(other.id)!;
  db.setProductId(id, '79564397');
  db.setProductId(other.id, 'other-shell');
  db.saveAutomation(id, failedBasic());
  const secondRun = failedBasic(); secondRun.id = 'other-automation';
  db.saveAutomation(other.id, secondRun);
  writeAutomationProduct(otherCtx, other.id, { ...second.product, basicInfo: { ...second.product.basicInfo as object,
    subtitle: '另一产品新文案' } });
  const otherBefore = db.getProduct(other.id)!;
  writeAutomationProduct(ctx, id, { ...first.product, basicInfo: { ...first.product.basicInfo as object,
    supplierProductCode: '本产品编号' } });
  assert.deepEqual(db.getProduct(other.id), otherBefore);
  assert.equal(db.getProduct(id)!.productId, '79564397');
  assert.equal(db.getProduct(other.id)!.productId, 'other-shell');
  assert.equal((db.getProduct(id)!.product.basicInfo as Record<string, unknown>).supplierProductCode, '本产品编号');
});
