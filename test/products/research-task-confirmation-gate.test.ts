import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

function openDb() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-research-gate-"));
  const db = new VbkDatabase(dataPath);
  return {
    db,
    cleanup() { fs.rmSync(dataPath, { recursive: true, force: true }); },
  };
}

test("规划 / 复核阶段仍可新增 research_tasks", () => {
  const { db, cleanup } = openDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    const id = db.addResearchTask(product.id, { label: "核查 晋祠 的 VBK POI 映射", type: "vbk", detail: "待核" });
    assert.ok(id);
    db.updateProduct(product.id, product.product, "review");
    const again = db.addResearchTask(product.id, { label: "获取产品封面图", type: "image", detail: "封面" });
    assert.ok(again);
  } finally {
    cleanup();
  }
});

test("确认后的录入阶段不能再新增 research_tasks", () => {
  const { db, cleanup } = openDb();
  try {
    const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
    db.updateProduct(product.id, product.product, "automating");
    assert.throws(
      () => db.addResearchTask(product.id, { label: "核查酒店资源", type: "vbk", detail: "录入中发现缺失" }),
      /确认后.*research_tasks/,
    );
    db.updateProduct(product.id, product.product, "draft_saved");
    assert.throws(
      () => db.addResearchTask(product.id, { label: "核查用车资源组", type: "vbk", detail: "草稿已保存" }),
      /确认后.*research_tasks/,
    );
  } finally {
    cleanup();
  }
});
