import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runDatabaseMigrations } from '../../src/main/infrastructure/database/parts/migration-registry.js';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { verifiedAutomation } from '../helpers/verified-automation.js';
import { createWorkflowTask, completeWorkflowTaskForProduct, completeSavedProductWorkflowTasks, getWorkflowTask, updateWorkflowTask } from '../../src/main/infrastructure/database/parts/workflow-tasks.js';

function fixture() {
  const db = new Database(':memory:');
  runDatabaseMigrations(db);
  const detail = buildProductSnapshot({ destination: '成都', days: 1, productForm: 'privateTour' });
  detail.id = 'local'; detail.status = 'draft_saved'; detail.productId = '79346484';
  const proof = verifiedAutomation(detail);
  db.prepare('INSERT INTO products(id,name,status,product_id,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(detail.id, detail.name, detail.status, detail.productId, JSON.stringify(detail.product), 'old', 'old');
  db.prepare('INSERT INTO automation_runs VALUES(?,?,?,?,?)').run('proof', detail.id, JSON.stringify(proof), 'old', 'old');
  const product = detail;
  const task = createWorkflowTask(db, product.id, '西安6天5晚私家团');
  return { db, product, task };
}
function pending(db: Database.Database, status = 'paused', reason = '当前产品未匹配玩法线路') {
  db.prepare('INSERT INTO agent_snapshots VALUES(?,?,?)').run('local', JSON.stringify({ localProductId: 'local', events: [],
    run: { id: 'run', status, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' } }), 'old');
  const proof = JSON.parse((db.prepare('SELECT payload_json FROM automation_runs').get() as {payload_json: string}).payload_json);
  proof.trafficLine = { children: [{ variant: 'trainRoundTrip', verified: false, completedStages: [], failureReason: reason }] };
  db.prepare('UPDATE automation_runs SET payload_json=?').run(JSON.stringify(proof));
}

test('启动/列表刷新不能把仍暂停等待线路审核的母草稿收敛为全部完成', () => {
  const { db, product, task } = fixture();
  try {
    completeWorkflowTaskForProduct(db, product); // reproduce old premature convergence
    assert.equal(getWorkflowTask(db, task.id)!.status, 'succeeded');
    pending(db);
    const restored = completeSavedProductWorkflowTasks(db)[0]!;
    assert.equal(restored.status, 'needs_attention');
    assert.ok(restored.progress < 100);
    assert.equal(restored.completedAt, undefined);
    assert.match(restored.message, /交通套餐尚未通过最终回读/);
    assert.deepEqual(completeSavedProductWorkflowTasks(db), [], 'repeat refresh is idempotent');
    db.prepare('UPDATE agent_snapshots SET snapshot_json=?').run(JSON.stringify({ localProductId: 'local', events: [], run: { id: 'run', status: 'completed', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' } }));
    db.prepare("UPDATE automation_runs SET payload_json=json_set(payload_json,'$.trafficLine.children',json(?))").run(JSON.stringify([{ variant: 'trainRoundTrip', verified: true, completedStages: ['finalReadback'] }]));
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
    assert.ok(getWorkflowTask(db, task.id)!.progress < 100);
    db.prepare("UPDATE automation_runs SET payload_json=json_set(payload_json,'$.trafficLine.children',json(?))").run(JSON.stringify([{ variant: 'trainRoundTrip', verified: true, completedStages: ['finalReadback'] }]));
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
