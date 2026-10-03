import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("产品改名与关联任务标题在同一次写入中同步，冲突不改变任务", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-product-name-"));
  const db = new VbkDatabase(directory);
  try {
    const product = db.createProduct({ destination: "日喀则", days: 2, productForm: "privateTour" });
    const task = db.createWorkflowTask(product.id, "日喀则2天1晚私家团");
    const other = db.createProduct({ destination: "成都", days: 2, productForm: "privateTour" });
    const otherTask = db.createWorkflowTask(other.id, "成都2天1晚私家团");
    const next = { ...product.product, basicInfo: { ...product.product.basicInfo, supplierProductName: "日喀则3天2晚私家团" } };
    db.updateProduct(product.id, next, "review", product.productJsonVersion);
    assert.equal(db.getProduct(product.id)!.name, "日喀则3天2晚私家团");
    assert.equal(db.latestWorkflowTaskForProduct(product.id)!.productName, "日喀则3天2晚私家团");
    assert.equal(db.latestWorkflowTaskForProduct(product.id)!.updatedAt, task.updatedAt);
    assert.equal(db.latestWorkflowTaskForProduct(other.id)!.productName, otherTask.productName);
    assert.throws(() => db.updateProduct(product.id, {
      ...next, basicInfo: { ...next.basicInfo, supplierProductName: "过期改名" },
    }, "planning", product.productJsonVersion), /产品内容已变更/);
    assert.equal(db.latestWorkflowTaskForProduct(product.id)!.productName, "日喀则3天2晚私家团");
    assert.equal(db.getProduct(product.id)!.status, "review");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
