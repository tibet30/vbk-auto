import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createWorkflowTask, completeWorkflowTaskForProduct, completeSavedProductWorkflowTasks, getWorkflowTask, updateWorkflowTask } from '../../src/main/infrastructure/database/parts/workflow-tasks.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_tasks(id TEXT PRIMARY KEY,local_product_id TEXT,product_name TEXT,status TEXT,stage TEXT,progress INTEGER,message TEXT,error TEXT,created_at TEXT,updated_at TEXT,started_at TEXT,completed_at TEXT);
    CREATE TABLE products(id TEXT,status TEXT,product_id TEXT,product_json TEXT);
    CREATE TABLE agent_snapshots(local_product_id TEXT,snapshot_json TEXT);
    CREATE TABLE automation_runs(local_product_id TEXT,payload_json TEXT,updated_at TEXT);`);
  const product = { id: 'local', status: 'draft_saved', productId: '79346484' } as const;
  db.prepare('INSERT INTO products VALUES(?,?,?,?)').run(product.id, product.status, product.productId, '{}');
  const task = createWorkflowTask(db, product.id, '西安6天5晚私家团');
  return { db, product, task };
}
function pending(db: Database.Database, status = 'paused', reason = '当前产品未匹配玩法线路') {
  db.prepare('INSERT INTO agent_snapshots VALUES(?,?)').run('local', JSON.stringify({ run: { status } }));
  db.prepare('INSERT INTO automation_runs VALUES(?,?,?)').run('local', JSON.stringify({ phases: [{ phase: 'preflight', status: 'completed' }], trafficLine: { children: [{ verified: false, failureReason: reason }] } }), 'now');
}

test('启动/列表刷新不能把仍暂停等待线路审核的母草稿收敛为全部完成', () => {
  const { db, product, task } = fixture();
  try {
    completeWorkflowTaskForProduct(db, product); // reproduce old premature convergence
    assert.equal(getWorkflowTask(db, task.id)!.status, 'succeeded');
    pending(db);
    const restored = completeSavedProductWorkflowTasks(db)[0]!;
    assert.equal(restored.status, 'needs_attention');
    assert.equal(restored.progress, 99);
    assert.equal(restored.completedAt, undefined);
    assert.match(restored.message, /交通套餐待玩法线路匹配审核/);
    assert.deepEqual(completeSavedProductWorkflowTasks(db), [], 'repeat refresh is idempotent');
    db.prepare('UPDATE agent_snapshots SET snapshot_json=?').run(JSON.stringify({ run: { status: 'completed' } }));
    db.prepare('UPDATE automation_runs SET payload_json=?').run(JSON.stringify({ trafficLine: { children: [{ verified: true }] } }));
    assert.equal(completeWorkflowTaskForProduct(db, product)!.status, 'succeeded');
  } finally { db.close(); }
});

test('Agent结束不能掩盖未核验交通，可售资源跳过和永久封存保持终态', () => {
  for (const [status, reason, abandoned] of [['completed', '当前产品未匹配玩法线路', false], ['paused', '当前无可售资源', false], ['paused', '当前产品未匹配玩法线路', true]] as const) {
    const { db, product, task } = fixture();
    try {
      if (abandoned) updateWorkflowTask(db, task.id, { status: 'abandoned' });
      pending(db, status, reason);
      completeSavedProductWorkflowTasks(db);
      assert.equal(getWorkflowTask(db, task.id)!.status, abandoned ? 'abandoned' : status === 'completed' ? 'needs_attention' : 'succeeded');
    } finally { db.close(); }
  }
});

test('交通恢复运行中也不能被母草稿提前收敛成100%，子产品最终核验后才完成', () => {
  const { db, product, task } = fixture();
  try {
    completeWorkflowTaskForProduct(db, product);
    pending(db, 'running');
    completeSavedProductWorkflowTasks(db);
    assert.equal(getWorkflowTask(db, task.id)!.status, 'running');
    assert.equal(getWorkflowTask(db, task.id)!.progress, 99);
    db.prepare('UPDATE automation_runs SET payload_json=?').run(JSON.stringify({ trafficLine: { children: [{ verified: true }] } }));
    assert.equal(completeWorkflowTaskForProduct(db, product)!.status, 'succeeded');
  } finally { db.close(); }
});

test('平台异步核验超时也保留待处理状态，不能冒充无可售资源跳过', () => {
  const { db, task } = fixture();
  try {
    pending(db, 'paused', '子产品资源提交仍在 VBK 异步核验');
    completeSavedProductWorkflowTasks(db);
    assert.equal(getWorkflowTask(db, task.id)!.status, 'needs_attention');
    assert.match(getWorkflowTask(db, task.id)!.message, /尚未通过最终回读/);
  } finally { db.close(); }
});
