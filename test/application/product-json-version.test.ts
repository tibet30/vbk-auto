import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
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

test("数据库保存保留同ID的不同原名，只合并同名同时间的重复副本", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-poi-dedupe-write-"));
  const db = new VbkDatabase(dataPath);
  try {
    const created = db.createProduct({ destination: "拉萨", days: 1, productForm: "privateTour" });
    db.updateProduct(created.id, {
      ...created.product,
      itinerary: [{
        day: 1,
        spots: [
          { name: "羊卓雍措", poiName: "羊卓雍错", poiId: 82105 },
          { name: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105 },
          { name: "羊卓雍湖", poiName: "羊卓雍错", poiId: 82105 },
        ],
      }],
    }, "planning", created.productJsonVersion);

    const reader = new Database(path.join(dataPath, "vbk-desktop.sqlite"), { readonly: true });
    try {
      const row = reader.prepare("SELECT product_json FROM products WHERE id=?").get(created.id) as { product_json: string };
      const saved = JSON.parse(row.product_json) as { itinerary: Array<{ spots: Array<{ name: string }> }> };
      assert.deepEqual(saved.itinerary[0].spots.map((spot) => spot.name), ["羊卓雍措", "羊卓雍湖"]);
    } finally {
      reader.close();
    }
  } finally {
    db.close();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
