import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { evaluatePreparationCompletion } from '../../src/main/planning/preparation-completion.js';
import { runFullPreparation } from '../../scripts/product-regression/full-flow.js';
import { loadCase } from '../../scripts/product-regression/corpus.js';
import { loadProviderReplay } from '../../scripts/product-regression/provider-replay.js';
import { forbidNetwork } from '../../scripts/product-regression/isolation.js';

test('必要酒店回放缺失时，生产准备循环不能形成录入审批', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-11T04:00:00Z') });
  const isolation = forbidNetwork();
  const root = mkdtempSync(path.join(os.tmpdir(), 'vbk-missing-provider-'));
  const db = new VbkDatabase(root);
  context.after(() => { db.close(); rmSync(root, { recursive: true, force: true });
    isolation.restore(); assert.deepEqual(isolation.attempts, []); });
  const provider = loadProviderReplay('xian');
  provider.lists = [];
  const result = await runFullPreparation(db, loadCase('xian'), root, provider);
  assert.ok(result.misses.some(query => query.startsWith('hotel-list:')));
  assert.equal(evaluatePreparationCompletion(result.saved).ready, false);
  assert.notEqual(result.snapshot.run?.status, 'waiting_approval');
  assert.equal(Boolean(result.snapshot.pendingApproval), false);
  assert.deepEqual(result.blockedWrites, []);
});
