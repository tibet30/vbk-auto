import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { makeAutomationRunContext } from '../../src/main/automation/automation.main/automation.main.make-context.js';
import { assertAgentWriteAuthorized } from '../../src/main/agent/integration-guard.js';
import { requiredAgentPhases, agentProductVersion } from '../../src/main/agent/integration-gates.js';
import { AutomationCancelledError } from '../../src/main/automation/automation.main/automation.main.errors.js';
import { PlatformOperationError } from '../../src/main/application/platform-operation-service.js';
import type { AgentSnapshot } from '../../src/shared/contracts.js';

async function fixture(run: (db: VbkDatabase, id: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-write-context-'));
  const db = new VbkDatabase(dir);
  try {
    const product = db.createProduct({ destination: '成都', days: 1, productForm: 'privateTour' });
    db.attachLocalProductState({ ...product, vbkAccount: 'vbk_account' }, 42, 1);
    const current = db.getProduct(product.id)!;
    db.saveAgentSnapshot({ localProductId: product.id, run: { id: 'run', status: 'running', intentVersion: 'intent',
      createdAt: '2026-01-01', updatedAt: '2026-01-01' }, events: [{ id: 'approval-event', type: 'approval',
        runId: 'run', content: '同意当前方案', createdAt: '2026-01-01', data: { approval: { id: 'approval', status: 'approved',
          productVersion: agentProductVersion(current), accountKey: 'vbk_account', intentVersion: 'intent',
          scope: requiredAgentPhases(current).map(phase => `vbk.write_phase:${phase}`), createdAt: '2026-01-01' } } }] } as AgentSnapshot);
    await run(db, product.id);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('uncertain deterministic phase write persists Agent recovery fact and blocks a second dispatch', async () => fixture(async (db, id) => {
  let calls = 0;
  const ctx = makeAutomationRunContext({ db, browser: {} as never, emit: () => undefined,
    localProductId: id, cancellationRequested: new Set(), advisor: async () => ({} as never),
    exclusive: task => task(), guard: async (productId, phase) =>
      assertAgentWriteAuthorized(db.getProduct(productId)!, db.getAgentSnapshot(productId), phase, 'vbk_account') });
  const planVersion = db.getProduct(id)!.planVersion;
  await assert.rejects(ctx.runVbkPageExclusive(async () => { calls++; throw new Error('请求超时'); }, 'basic'),
    error => error instanceof PlatformOperationError && error.uncertainWrite);
  assert.equal(db.getAgentSnapshot(id)!.uncertainWrite!.toolCallId, 'phase:basic');
  assert.equal(db.getProduct(id)!.planVersion, planVersion);
  await assert.rejects(ctx.runVbkPageExclusive(async () => { calls++; }, 'basic'), /未处于可录入状态/);
  assert.equal(calls, 1);
}));

test('queued phase checks cancellation and authorization only after entering the page lock', async () => fixture(async (db, id) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const cancelled = new Set<string>(); let authorized = 0; let calls = 0;
  const ctx = makeAutomationRunContext({ db, browser: {} as never, emit: () => undefined,
    localProductId: id, cancellationRequested: cancelled, advisor: async () => ({} as never),
    exclusive: async task => { await ready; return task(); }, guard: async () => { authorized++; } });
  const pending = ctx.runVbkPageExclusive(async () => { calls++; }, 'basic');
  cancelled.add(id); release();
  await assert.rejects(pending, AutomationCancelledError);
  assert.equal(authorized, 0); assert.equal(calls, 0);
}));
