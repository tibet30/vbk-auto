import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AgentApproval, AgentSnapshot } from '../../../../shared/contracts-agent.js';
import { canonicalJson, composeProduct, record, splitProduct } from '../../../../shared/product-storage-projection.js';
import { approvedPlanVersion, legacyProductVersion } from '../../../application/product-approval-projection.js';
import type { Migration } from './migrations.js';
import { requiredAgentPhases } from '../../../agent/integration-gates.js';
import { agentApprovalScopeError } from '../../../agent/integration-guard.js';
import type { ProductDetail } from '../../../../shared/contracts.js';

const id = '0017_product_architecture';
export function prepareArchitectureMigration(db: Database.Database): void {
  db.function('vbk_architecture_writer', () => 1);
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'").get();
  if (exists && db.prepare('SELECT 1 FROM migrations WHERE id=?').get(id)) return;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) return;
  if (!db.name || db.name === ':memory:') return;
  const file = `${db.name}.before-architecture-${randomUUID()}.sqlite`;
  // VACUUM INTO includes committed WAL contents and never overwrites a backup.
  db.prepare('VACUUM INTO ?').run(file);
}

function parse(raw: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对象格式错误');
    return value as Record<string, unknown>;
  } catch (error) { throw new Error(`架构迁移无法读取 ${label}: ${String(error)}`); }
}

function migrateApprovals(db: Database.Database, productId: string, before: Record<string, unknown>, after: Record<string, unknown>, remoteId?: string) {
  const row = db.prepare('SELECT snapshot_json FROM agent_snapshots WHERE local_product_id=?').get(productId) as {
    snapshot_json: string;
  } | undefined;
  if (!row) return;
  const snapshot = parse(row.snapshot_json, `Agent ${productId}`) as unknown as AgentSnapshot;
  if (!Array.isArray(snapshot.events)) throw new Error(`架构迁移 Agent 事件格式错误: ${productId}`);
  const meta = db.prepare('SELECT payload_json FROM local_product_state WHERE local_product_id=?').get(productId) as {
    payload_json: string;
  } | undefined;
  const account = meta ? parse(meta.payload_json, `归属 ${productId}`).vbkAccount : undefined;
  const oldVersion = legacyProductVersion({ product: before });
  const version = approvedPlanVersion({ product: after });
  const runs = db.prepare('SELECT payload_json FROM automation_runs WHERE local_product_id=?').all(productId) as { payload_json: string }[];
  const interruptedWrite = runs.some(row => {
    const run = parse(row.payload_json, `录入 ${productId}`);
    return run.status === 'running' && Array.isArray(run.phases)
      && run.phases.some(phase => record(phase).status === 'running');
  });
  const finishedCalls = new Set(snapshot.events.filter(event => event.type === 'tool_result').map(event => event.data?.toolCallId));
  const dispatchedWrite = snapshot.events.some(event => event.data?.writeDispatch === true
    && !finishedCalls.has(event.data.toolCallId));
  const update = (approval: AgentApproval, runId?: string) => {
    if (approval.status !== 'approved' && approval.status !== 'pending') return;
    const equivalent = !snapshot.uncertainWrite && !interruptedWrite && !dispatchedWrite && Boolean(snapshot.run?.intentVersion)
      && approval.intentVersion === snapshot.run?.intentVersion && runId === snapshot.run?.id
      && typeof account === 'string' && Boolean(account) && approval.accountKey === account
      && Array.isArray(approval.scope) && approval.scope.length > 0
      && requiredAgentPhases({ product: before, productId: remoteId } as ProductDetail)
        .every(phase => approval.scope.includes(`vbk.write_phase:${phase}`))
      && !agentApprovalScopeError({ product: before, productId: remoteId } as ProductDetail, approval.scope, { allowSupersededPhases: true })
      && approval.productVersion === oldVersion && canonicalJson(before) === canonicalJson(after);
    if (equivalent) {
      approval.productVersion = version;
      approval.migrationProof = { version: 1, previousFingerprint: oldVersion };
    } else {
      approval.status = 'invalidated';
      if (snapshot.run && runId === snapshot.run.id && !['completed', 'abandoned'].includes(snapshot.run.status)) {
        snapshot.run.status = 'paused';
        snapshot.run.error = '历史授权无法证明等价，请重新确认后继续；已保留录入检查点。';
      }
    }
  };
  for (const event of snapshot.events) {
    const approval = event.data?.approval as AgentApproval | undefined;
    if (approval) update(approval, event.runId);
  }
  if (snapshot.pendingApproval) update(snapshot.pendingApproval, snapshot.run?.id);
  db.prepare('UPDATE agent_snapshots SET snapshot_json=? WHERE local_product_id=?').run(JSON.stringify(snapshot), productId);
}

export const productArchitectureMigration: Migration = {
  id,
  statements: [
    'ALTER TABLE products ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN view_revision INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE workflow_tasks ADD COLUMN retry_mode TEXT',
    'CREATE TABLE product_resource_evidence(local_product_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,evidence_version INTEGER NOT NULL)',
    'CREATE TABLE product_runtime_diagnostics(local_product_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)',
  ],
  migrate(db) {
    // Validate journals before changing any row. Unreadable data aborts the transaction.
    for (const table of ['automation_runs', 'planning_generation', 'local_product_state', 'agent_snapshots']) {
      const column = table === 'planning_generation' ? 'state_json' : table === 'agent_snapshots' ? 'snapshot_json' : 'payload_json';
      for (const row of db.prepare(`SELECT local_product_id,${column} AS json FROM ${table}`).all() as {
        local_product_id: string; json: string;
      }[]) {
        const label = `${table}/${row.local_product_id}`;
        const value = parse(row.json, label);
        if (table === 'agent_snapshots' && !Array.isArray(value.events)) throw new Error(`架构迁移 Agent 事件格式错误: ${label}`);
        if (table === 'automation_runs' && Object.hasOwn(value, 'phases') && (!Array.isArray(value.phases)
          || value.phases.some(phase => typeof record(phase).phase !== 'string' || typeof record(phase).status !== 'string'))) {
          throw new Error(`架构迁移录入阶段格式错误: ${label}`);
        }
      }
    }
    for (const row of db.prepare('SELECT id,evidence_json FROM research_tasks').all() as { id: string; evidence_json: string }[]) {
      try { if (!Array.isArray(JSON.parse(row.evidence_json))) throw new Error('证据必须为数组'); }
      catch (error) { throw new Error(`架构迁移无法读取 research_tasks/${row.id}: ${String(error)}`); }
    }
    const rows = db.prepare('SELECT id,product_id,product_json,product_json_version FROM products').all() as {
      id: string; product_id?: string; product_json: string; product_json_version: number;
    }[];
    for (const row of rows) {
      const before = parse(row.product_json, `产品 ${row.id}`);
      const { plan, evidence, diagnostics } = splitProduct(before, 'legacy');
      const after = composeProduct(plan, evidence, diagnostics);
      if (canonicalJson(before) !== canonicalJson(after)) throw new Error(`产品迁移不等价: ${row.id}`);
      migrateApprovals(db, row.id, before, after, row.product_id);
      db.prepare('INSERT INTO product_resource_evidence VALUES(?,?,0)').run(row.id, JSON.stringify(evidence));
      db.prepare('INSERT INTO product_runtime_diagnostics VALUES(?,?)').run(row.id, JSON.stringify(diagnostics));
      db.prepare('UPDATE products SET product_json=?,plan_version=product_json_version,view_revision=1 WHERE id=?')
        .run(JSON.stringify(plan), row.id);
    }
    db.exec(`UPDATE workflow_tasks SET retry_mode=CASE
      WHEN message='任务将从头开始执行' THEN 'from_start'
      WHEN message='任务将从报错处继续执行' THEN 'from_error' ELSE NULL END`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      db.exec(`CREATE TRIGGER architecture_guard_${name}_${action} BEFORE ${action} ON ${quoted}
        BEGIN SELECT vbk_architecture_writer(); END`);
    }
    db.exec(`CREATE TRIGGER architecture_product_revision AFTER UPDATE ON products
      WHEN NEW.view_revision=OLD.view_revision
      BEGIN UPDATE products SET view_revision=view_revision+1 WHERE id=NEW.id; END`);
    for (const table of ['agent_snapshots', 'automation_runs', 'workflow_tasks', 'research_tasks', 'messages',
      'planning_generation', 'local_product_state', 'product_resource_evidence', 'product_runtime_diagnostics']) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = action === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER architecture_revision_${table}_${action} AFTER ${action} ON ${table}
          BEGIN UPDATE products SET view_revision=view_revision+1 WHERE id=${row}.local_product_id; END`);
      }
    }
  },
};
