import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("workflow task 持久化生命周期并按创建时间列出", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-workflow-task-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "丽江", days: 6, productForm: "privateTour" });
    const queued = db.createWorkflowTask(product.id, product.name);

    assert.equal(queued.status, "queued");
    assert.equal(db.latestWorkflowTaskForProduct(product.id)?.id, queued.id);

    const running = db.updateWorkflowTask(queued.id, {
      status: "running",
      stage: "planning",
      progress: 8,
      message: "正在生成并核验产品方案",
      startedAt: "2026-08-31T00:00:00.000Z",
    });
    assert.equal(running.progress, 8);
    assert.equal(db.listWorkflowTasks()[0].stage, "planning");

    const recovered = db.recoverOrphanWorkflowTasks();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "needs_attention");
    assert.match(recovered[0].error ?? "", /应用退出/);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("运行中的 workflow task 阻止删除产品，结束后随产品一并删除", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-workflow-delete-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
    const task = db.createWorkflowTask(product.id, product.name);
    assert.throws(() => db.deleteProduct(product.id), /后台任务正在处理/);

    db.updateWorkflowTask(task.id, {
      status: "succeeded",
      stage: "completed",
      progress: 100,
      message: "已完成",
      completedAt: new Date().toISOString(),
    });
    assert.equal(db.deleteProduct(product.id), true);
    assert.equal(db.getWorkflowTask(task.id), undefined);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("永久废弃 workflow task 幂等持久化并保留关联产品", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-workflow-abandon-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "昆明", days: 2, productForm: "privateTour" });
    const queued = db.createWorkflowTask(product.id, product.name);

    const abandoned = db.abandonWorkflowTask(queued.id);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.message, "任务已永久废弃");
    assert.ok(abandoned.completedAt);
    assert.equal(db.abandonWorkflowTask(queued.id).updatedAt, abandoned.updatedAt, "重复废弃不能改写首个终态");
    assert.equal(db.updateWorkflowTask(queued.id, { status: "queued" }).status, "abandoned", "底层更新也不能复活任务");
    assert.ok(db.getProduct(product.id), "废弃任务不能删除关联产品");
    assert.equal(db.recoverOrphanWorkflowTasks().length, 0, "重启恢复不能重新激活废弃任务");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("产品草稿保存后把最近任务收敛为成功，且迟到回调不能回退", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-workflow-complete-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "北京", days: 2, productForm: "privateTour" });
    const task = db.createWorkflowTask(product.id, product.name);
    db.updateWorkflowTask(task.id, {
      status: "needs_attention",
      stage: "planning",
      progress: 45,
      message: "任务已暂停，请打开产品处理待确认项",
      error: "未命中可确认的真实 POI",
    });
    db.setProductLifecycle(product.id, { productId: "77832354", status: "draft_saved", basicInfoSaved: true });

    const [completed] = db.completeSavedProductWorkflowTasks();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.stage, "completed");
    assert.equal(completed.progress, 100);
    assert.equal(completed.error, undefined);
    assert.match(completed.message, /草稿已保存/);

    const late = db.updateWorkflowTask(task.id, {
      status: "needs_attention",
      stage: "planning",
      progress: 45,
      error: "迟到的规划失败",
    });
    assert.equal(late.status, "succeeded");
    assert.equal(late.progress, 100);
    assert.equal(db.completeSavedProductWorkflowTasks().length, 0, "重复修复必须幂等");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("已永久废弃的任务不因产品后来保存而被改写", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-workflow-abandoned-complete-"));
  try {
    const db = new VbkDatabase(dataPath);
    const product = db.createProduct({ destination: "北京", days: 2, productForm: "privateTour" });
    const task = db.createWorkflowTask(product.id, product.name);
    db.abandonWorkflowTask(task.id);
    db.setProductLifecycle(product.id, { productId: "77832354", status: "draft_saved" });

    assert.equal(db.completeSavedProductWorkflowTasks().length, 0);
    assert.equal(db.getWorkflowTask(task.id)?.status, "abandoned");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
