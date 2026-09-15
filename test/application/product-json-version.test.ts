import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("product_json 写入递增版本号，过期版本被拒绝", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-json-version-"));
  const db = new VbkDatabase(dataPath);
  try {
    const created = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
    assert.equal(created.productJsonVersion, 0);

    db.updateProduct(created.id, { ...created.product, note: "first" }, "planning", 0);
    const afterFirst = db.getProduct(created.id)!;
    assert.equal(afterFirst.productJsonVersion, 1);
    assert.equal((afterFirst.product as { note?: string }).note, "first");

    assert.throws(
      () => db.updateProduct(created.id, { ...created.product, note: "stale" }, "planning", 0),
      /产品内容已变更/,
    );
    assert.equal(db.getProduct(created.id)!.productJsonVersion, 1);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("ProductMutationService 按读到的版本提交，过期 expectedVersion 失败", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-json-version-mut-"));
  const db = new VbkDatabase(dataPath);
  try {
    const created = db.createProduct({ destination: "成都", days: 3, productForm: "privateTour" });
    const mutations = new ProductMutationService(db);
    mutations.replace(created.id, { ...created.product, tag: "a" });
    assert.equal(db.getProduct(created.id)!.productJsonVersion, 1);
    assert.throws(
      () => mutations.replace(created.id, { ...created.product, tag: "b" }, { expectedVersion: 0 }),
      /产品内容已变更/,
    );
    assert.equal((db.getProduct(created.id)!.product as { tag?: string }).tag, "a");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
