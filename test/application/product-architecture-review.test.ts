import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { agentProductVersion, requiredAgentPhases } from '../../src/main/agent/integration-gates.js';
import { assertAgentWriteAuthorized } from '../../src/main/agent/integration-guard.js';
import { applyMigrations } from '../../src/main/infrastructure/database/parts/migrations.js';
import { legacyMigrations, runDatabaseMigrations } from '../../src/main/infrastructure/database/parts/migration-registry.js';
import { makeAutomationRunContext } from '../../src/main/automation/automation.main/automation.main.make-context.js';
import { PlatformOperationService } from '../../src/main/application/platform-operation-service.js';
import { PlatformOperationError } from '../../src/main/application/platform-operation-service.js';
import type { AgentSnapshot, AutomationRun } from '../../src/shared/contracts.js';
import { persistReconciledPhase, settleReconciledDispatches } from '../../src/main/application/product-reconciled-phase.js';
import { approvedWorkflowPlan } from '../../src/main/automation/automation.main/runtime/workflow-plan.js';

function fixture(task: (db: VbkDatabase, id: string, mutations: ProductMutationService) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-review-'));
  const db = new VbkDatabase(dir);
  try {
    const product = db.createProduct({ destination: '成都', days: 2, productForm: 'privateTour' });
    db.attachLocalProductState({ ...product, vbkAccount: 'account' }, 42, 1);
    const current = db.getProduct(product.id)!;
    db.saveAgentSnapshot({ localProductId: product.id, run: { id: 'run', status: 'running',
      intentVersion: 'intent', createdAt: 'old', updatedAt: 'old' }, events: [{ id: 'approved', type: 'approval',
      runId: 'run', content: '确认', createdAt: 'old', data: { approval: { id: 'approval', status: 'approved',
        accountKey: 'account', intentVersion: 'intent', createdAt: 'old', productVersion: agentProductVersion(current),
        scope: requiredAgentPhases(current).map(phase => `vbk.write_phase:${phase}`) } } }] } as AgentSnapshot);
    task(db, product.id, new ProductMutationService(db));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('controlled automation advances the matching approval in the same transaction and retains its identity', () => fixture((db, id, mutations) => {
  const before = db.getProduct(id)!;
  const next = { ...before.product, basicInfo: { ...before.product.basicInfo as object, subtitle: '合规改写' } };
  mutations.commands.mergeChanges(id, before, next, 'automation');
  const snapshot = db.getAgentSnapshot(id)!;
  const approval = snapshot.events[0]!.data!.approval as { id: string; productVersion: string; createdAt: string };
  assert.equal(approval.id, 'approval'); assert.equal(approval.createdAt, 'old'); assert.equal(snapshot.events.length, 1);
  assert.equal(approval.productVersion, agentProductVersion(db.getProduct(id)!));
  assert.doesNotThrow(() => assertAgentWriteAuthorized(db.getProduct(id)!, snapshot, 'basic', 'account'));
}));

test('controlled writes keep approval aligned with separately stored traffic evidence', () => fixture((db, id, mutations) => {
  let current = db.getProduct(id)!;
  const availability = {
    endpointPlan: { arrivalCity: '成都', departureCity: '成都', resolvedAt: '2026-10-14T08:00:00.000Z',
      train: { arrival: { code: 'CN001CDW', name: '成都东' }, departure: { code: 'CN001CDW', name: '成都东' } } },
    availableVariants: ['trainRoundTrip'], unavailableVariants: {},
  };
  const withTraffic = structuredClone(current.product) as Record<string, any>;
  withTraffic.operations.trafficLine = { enabled: true, variants: ['trainRoundTrip'], availability };
  mutations.commands.mergeChanges(id, current, withTraffic, 'user');
  current = db.getProduct(id)!;
  const snapshot = db.getAgentSnapshot(id)!;
  const preparedApproval = snapshot.events[0]!.data!.approval as { productVersion: string; scope: string[] };
  preparedApproval.productVersion = agentProductVersion(current);
  preparedApproval.scope = requiredAgentPhases(current).map(phase => `vbk.write_phase:${phase}`);
  db.saveAgentSnapshot(snapshot);

  const automated = { ...current.product,
    basicInfo: { ...current.product.basicInfo as object, subtitle: '自动化规范化写回' } };
  mutations.commands.mergeChanges(id, current, automated, 'automation');

  const saved = db.getProduct(id)!;
  const savedSnapshot = db.getAgentSnapshot(id)!;
  const approval = savedSnapshot.events[0]!.data!.approval as { productVersion: string };
  assert.deepEqual((saved.product.operations as Record<string, any>).trafficLine.availability, availability);
  assert.equal(approval.productVersion, agentProductVersion(saved));
  assert.doesNotThrow(() => assertAgentWriteAuthorized(saved, savedSnapshot, 'basic', 'account'));
}));

test('operator changes during a deterministic run cannot be adopted by a later controlled write', () => fixture((db, id, mutations) => {
  const before = db.getProduct(id)!;
  const oldFingerprint = agentProductVersion(before);
  mutations.commands.mergeChanges(id, before, { ...before.product, basicInfo: { ...before.product.basicInfo as object,
    subtitle: '人工新方案' } }, 'user');
  const current = db.getProduct(id)!;
  mutations.commands.mergeChanges(id, current, { ...current.product, presentation: { title: '执行回填' } }, 'automation');
  const snapshot = db.getAgentSnapshot(id)!;
  assert.equal((snapshot.events[0]!.data!.approval as { productVersion: string }).productVersion, oldFingerprint);
  assert.throws(() => assertAgentWriteAuthorized(db.getProduct(id)!, snapshot, 'basic', 'account'), /方案/);
}));

test('failure to persist a controlled approval rolls back the plan and evidence together', () => fixture((db, id, mutations) => {
  const before = db.getProduct(id)!;
  const connection = (db as unknown as { db: Database.Database }).db;
  connection.exec("CREATE TRIGGER fail_approval BEFORE UPDATE ON agent_snapshots BEGIN SELECT RAISE(ABORT,'approval write failed'); END");
  assert.throws(() => mutations.commands.mergeChanges(id, before, { ...before.product,
    basicInfo: { ...before.product.basicInfo as object, subtitle: '回填' } }, 'automation'), /approval write failed/);
  assert.deepEqual(db.getProduct(id)!.product, before.product);
  assert.equal(db.getProduct(id)!.viewRevision, before.viewRevision);
}));

test('automation retains its captured baseline so a late local write cannot overwrite an operator edit', () => fixture((db, id, mutations) => {
  const before = db.getProduct(id)!;
  const ctx = makeAutomationRunContext({ db, localProductId: id, browser: {} as never,
    cancellationRequested: new Set(), exclusive: task => task(), emit: () => undefined, advisor: async () => ({} as never) });
  mutations.commands.mergeChanges(id, before, { ...before.product, basicInfo: { ...before.product.basicInfo as object,
    subtitle: '人工新方案' } }, 'user');
  assert.throws(() => ctx.persistProduct!(id, { ...before.product, basicInfo: { ...before.product.basicInfo as object,
    subtitle: '迟到改写' } }), /目标字段/);
  assert.equal((db.getProduct(id)!.product.basicInfo as { subtitle: string }).subtitle, '人工新方案');
}));

test('restart preserves separate run histories and marks an interrupted platform phase uncertain', () => fixture((db, id) => {
  for (const runId of ['first', 'second']) db.saveAutomation(id, { id: runId, status: 'running',
    currentPhase: 'basic', logs: [], phases: [{ phase: 'basic', status: 'running' }] } as AutomationRun);
  db.recoverOrphanAutomationRuns();
  const connection = (db as unknown as { db: Database.Database }).db;
  const runs = (connection.prepare('SELECT payload_json FROM automation_runs WHERE local_product_id=?').all(id) as { payload_json: string }[])
    .map(row => JSON.parse(row.payload_json) as AutomationRun);
  assert.deepEqual(new Set(runs.map(run => run.id)), new Set(['first', 'second']));
  assert.ok(runs.every(run => run.status === 'failed'));
  assert.equal(db.getAgentSnapshot(id)!.uncertainWrite!.toolCallId, 'phase:basic');
  assert.throws(() => assertAgentWriteAuthorized(db.getProduct(id)!, db.getAgentSnapshot(id), 'basic', 'account'), /状态/);
}));

test('write dispatch provenance is durable before the provider is called', async () => {
  const observations: { id: string; status: string }[] = [];
  const service = new PlatformOperationService((evidence, status) => observations.push({ id: evidence.id, status }));
  await service.write({ source: 'vbk', capability: 'basic', query: {} }, async () => undefined, async () => {
    assert.equal(observations[0]!.status, 'write_dispatched'); return 'returned';
  });
  assert.equal(observations[1]!.status, 'write_returned');
  assert.equal(observations[0]!.id, observations[1]!.id);
});

test('a returned write whose result cannot be persisted remains uncertain', async () => {
  let writes = 0;
  const service = new PlatformOperationService((_evidence, status) => { if (status === 'write_returned') throw new Error('disk failure'); });
  await assert.rejects(service.write({ source: 'vbk', capability: 'basic', query: {} }, async () => undefined,
    async () => { writes++; return 'returned'; }), error => error instanceof PlatformOperationError && error.uncertainWrite);
  assert.equal(writes, 1);
});

test('restart also detects an unmatched dispatch in an already failed journal', () => fixture((db, id) => {
  db.recordResourceObservation(id, { id: 'unmatched-write', source: 'vbk', capability: 'write_phase:basic',
    observedAt: 'old', queryFingerprint: 'query', status: 'write_dispatched' });
  db.saveAutomation(id, { id: 'failed', status: 'failed', phases: [{ phase: 'basic', status: 'failed' }], logs: [] });
  db.recoverOrphanAutomationRuns();
  assert.equal(db.getAgentSnapshot(id)!.uncertainWrite!.toolCallId, 'phase:basic');
  settleReconciledDispatches(db, id, 'basic');
  const snapshot = db.getAgentSnapshot(id)!;
  snapshot.uncertainWrite = undefined;
  db.saveAgentSnapshot(snapshot);
  db.recoverOrphanAutomationRuns();
  assert.equal(db.getAgentSnapshot(id)!.uncertainWrite, undefined);
}));

test('verified phase readback saves the checkpoint and resumes only the next pending phase', () => fixture((db, id) => {
  db.setProductId(id, 'remote');
  db.saveAutomation(id, { id: 'interrupted', status: 'failed', currentPhase: 'basic', logs: [],
    phases: [{ phase: 'basic', status: 'failed' }, { phase: 'presentation', status: 'pending' }],
    recovery: { phases: { basic: { phase: 'basic', state: 'needs_user', attempts: [], finalError: '中断' } } } });
  persistReconciledPhase(db, id, 'basic');
  const product = db.getProduct(id)!;
  assert.equal(product.basicInfoSaved, true);
  assert.equal(product.automation!.phases[0]!.status, 'completed');
  assert.equal(product.automation!.recovery!.phases.basic!.state, 'completed');
  assert.deepEqual(approvedWorkflowPlan(product), { kind: 'run', retryFrom: 'presentation' });
}));

test('invalid historical research evidence rolls back all architecture changes', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db, legacyMigrations);
    db.prepare('INSERT INTO research_tasks VALUES(?,?,?,?,?,?,?,?)').run('broken-research', 'product', '核查', 'poi', 'pending', 'pending', '', '{bad');
    assert.throws(() => runDatabaseMigrations(db), /research_tasks\/broken-research/);
    assert.equal(db.prepare("SELECT 1 FROM migrations WHERE id='0017_product_architecture'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='product_resource_evidence'").get(), undefined);
  } finally { db.close(); }
});

test('an existing SQLite file without a migration registry is backed up before any schema changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-review-backup-'));
  const db = new Database(path.join(dir, 'legacy.sqlite'));
  try {
    db.exec("CREATE TABLE preserved_extension(value TEXT); INSERT INTO preserved_extension VALUES('original')");
    runDatabaseMigrations(db);
    const backups = fs.readdirSync(dir).filter(name => name.includes('before-architecture'));
    assert.equal(backups.length, 1);
    const backup = new Database(path.join(dir, backups[0]!));
    try {
      assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='migrations'").get(), undefined);
      assert.deepEqual(backup.prepare('SELECT value FROM preserved_extension').get(), { value: 'original' });
    } finally { backup.close(); }
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
