import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/main/infrastructure/database/parts/migrations.js';
import { legacyMigrations, runDatabaseMigrations } from '../../src/main/infrastructure/database/parts/migration-registry.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { legacyProductVersion, approvedPlanVersion } from '../../src/main/application/product-approval-projection.js';
import { requiredAgentPhases } from '../../src/main/agent/integration-gates.js';
import type { AgentSnapshot } from '../../src/shared/contracts-agent.js';

function migrate(change: (snapshot: AgentSnapshot) => void = () => undefined,
  configure: (db: Database.Database, id: string) => void = () => undefined) {
  const db = new Database(':memory:');
  applyMigrations(db, legacyMigrations);
  const detail = buildProductSnapshot({ destination: '成都', days: 2, productForm: 'privateTour' });
  detail.productId = 'remote-mother';
  detail.product.diagnostics = { routeAdministrativeNodes: [{ districtId: 1 }], message: '阶段中断' };
  const approval = { id: 'original-approval', status: 'approved', productVersion: legacyProductVersion(detail),
    accountKey: 'vbk_account', intentVersion: 'intent', createdAt: 'original-time',
    scope: requiredAgentPhases(detail).map(phase => `vbk.write_phase:${phase}`) };
  const snapshot = { localProductId: detail.id, run: { id: 'run', intentVersion: 'intent', status: 'paused' },
    events: [{ id: 'original-event', type: 'approval', runId: 'run', data: { approval } }] } as unknown as AgentSnapshot;
  change(snapshot);
  db.prepare('INSERT INTO products(id,name,status,product_id,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(detail.id, detail.name, 'automating', detail.productId, JSON.stringify(detail.product), 'original-time', 'original-time');
  db.prepare('INSERT INTO local_product_state VALUES(?,?,?,?)').run(detail.id, 42, 1, JSON.stringify({ vbkAccount: 'vbk_account' }));
  db.prepare('INSERT INTO agent_snapshots VALUES(?,?,?)').run(detail.id, JSON.stringify(snapshot), 'original-time');
  const checkpoint = { id: 'checkpoint', status: 'failed', phases: [{ phase: 'basic', status: 'completed' }] };
  db.prepare('INSERT INTO automation_runs VALUES(?,?,?,?,?)').run(checkpoint.id, detail.id, JSON.stringify(checkpoint), 'old', 'old');
  configure(db, detail.id);
  try {
    runDatabaseMigrations(db);
    const result = JSON.parse((db.prepare('SELECT snapshot_json FROM agent_snapshots').get() as { snapshot_json: string }).snapshot_json);
    assert.equal(result.events.length, snapshot.events.length);
    const original = result.events.find((event: { id: string }) => event.id === 'original-event');
    assert.equal(original.data.approval.id, approval.id);
    assert.equal(original.data.approval.createdAt, approval.createdAt);
    assert.deepEqual(JSON.parse((db.prepare('SELECT payload_json FROM automation_runs').get() as { payload_json: string }).payload_json), checkpoint);
    return { snapshot: result as AgentSnapshot, version: approvedPlanVersion(detail) };
  } finally { db.close(); }
}

test('equivalent historical approval keeps its identity, time, scope and checkpoint without a new event', () => {
  const { snapshot, version } = migrate();
  const approval = snapshot.events[0]!.data!.approval as Record<string, unknown>;
  assert.equal(approval.status, 'approved');
  assert.equal(approval.productVersion, version);
  assert.ok(approval.migrationProof);
});

test('an unrelated historical approval cannot pause a current equivalent run', () => {
  const { snapshot } = migrate(snapshot => {
    snapshot.run!.status = 'running';
    const old = structuredClone(snapshot.events[0]!);
    old.id = 'older-event'; old.runId = 'older-run';
    snapshot.events.unshift(old);
  });
  assert.equal(snapshot.run!.status, 'running');
  assert.equal((snapshot.events[0]!.data!.approval as Record<string, unknown>).status, 'invalidated');
  assert.equal((snapshot.events[1]!.data!.approval as Record<string, unknown>).status, 'approved');
});

test('unsupported scope and an unresolved dispatched tool require historical authorization confirmation', () => {
  for (const change of [
    (snapshot: AgentSnapshot) => { (snapshot.events[0]!.data!.approval as { scope: string[] }).scope.push('vbk.publish'); },
    (snapshot: AgentSnapshot) => { snapshot.events.push({ id: 'dispatch', runId: 'run', type: 'status',
      content: '已发出', createdAt: 'old', data: { writeDispatch: true, toolCallId: 'unfinished' } }); },
  ]) {
    const { snapshot } = migrate(change);
    assert.equal((snapshot.events[0]!.data!.approval as Record<string, unknown>).status, 'invalidated');
  }
});

test('a running platform journal is uncertain even without an Agent uncertainty flag', () => {
  const { snapshot } = migrate(() => undefined, (db, id) => {
    db.prepare('INSERT INTO automation_runs VALUES(?,?,?,?,?)').run('interrupted', id,
      JSON.stringify({ id: 'interrupted', status: 'running', phases: [{ phase: 'basic', status: 'running' }] }), 'new', 'new');
  });
  assert.equal((snapshot.events[0]!.data!.approval as Record<string, unknown>).status, 'invalidated');
  assert.equal(snapshot.run!.status, 'paused');
});

test('wrong old fingerprint, changed account, incomplete scope and uncertain write require confirmation', () => {
  for (const change of [
    (snapshot: AgentSnapshot) => { (snapshot.events[0]!.data!.approval as Record<string, unknown>).productVersion = 'wrong'; },
    (snapshot: AgentSnapshot) => { (snapshot.events[0]!.data!.approval as Record<string, unknown>).accountKey = 'other'; },
    (snapshot: AgentSnapshot) => { (snapshot.events[0]!.data!.approval as Record<string, unknown>).scope = ['vbk.write_phase:basic']; },
    (snapshot: AgentSnapshot) => { snapshot.uncertainWrite = { toolCallId: 'write', createdAt: 'old', message: '超时' }; },
  ]) {
    const { snapshot } = migrate(change);
    const approval = snapshot.events[0]!.data!.approval as Record<string, unknown>;
    assert.equal(approval.status, 'invalidated');
    assert.equal(approval.migrationProof, undefined);
    assert.equal(snapshot.run!.status, 'paused');
  }
});
