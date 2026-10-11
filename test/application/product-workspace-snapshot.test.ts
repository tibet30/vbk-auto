import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { readProductWorkspaceSnapshot } from '../../src/main/application/product-workspace-snapshot.js';

test('workspace reads are consistent and never repair business state or increment revision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbk-workspace-'));
  const db = new VbkDatabase(dir);
  try {
    const product = db.createProduct({ destination: '成都', days: 1, productForm: 'privateTour' });
    db.attachLocalProductState(product, 42, 1);
    const task = db.createWorkflowTask(product.id, product.name);
    db.updateWorkflowTask(task.id, { status: 'abandoned', message: '运营已放弃' });
    const revision = db.getProduct(product.id)!.viewRevision;
    const first = readProductWorkspaceSnapshot(db, product.id, () => ({ ready: false, issues: [] }) as never);
    const second = readProductWorkspaceSnapshot(db, product.id, () => ({ ready: false, issues: [] }) as never);
    assert.deepEqual(first, second);
    assert.equal(first.ownerUserId, 42);
    assert.equal(first.execution.nextAction, 'none');
    assert.equal(first.product.workflowTask!.status, 'abandoned');
    assert.equal(db.getProduct(product.id)!.viewRevision, revision);
    db.addMessage(product.id, 'assistant', '后台消息');
    const reopened = readProductWorkspaceSnapshot(db, product.id, () => ({ ready: false, issues: [] }) as never);
    assert.ok(reopened.viewRevision > first.viewRevision);
    assert.equal(reopened.product.messages.at(-1)!.content, '后台消息');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
